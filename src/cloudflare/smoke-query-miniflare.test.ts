import assert from "node:assert/strict";
import test from "node:test";
import { createCloudflareWorldsSdk } from "@/cloudflare/create-cloudflare-sdk.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";

test("Miniflare D1 - smoke SPARQL prefix and semicolon INSERT round trips", async () => {
  const substrate = await createTestD1();
  try {
    const sdk = await createCloudflareWorldsSdk({
      database: substrate.database,
      searchIndexOnImport: "disabled",
    });

    const insert = await sdk.sparql({
      query: `PREFIX ex: <http://example.org/>
INSERT DATA {
  ex:Alice ex:name "Alice" ;
           ex:age "30" ;
           ex:city "Portland" .
}`,
    });
    assert.deepStrictEqual(insert.kind, "void");

    const select = await sdk.sparql({
      query: `PREFIX ex: <http://example.org/>
SELECT ?name ?age ?city WHERE {
  ex:Alice ex:name ?name ;
           ex:age ?age ;
           ex:city ?city .
}`,
    });
    assert.deepStrictEqual(select.kind, "select");
    if (select.kind !== "select") throw new Error("expected SELECT response");
    const bindings = select.data.results.bindings;
    assert.deepStrictEqual(bindings.length, 1);
    assert.deepStrictEqual(bindings[0].name.value, "Alice");
    assert.deepStrictEqual(bindings[0].age.value, "30");
    assert.deepStrictEqual(bindings[0].city.value, "Portland");
  } finally {
    await substrate.dispose();
  }
});
