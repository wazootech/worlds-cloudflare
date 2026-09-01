import { assertEquals, assertRejects } from "@std/assert";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import {
  assertD1SchemaCompatible,
  checkD1SchemaCompatibility,
} from "./d1-schema-compatibility.ts";
import { D1SchemaBuilder } from "./d1-schema-builder.ts";

Deno.test("D1 schema compatibility accepts the generated schema", async () => {
  const substrate = await createTestD1();
  try {
    const builder = new D1SchemaBuilder(32, { worldUid: "world-a" });
    for (const ddl of builder.buildTables()) {
      await substrate.connection.execute({ sql: ddl });
    }
    const report = await checkD1SchemaCompatibility(substrate.connection, {
      worldUid: "world-a",
    });
    assertEquals(report, { compatible: true, issues: [] });
    await assertD1SchemaCompatible(substrate.connection, {
      worldUid: "world-a",
    });
  } finally {
    await substrate.dispose();
  }
});

Deno.test("D1 schema compatibility reports missing tables and columns", async () => {
  const substrate = await createTestD1();
  try {
    const report = await checkD1SchemaCompatibility(substrate.connection);
    assertEquals(report.compatible, false);
    assertEquals(
      report.issues.some((issue) => issue.detail === "missing table"),
      true,
    );

    await substrate.connection.execute({
      sql: "CREATE TABLE quads (id TEXT PRIMARY KEY)",
    });
    const partial = await checkD1SchemaCompatibility(substrate.connection, {
      worldUid: "world-a",
    });
    assertEquals(
      partial.issues.some((issue) => issue.detail === "missing column s"),
      true,
    );
    assertEquals(
      partial.issues.some((issue) =>
        issue.detail === "missing column world_uid"
      ),
      true,
    );
    await assertRejects(
      () =>
        assertD1SchemaCompatible(substrate.connection, { worldUid: "world-a" }),
      Error,
      "quads: missing column",
    );
  } finally {
    await substrate.dispose();
  }
});

Deno.test("D1 schema compatibility works through a fresh driver", async () => {
  const substrate = await createTestD1();
  try {
    const driver = new D1ConnectionDriver(substrate.database);
    const result = await driver.execute<{ name: string }>({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table'",
    });
    assertEquals(result.rows.length, 0);
  } finally {
    await substrate.dispose();
  }
});
