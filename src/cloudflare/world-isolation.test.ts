import { assert, assertEquals } from "@std/assert";
import { DataFactory } from "@wazoo/sparql-engine";
import { createCloudflareWorldsSdk } from "./create-cloudflare-sdk.ts";
import { createTestD1 } from "./d1-test-substrate.ts";

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
