import { assertEquals, assertRejects } from "@std/assert";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { D1SchemaBuilder } from "./d1-schema-builder.ts";
import { checkD1SchemaCompatibility } from "./d1-schema-compatibility.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import {
  buildBulkInsertQuads,
  buildDeleteDerivedQuadsByQuadIds,
  buildSelectExistingQuadIds,
  type InsertQuadRow,
} from "@/cloudflare/quad-store/d1-quad-query-builder.ts";

const MIGRATION = new URL(
  "../../../migrations/0001-quads-derived-column.sql",
  import.meta.url,
);

function row(id: string, derived?: 0 | 1): InsertQuadRow {
  return {
    quad_id: id,
    s: `urn:s:${id}`,
    s_type: "NamedNode",
    p: "urn:p",
    o: "urn:o",
    o_type: "NamedNode",
    g: "",
    g_type: "DefaultGraph",
    ...(derived === undefined ? {} : { derived }),
  };
}

Deno.test("fresh quads table has derived defaulting to 0 and passes the derived check", async () => {
  const substrate = await createTestD1();
  try {
    const store = new D1RdfjsStore({
      connection: substrate.connection,
      requireDerivedColumn: true,
    });
    await store.ensureSchema();
    const report = await checkD1SchemaCompatibility(substrate.connection, {
      requireDerivedColumn: true,
    });
    assertEquals(report.compatible, true);
    for (const statement of buildBulkInsertQuads([row("a")])) {
      await substrate.connection.execute(statement);
    }
    const stored = await substrate.connection.execute<{ derived: number }>({
      sql: "SELECT derived FROM quads WHERE quad_id = 'a'",
    });
    assertEquals(Number(stored.rows[0]?.derived), 0);
  } finally {
    await substrate.dispose();
  }
});

Deno.test("a pre-derived database fails the derived check until the migration runs", async () => {
  const substrate = await createTestD1();
  try {
    // The canonical DDL as it was before this column existed.
    const legacyQuads = new D1SchemaBuilder(32).buildD1QuadsTable().replace(
      ", derived INTEGER NOT NULL DEFAULT 0",
      "",
    );
    await substrate.connection.execute({ sql: legacyQuads });
    await substrate.connection.execute({
      sql: "INSERT INTO quads (quad_id, s, s_type, p, o, o_type, g, g_type) " +
        "VALUES ('old', 's', 'NamedNode', 'p', 'o', 'NamedNode', '', 'DefaultGraph')",
    });

    const before = await checkD1SchemaCompatibility(substrate.connection, {
      requireDerivedColumn: true,
    });
    assertEquals(
      before.issues.some((issue) => issue.detail === "missing column derived"),
      true,
    );
    // Without opting in, the missing column is not reported.
    const optedOut = await checkD1SchemaCompatibility(substrate.connection);
    assertEquals(
      optedOut.issues.some((issue) => issue.detail.includes("derived")),
      false,
    );

    const sql = (await Deno.readTextFile(MIGRATION)).split("\n")
      .filter((line) => !line.startsWith("--")).join("\n").trim();
    await substrate.connection.execute({ sql });

    const after = await checkD1SchemaCompatibility(substrate.connection, {
      requireDerivedColumn: true,
    });
    assertEquals(
      after.issues.some((issue) => issue.detail.includes("derived")),
      false,
    );
    const migrated = await substrate.connection.execute<{ derived: number }>({
      sql: "SELECT derived FROM quads WHERE quad_id = 'old'",
    });
    assertEquals(Number(migrated.rows[0]?.derived), 0);

    await assertRejects(() => substrate.connection.execute({ sql }));
  } finally {
    await substrate.dispose();
  }
});

Deno.test("inferred rows never overwrite or delete asserted rows", async () => {
  const substrate = await createTestD1();
  try {
    await new D1RdfjsStore({ connection: substrate.connection })
      .ensureSchema();
    const run = async (
      statements: Array<{ sql: string; args?: unknown[] }>,
    ) => {
      for (const statement of statements) {
        await substrate.connection.execute(statement);
      }
    };
    await run(buildBulkInsertQuads([row("asserted", 0)]));
    // Same id as inferred: OR IGNORE keeps the asserted row asserted.
    await run(
      buildBulkInsertQuads([row("asserted", 1), row("inferred", 1)], {
        orIgnore: true,
      }),
    );
    // Deleting both ids as derived only removes the inferred one.
    await run([buildDeleteDerivedQuadsByQuadIds(["asserted", "inferred"])]);
    const left = await substrate.connection.execute<
      { quad_id: string; derived: number }
    >({ sql: "SELECT quad_id, derived FROM quads ORDER BY quad_id" });
    assertEquals(left.rows.map((r) => [r.quad_id, Number(r.derived)]), [
      ["asserted", 0],
    ]);

    // Replacing an inferred row with an asserted one promotes it.
    await run(buildBulkInsertQuads([row("promoted", 1)]));
    await run(buildBulkInsertQuads([row("promoted", 0)]));
    const promoted = await substrate.connection.execute<{ derived: number }>({
      sql: "SELECT derived FROM quads WHERE quad_id = 'promoted'",
    });
    assertEquals(Number(promoted.rows[0]?.derived), 0);

    // assertedOnly existence ignores inferred rows.
    await run(buildBulkInsertQuads([row("inf2", 1)]));
    const existing = await substrate.connection.execute<{ id: string }>(
      buildSelectExistingQuadIds(["asserted", "inf2"], undefined, {
        assertedOnly: true,
      }),
    );
    assertEquals(existing.rows.map((r) => r.id), ["asserted"]);
  } finally {
    await substrate.dispose();
  }
});
