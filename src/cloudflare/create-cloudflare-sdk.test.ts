import { assertEquals } from "@std/assert";
import { createCloudflareSdk } from "./create-cloudflare-sdk.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import type { SdkInterface } from "@worlds/sdk";

const NQUADS = "application/n-quads";

async function createTestSdk(): Promise<
  { sdk: SdkInterface; dispose(): Promise<void> }
> {
  const substrate = await createTestD1();
  const sdk = await createCloudflareSdk({ database: substrate.database });
  return { sdk, dispose: substrate.dispose };
}

Deno.test("createCloudflareSdk - import/export round-trips quads", async () => {
  const { sdk, dispose } = await createTestSdk();
  try {
    await sdk.import({
      mode: "replace",
      source: {
        kind: "serialized",
        data: "<urn:alice> <urn:knows> <urn:bob> .\n",
        contentType: NQUADS,
      },
    });

    const exported = await sdk.export({
      format: { kind: "serialized", contentType: NQUADS },
    });
    if (exported.kind !== "serialized") {
      throw new Error("export did not return serialized data");
    }

    assertEquals(exported.data.includes("urn:alice"), true);
  } finally {
    await dispose();
  }
});

Deno.test("createCloudflareSdk - SPARQL query resolves stored facts", async () => {
  const { sdk, dispose } = await createTestSdk();
  try {
    await sdk.import({
      source: {
        kind: "serialized",
        data: '<urn:alice> <urn:name> "Alice" .\n',
        contentType: NQUADS,
      },
    });

    const response = await sdk.sparql({
      query: `PREFIX urn: <urn:>
      SELECT ?s WHERE { ?s urn:name "Alice" }`,
    });
    if (response.kind !== "select") {
      throw new Error("expected a SELECT response");
    }

    const bindings = response.data.results.bindings;
    assertEquals(bindings.length, 1);
    assertEquals(bindings[0].s.value, "urn:alice");
  } finally {
    await dispose();
  }
});

Deno.test("createCloudflareSdk - keyword search over imported literals", async () => {
  const { sdk, dispose } = await createTestSdk();
  try {
    await sdk.import({
      source: {
        kind: "serialized",
        data:
          '<urn:alice> <urn:knows> "Ethan writes robust retrieval infrastructure" .\n',
        contentType: NQUADS,
      },
    });

    const response = await sdk.search({ query: "Ethan" });
    assertEquals(response.results?.length, 1);
    assertEquals(response.results?.[0].subject, "urn:alice");
  } finally {
    await dispose();
  }
});

Deno.test("createCloudflareSdk - SPARQL insert triggers search projection (deferred reindex)", async () => {
  const { sdk, dispose } = await createTestSdk();
  try {
    await sdk.sparql({
      query: `PREFIX urn: <urn:>
      INSERT DATA { urn:alice urn:knows "Gregory wrote the D1 layer" . }`,
    });

    const response = await sdk.search({ query: "Gregory" });
    assertEquals(response.results?.length, 1);
  } finally {
    await dispose();
  }
});

Deno.test("createCloudflareSdk - invalid vectorDimensions throws", async () => {
  const substrate = await createTestD1();
  try {
    await createCloudflareSdk({
      database: substrate.database,
      vectorDimensions: 0,
    });
    throw new Error(
      "expected createCloudflareSdk to reject vectorDimensions 0",
    );
  } catch (error) {
    const message = (error as Error).message;
    assertEquals(
      message.includes("vectorDimensions must be a finite integer"),
      true,
    );
  } finally {
    await substrate.dispose();
  }
});
