import { assertEquals, assertRejects } from "@std/assert";
import { createCloudflareWorldsSdk } from "@/cloudflare/create-cloudflare-sdk.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import type { TestD1 } from "@/cloudflare/d1-test-substrate.ts";
import type { InferenceOptions } from "@/cloudflare/d1-client-base-options.ts";
import { D1SchemaBuilder } from "@/cloudflare/schema/d1-schema-builder.ts";
import { backfillInference } from "@/cloudflare/inference/backfill-inference.ts";
import { InferenceSizeGuardError } from "@/cloudflare/inference/load-asserted-quads.ts";

const PREFIX = `PREFIX ex: <http://example.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
`;
const DERIVED_GRAPH = "https://wazoo.dev/ns/reasoner#derived";

async function setup(inference?: InferenceOptions, worldId?: string) {
  const substrate = await createTestD1();
  const sdk = await createCloudflareWorldsSdk({
    database: substrate.database,
    searchIndexOnImport: "disabled",
    worldId,
    ...(inference && { inference }),
  });
  const update = async (body: string) => {
    await sdk.sparql({ query: `${PREFIX}${body}` });
  };
  const rows = async () => {
    const result = await substrate.connection.execute<
      { s: string; p: string; o: string; g: string; derived: number }
    >({
      sql: "SELECT s, p, o, g, derived FROM quads ORDER BY s, p, o, g",
    });
    return result.rows.map((r) => [
      r.s.replace("http://example.org/", "ex:"),
      r.p.split(/[#/]/).pop(),
      r.o.replace("http://example.org/", "ex:"),
      r.g,
      Number(r.derived),
    ]);
  };
  return { substrate, sdk, update, rows };
}

const on: InferenceOptions = { enabled: true };

async function withWorld(
  inference: InferenceOptions | undefined,
  run: (
    w: Awaited<ReturnType<typeof setup>>,
    substrate: TestD1,
  ) => Promise<void>,
) {
  const world = await setup(inference);
  try {
    await run(world, world.substrate);
  } finally {
    await world.substrate.dispose();
  }
}

const TYPE = "type";

Deno.test("inference is off by default: nothing is derived", async () => {
  await withWorld(undefined, async ({ update, rows }) => {
    await update(
      `INSERT DATA { ex:Dog rdfs:subClassOf ex:Animal . ex:rex a ex:Dog . }`,
    );
    const all = await rows();
    assertEquals(all.length, 2);
    assertEquals(all.every((r) => r[4] === 0), true);
  });
});

Deno.test("enabled: insertions write derived rows that SPARQL can see", async () => {
  await withWorld(on, async ({ sdk, update, rows }) => {
    await update(
      `INSERT DATA { ex:Dog rdfs:subClassOf ex:Animal . ex:rex a ex:Dog . }`,
    );
    const derived = (await rows()).filter((r) => r[4] === 1);
    assertEquals(
      derived.some((r) =>
        r[0] === "ex:rex" && r[1] === TYPE && r[2] === "ex:Animal"
      ),
      true,
    );
    const ask = await sdk.sparql({
      query: `${PREFIX}ASK { ex:rex a ex:Animal }`,
    });
    assertEquals(ask.kind, "ask");
    if (ask.kind === "ask") assertEquals(ask.data.boolean, true);
  });
});

Deno.test("enabled: deleting the premise removes the derived rows, never asserted ones", async () => {
  await withWorld(on, async ({ update, rows }) => {
    await update(
      `INSERT DATA { ex:Dog rdfs:subClassOf ex:Animal . ex:rex a ex:Dog . ex:fido a ex:Dog . }`,
    );
    await update(`DELETE DATA { ex:rex a ex:Dog . }`);
    const all = await rows();
    assertEquals(
      all.some((r) => r[0] === "ex:rex"),
      false,
      "rex and its inferences are gone",
    );
    assertEquals(
      all.some((r) => r[0] === "ex:fido" && r[2] === "ex:Animal" && r[4] === 1),
      true,
    );
    assertEquals(
      all.filter((r) => r[4] === 0).map((r) => r[0]).sort(),
      ["ex:Dog", "ex:fido"],
    );
  });
});

Deno.test("enabled: a quad that is asserted and derived stays asserted", async () => {
  await withWorld(on, async ({ update, rows }) => {
    await update(
      `INSERT DATA { ex:Dog rdfs:subClassOf ex:Animal . ex:rex a ex:Dog . }`,
    );
    // Asserting what was derived promotes the row.
    await update(`INSERT DATA { ex:rex a ex:Animal . }`);
    const find = async () =>
      (await rows()).filter((r) => r[0] === "ex:rex" && r[2] === "ex:Animal");
    assertEquals((await find()).map((r) => r[4]), [0]);

    // Removing the premise must not remove the asserted quad.
    await update(`DELETE DATA { ex:rex a ex:Dog . }`);
    assertEquals((await find()).map((r) => r[4]), [0]);
  });
});

Deno.test("enabled: retracting an asserted quad that is still derivable keeps it as derived", async () => {
  await withWorld(on, async ({ update, rows }) => {
    await update(
      `INSERT DATA {
        ex:Dog rdfs:subClassOf ex:Animal .
        ex:rex a ex:Dog .
        ex:rex a ex:Animal .
      }`,
    );
    await update(`DELETE DATA { ex:rex a ex:Animal . }`);
    const kept = (await rows()).filter((r) =>
      r[0] === "ex:rex" && r[2] === "ex:Animal"
    );
    assertEquals(kept.map((r) => r[4]), [1]);
  });
});

Deno.test("enabled: deleting a derived-only quad leaves it in place", async () => {
  await withWorld(on, async ({ update, rows }) => {
    await update(
      `INSERT DATA { ex:Dog rdfs:subClassOf ex:Animal . ex:rex a ex:Dog . }`,
    );
    await update(`DELETE DATA { ex:rex a ex:Animal . }`);
    const kept = (await rows()).filter((r) =>
      r[0] === "ex:rex" && r[2] === "ex:Animal"
    );
    assertEquals(kept.map((r) => r[4]), [1]);
  });
});

Deno.test("enabled, per-graph: a cross-graph entailment is listed in the derived graph", async () => {
  await withWorld(on, async ({ update, rows }) => {
    await update(
      `INSERT DATA {
        GRAPH ex:schema { ex:Dog rdfs:subClassOf ex:Animal . }
        GRAPH ex:data { ex:rex a ex:Dog . }
      }`,
    );
    const derived = (await rows()).filter((r) => r[4] === 1);
    assertEquals(
      derived.some((r) =>
        r[0] === "ex:rex" && r[2] === "ex:Animal" && r[3] === DERIVED_GRAPH
      ),
      true,
    );
  });
});

Deno.test("enabled, union: the entailment is listed in the default graph", async () => {
  await withWorld(
    { enabled: true, graphs: "union" },
    async ({ update, rows }) => {
      await update(
        `INSERT DATA {
        GRAPH ex:schema { ex:Dog rdfs:subClassOf ex:Animal . }
        GRAPH ex:data { ex:rex a ex:Dog . }
      }`,
      );
      const derived = (await rows()).filter((r) => r[4] === 1);
      assertEquals(
        derived.some((r) =>
          r[0] === "ex:rex" && r[2] === "ex:Animal" && r[3] === ""
        ),
        true,
      );
    },
  );
});

Deno.test("size guard fails the commit before any write", async () => {
  await withWorld(
    { enabled: true, maxAssertedQuads: 2 },
    async ({ sdk, update, rows }) => {
      await update(`INSERT DATA { ex:a ex:p ex:b . ex:c ex:p ex:d . }`);
      assertEquals((await rows()).length, 2);
      await assertRejects(
        () =>
          sdk.sparql({ query: `${PREFIX}INSERT DATA { ex:e ex:p ex:f . }` }),
        Error,
        "inference size guard",
      );
      assertEquals((await rows()).length, 2);
    },
  );
});

Deno.test("worldId-scoped worlds infer independently", async () => {
  const substrate = await createTestD1();
  try {
    const make = (worldId: string, inference?: InferenceOptions) =>
      createCloudflareWorldsSdk({
        database: substrate.database,
        searchIndexOnImport: "disabled",
        worldId,
        ...(inference && { inference }),
      });
    const a = await make("a", on);
    const b = await make("b");
    // quad_id is content-addressed and the primary key, so the two worlds
    // use different quads (a pre-existing property of the shared table).
    const insert = (name: string) =>
      `${PREFIX}INSERT DATA { ex:Dog${name} rdfs:subClassOf ex:Animal${name} . ex:rex${name} a ex:Dog${name} . }`;
    await a.sparql({ query: insert("A") });
    await b.sparql({ query: insert("B") });
    const counts = await substrate.connection.execute<
      { world_id: string; derived: number; n: number }
    >({
      sql:
        "SELECT world_id, derived, COUNT(*) AS n FROM quads GROUP BY world_id, derived ORDER BY world_id, derived",
    });
    const byKey = Object.fromEntries(
      counts.rows.map((r) => [`${r.world_id}:${r.derived}`, Number(r.n)]),
    );
    assertEquals(byKey["b:0"], 2);
    assertEquals(byKey["b:1"], undefined);
    assertEquals(byKey["a:0"], 2);
    assertEquals((byKey["a:1"] ?? 0) > 0, true);
  } finally {
    await substrate.dispose();
  }
});

Deno.test("enabling inference on a database without quads.derived fails closed", async () => {
  const substrate = await createTestD1();
  try {
    const legacy = new D1SchemaBuilder(32).buildD1QuadsTable().replace(
      ", derived INTEGER NOT NULL DEFAULT 0",
      "",
    );
    await substrate.connection.execute({ sql: legacy });
    await assertRejects(
      () =>
        createCloudflareWorldsSdk({
          database: substrate.database,
          inference: on,
        }),
      Error,
      "derived",
    );
  } finally {
    await substrate.dispose();
  }
});

Deno.test("enabled: reindex skips inferred rows", async () => {
  await withWorld(on, async ({ sdk, update }) => {
    await update(
      `INSERT DATA { ex:Dog rdfs:subClassOf ex:Animal . ex:rex a ex:Dog ; rdfs:label "Rex the dog" . }`,
    );
    const report = await sdk.reindex();
    // Three asserted quads; the inferred `ex:rex a ex:Animal` is not read.
    assertEquals(report.processedQuadCount, 3);
  });
});

Deno.test("world-scoped statements stay within D1's 100 bound-variable cap", async () => {
  const substrate = await createTestD1();
  try {
    let widest = 0;
    const real = new WeakMap<object, unknown>();
    const wrap = (
      statement: ReturnType<typeof substrate.database.prepare>,
    ): ReturnType<typeof substrate.database.prepare> => {
      const wrapped = {
        bind(...values: unknown[]) {
          widest = Math.max(widest, values.length);
          return wrap(statement.bind(...values));
        },
        all: () => statement.all(),
        first: () => statement.first(),
        run: () => statement.run(),
      };
      real.set(wrapped, statement);
      return wrapped as never;
    };
    const database = {
      prepare: (sql: string) => wrap(substrate.database.prepare(sql)),
      batch: (statements: unknown[]) =>
        substrate.database.batch(
          statements.map((s) => real.get(s as object)) as never,
        ),
      exec: (sql: string) => substrate.database.exec(sql),
    };
    const sdk = await createCloudflareWorldsSdk({
      database: database as unknown as typeof substrate.database,
      searchIndexOnImport: "disabled",
      worldId: "w1",
      inference: on,
    });
    const link = (i: number) => `ex:C${i} rdfs:subClassOf ex:C${i + 1} .`;
    const chain = Array.from({ length: 30 }, (_, i) => link(i)).join(" ");
    await sdk.sparql({ query: `${PREFIX}INSERT DATA { ${chain} }` });
    // Cutting the middle link retracts well over 100 derived quads at once.
    await sdk.sparql({ query: `${PREFIX}DELETE DATA { ${link(15)} }` });
    const left = await substrate.connection.execute<{ n: number }>({
      sql: "SELECT COUNT(*) AS n FROM quads WHERE derived = 1",
    });
    assertEquals(Number(left.rows[0]!.n), 196);
    assertEquals(widest <= 100, true, `widest statement bound ${widest}`);
  } finally {
    await substrate.dispose();
  }
});

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
