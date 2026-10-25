import { assert, assertEquals } from "@std/assert";
import { DataFactory } from "@wazoo/sparql-engine";
import { createCloudflareWorldsSdk } from "./create-cloudflare-sdk.ts";
import { createTestD1 } from "./d1-test-substrate.ts";
import { D1SchemaBuilder } from "./schema/d1-schema-builder.ts";

const NQUADS = "application/n-quads";
const worldA = "world-a";
const worldB = "world-b";

const source = (value: string) => `<urn:alice> <urn:name> "${value}" .\n`;

Deno.test("worldId isolates select, delete, update, import, reindex, and search", async () => {
  const substrate = await createTestD1();
  try {
    const sdkA = await createCloudflareWorldsSdk({
      database: substrate.database,
      worldId: worldA,
    });
    const sdkB = await createCloudflareWorldsSdk({
      database: substrate.database,
      worldId: worldB,
    });

    await sdkA.import({
      mode: "replace",
      source: { kind: "serialized", data: source("A"), contentType: NQUADS },
    });
    await sdkB.import({
      mode: "replace",
      source: { kind: "serialized", data: source("B"), contentType: NQUADS },
    });

    const select = async (sdk: typeof sdkA) => {
      const response = await sdk.sparql({
        query: "SELECT ?name WHERE { <urn:alice> <urn:name> ?name }",
      });
      assertEquals(response.kind, "select");
      return response.kind === "select"
        ? response.data.results.bindings.map((binding) => binding.name.value)
        : [];
    };
    assertEquals(await select(sdkA), ["A"]);
    assertEquals(await select(sdkB), ["B"]);

    assertEquals((await sdkA.search({ query: "A" })).results?.length, 1);
    assertEquals((await sdkA.search({ query: "B" })).results?.length, 0);
    assertEquals((await sdkB.search({ query: "B" })).results?.length, 1);
    assertEquals((await sdkB.search({ query: "A" })).results?.length, 0);

    await sdkA.sparql({
      query: 'DELETE WHERE { <urn:alice> <urn:name> "A" }',
    });
    assertEquals(await select(sdkA), []);
    assertEquals(await select(sdkB), ["B"]);

    await sdkA.sparql({
      query: 'INSERT DATA { <urn:alice> <urn:name> "A2" }',
    });
    assertEquals(await select(sdkA), ["A2"]);
    assertEquals(await select(sdkB), ["B"]);

    await sdkA.reindex({});
    assertEquals((await sdkA.search({ query: "A2" })).results?.length, 1);
    assertEquals((await sdkA.search({ query: "B" })).results?.length, 0);
    assertEquals((await sdkB.search({ query: "B" })).results?.length, 1);
  } finally {
    await substrate.dispose();
  }
});

Deno.test("worldId serializes concurrent writes without cross-world leakage", async () => {
  const substrate = await createTestD1();
  try {
    const sdkA = await createCloudflareWorldsSdk({
      database: substrate.database,
      worldId: worldA,
    });
    const sdkB = await createCloudflareWorldsSdk({
      database: substrate.database,
      worldId: worldB,
    });

    await Promise.all([
      sdkA.import({
        mode: "replace",
        source: {
          kind: "serialized",
          data: source("A-concurrent"),
          contentType: NQUADS,
        },
      }),
      sdkB.import({
        mode: "replace",
        source: {
          kind: "serialized",
          data: source("B-concurrent"),
          contentType: NQUADS,
        },
      }),
    ]);

    const count = async (sdk: typeof sdkA) => {
      const response = await sdk.sparql({
        query: "SELECT ?s WHERE { ?s <urn:name> ?name }",
      });
      assert(response.kind === "select");
      return response.data.results.bindings.length;
    };
    assertEquals(await count(sdkA), 1);
    assertEquals(await count(sdkB), 1);

    const raw = await substrate.database.prepare(
      "SELECT world_id, COUNT(*) AS count FROM quads GROUP BY world_id ORDER BY world_id",
    ).all<{ world_id: string; count: number }>();
    assertEquals(raw.results.map((row) => [row.world_id, Number(row.count)]), [
      [worldA, 1],
      [worldB, 1],
    ]);
  } finally {
    await substrate.dispose();
  }
});

