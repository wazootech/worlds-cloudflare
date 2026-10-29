import { assertEquals, assertRejects } from "@std/assert";
import { createCloudflareWorldsSdk } from "@/cloudflare/create-cloudflare-sdk.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { D1SchemaBuilder } from "@/cloudflare/schema/d1-schema-builder.ts";
import { backfillInference } from "@/cloudflare/inference/backfill-inference.ts";
import { InferenceSizeGuardError } from "@/cloudflare/inference/load-asserted-quads.ts";
import { PREFIX } from "./inference-commit-test-helpers.ts";

Deno.test("backfillInference materializes inference for data written with it off", async () => {
  const substrate = await createTestD1();
  try {
    const open = (worldId: string) =>
      createCloudflareWorldsSdk({
        database: substrate.database,
        worldId,
        searchIndexOnImport: "disabled",
      });
    const sdkA = await open("world-a");
    const sdkB = await open("world-b");
    const data =
      `INSERT DATA { ex:Dog rdfs:subClassOf ex:Animal . ex:rex a ex:Dog . }`;
    await sdkA.sparql({ query: `${PREFIX}${data}` });
    await sdkB.sparql({ query: `${PREFIX}${data}` });

    const derivedIn = async (worldId: string) =>
      Number(
        (await substrate.connection.execute<{ n: number }>({
          sql:
            "SELECT COUNT(*) AS n FROM quads WHERE derived = 1 AND world_id = ?",
          args: [worldId],
        })).rows[0]!.n,
      );
    assertEquals(await derivedIn("world-a"), 0);

    const report = await backfillInference({
      database: substrate.database,
      worldId: "world-a",
    });
    assertEquals(report.assertedQuads, 2);
    assertEquals(report.derivedRemoved, 0);
    assertEquals(report.derivedWritten, 1);
    assertEquals(await derivedIn("world-a"), 1);
    // The other world and the asserted rows are untouched.
    assertEquals(await derivedIn("world-b"), 0);
    const asserted = await substrate.connection.execute<{ n: number }>({
      sql: "SELECT COUNT(*) AS n FROM quads WHERE derived = 0",
    });
    assertEquals(Number(asserted.rows[0]!.n), 4);

    // Idempotent: a second run clears and rewrites the same inferred rows.
    const again = await backfillInference({
      database: substrate.database,
      worldId: "world-a",
    });
    assertEquals(again.derivedRemoved, 1);
    assertEquals(again.derivedWritten, 1);

    // Reads see the inference.
    const ask = await sdkA.sparql({
      query: `${PREFIX}ASK { ex:rex a ex:Animal }`,
    });
    assertEquals(ask.kind === "ask" && ask.data.boolean, true);
  } finally {
    await substrate.dispose();
  }
});

Deno.test("backfillInference honors the size guard before writing", async () => {
  const substrate = await createTestD1();
  try {
    const sdk = await createCloudflareWorldsSdk({
      database: substrate.database,
      worldId: "world-a",
      searchIndexOnImport: "disabled",
    });
    await sdk.sparql({
      query:
        `${PREFIX}INSERT DATA { ex:a rdfs:subClassOf ex:b . ex:b rdfs:subClassOf ex:c . }`,
    });
    await assertRejects(
      () =>
        backfillInference({
          database: substrate.database,
          worldId: "world-a",
          inference: { maxAssertedQuads: 1 },
        }),
      InferenceSizeGuardError,
    );
    const rows = await substrate.connection.execute<{ n: number }>({
      sql: "SELECT COUNT(*) AS n FROM quads WHERE derived = 1",
    });
    assertEquals(Number(rows.rows[0]!.n), 0);
  } finally {
    await substrate.dispose();
  }
});

Deno.test("backfillInference fails closed without quads.derived", async () => {
  const substrate = await createTestD1();
  try {
    const legacy = new D1SchemaBuilder(32).buildD1QuadsTable().replace(
      ", derived INTEGER NOT NULL DEFAULT 0",
      "",
    );
    await substrate.connection.execute({ sql: legacy });
    await assertRejects(
      () => backfillInference({ database: substrate.database }),
      Error,
      "derived",
    );
  } finally {
    await substrate.dispose();
  }
});
