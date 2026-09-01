import { assertEquals } from "@std/assert";
import { createCloudflareWorldsSdk } from "@/cloudflare/create-cloudflare-sdk.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";

Deno.test("Miniflare D1 - smoke SPARQL prefix and semicolon INSERT round trips", async () => {
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
    assertEquals(insert.kind, "void");

    const select = await sdk.sparql({
      query: `PREFIX ex: <http://example.org/>
SELECT ?name ?age ?city WHERE {
  ex:Alice ex:name ?name ;
           ex:age ?age ;
           ex:city ?city .
}`,
    });
    assertEquals(select.kind, "select");
    if (select.kind !== "select") throw new Error("expected SELECT response");
    const bindings = select.data.results.bindings;
    assertEquals(bindings.length, 1);
    assertEquals(bindings[0].name.value, "Alice");
    assertEquals(bindings[0].age.value, "30");
    assertEquals(bindings[0].city.value, "Portland");
  } finally {
    await substrate.dispose();
  }
});