void DataFactory;

Deno.test("worlds holding the identical triples keep their own rows (#60)", async () => {
  const substrate = await createTestD1();
  try {
    const open = (worldId: string) =>
      createCloudflareWorldsSdk({
        database: substrate.database,
        worldId,
        searchIndexOnImport: "disabled",
        inference: { enabled: true },
      });
    const sdkA = await open(worldA);
    const sdkB = await open(worldB);
    const insert = `INSERT DATA {
      <urn:x> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <urn:y> .
      <urn:y> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <urn:z> .
    }`;
    const count = async (sdk: typeof sdkA) => {
      const response = await sdk.sparql({
        query: "SELECT * WHERE { ?s ?p ?o }",
      });
      return response.kind === "select"
        ? response.data.results.bindings.length
        : -1;
    };

    await sdkA.sparql({ query: insert });
    await sdkB.sparql({ query: insert });
    // Two asserted triples plus the one subClassOf inference, in each world.
    assertEquals(await count(sdkA), 3);
    assertEquals(await count(sdkB), 3);

    await sdkA.sparql({
      query:
        "DELETE DATA { <urn:y> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <urn:z> }",
    });
    assertEquals(await count(sdkA), 1);
    assertEquals(await count(sdkB), 3);
  } finally {
    await substrate.dispose();
  }
});

Deno.test("0002 rebuilds a legacy quads table with a world-scoped key and keeps its rows", async () => {
  const substrate = await createTestD1();
  try {
    const modern = new D1SchemaBuilder(32, { worldId: worldA });
    const legacy = modern.buildD1QuadsTable()
      .replace("quad_id TEXT,", "quad_id TEXT PRIMARY KEY,")
      .replace(", PRIMARY KEY (world_id, quad_id)", "");
    // Create the full current schema, then swap quads for its legacy shape.
    await createCloudflareWorldsSdk({
      database: substrate.database,
      worldId: worldA,
    });
    await substrate.connection.execute({ sql: "DROP TABLE quads" });
    await substrate.connection.execute({ sql: legacy });
    await substrate.connection.execute({
      sql:
        "INSERT INTO quads (quad_id, s, s_type, p, o, o_type, g, g_type, world_id) VALUES ('q1','urn:s','NamedNode','urn:p','urn:o','NamedNode','','DefaultGraph','world-a')",
    });

    // A Worker deployed before the migration still starts on the legacy key.
    await createCloudflareWorldsSdk({
      database: substrate.database,
      worldId: worldA,
    });

    const migration = await Deno.readTextFile(
      new URL(
        "../../migrations/0002-quads-world-scoped-key.sql",
        import.meta.url,
      ),
    );
    const statements = migration.split("\n").filter((line) =>
      !line.startsWith("--")
    ).join("\n").split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
    for (const sql of statements) {
      await substrate.connection.execute({ sql });
    }

    const columns = await substrate.connection.execute<
      { name: string; pk: number }
    >({ sql: "PRAGMA table_info(quads)" });
    assertEquals(
      columns.rows.filter((c) => Number(c.pk) > 0).map((c) => c.name).sort(),
      ["quad_id", "world_id"],
    );
    const rows = await substrate.connection.execute<{ n: number }>({
      sql: "SELECT COUNT(*) AS n FROM quads WHERE world_id = 'world-a'",
    });
    assertEquals(Number(rows.rows[0]!.n), 1);

    // The same quad id may now exist in another world.
    await substrate.connection.execute({
      sql:
        "INSERT INTO quads (quad_id, s, s_type, p, o, o_type, g, g_type, world_id) VALUES ('q1','urn:s','NamedNode','urn:p','urn:o','NamedNode','','DefaultGraph','world-b')",
    });
    await createCloudflareWorldsSdk({
      database: substrate.database,
      worldId: worldB,
    });
  } finally {
    await substrate.dispose();
  }
});
