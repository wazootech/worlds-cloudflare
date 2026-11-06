import { assertEquals, assertRejects } from "@std/assert";
import { createCloudflareWorldsSdk } from "@/cloudflare/create-cloudflare-sdk.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import type { InferenceOptions } from "@/cloudflare/d1-client-base-options.ts";
import { D1SchemaBuilder } from "@/cloudflare/schema/d1-schema-builder.ts";
import { on, PREFIX, withWorld } from "./inference-commit-test-helpers.ts";

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
