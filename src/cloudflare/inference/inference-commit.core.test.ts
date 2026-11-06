import { assertEquals } from "@std/assert";
import {
  DERIVED_GRAPH,
  on,
  PREFIX,
  TYPE,
  withWorld,
} from "./inference-commit-test-helpers.ts";

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
