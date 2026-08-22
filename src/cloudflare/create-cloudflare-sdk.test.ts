import { assertEquals } from "@std/assert";
import { createCloudflareWorldsSdk } from "./create-cloudflare-sdk.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import type { WorldsSdkInterface } from "@worlds/sdk";

const NQUADS = "application/n-quads";

async function createTestWorldsSdk(): Promise<
  { sdk: WorldsSdkInterface; dispose(): Promise<void> }
> {
  const substrate = await createTestD1();
  const sdk = await createCloudflareWorldsSdk({ database: substrate.database });
  return { sdk, dispose: substrate.dispose };
}

Deno.test("createCloudflareWorldsSdk - import/export round-trips quads", async () => {
  const { sdk, dispose } = await createTestWorldsSdk();
  try {
    await sdk.import({
      mode: "replace",
      source: {
        kind: "serialized",
        data: "<urn:ethan> <urn:knows> <urn:gregory> .\n",
        contentType: NQUADS,
      },
    });

    const exported = await sdk.export({
      format: { kind: "serialized", contentType: NQUADS },
    });
    if (exported.kind !== "serialized") {
      throw new Error("export did not return serialized data");
    }

    assertEquals(exported.data.includes("urn:ethan"), true);
  } finally {
    await dispose();
  }
});

Deno.test("createCloudflareWorldsSdk - SPARQL query resolves stored facts", async () => {
  const { sdk, dispose } = await createTestWorldsSdk();
  try {
    await sdk.import({
      source: {
        kind: "serialized",
        data: '<urn:ethan> <urn:name> "Ethan" .\n',
        contentType: NQUADS,
      },
    });

    const response = await sdk.sparql({
      query: `PREFIX urn: <urn:>
      SELECT ?s WHERE { ?s urn:name "Ethan" }`,
    });
    if (response.kind !== "select") {
      throw new Error("expected a SELECT response");
    }

    const bindings = response.data.results.bindings;
    assertEquals(bindings.length, 1);
    assertEquals(bindings[0].s.value, "urn:ethan");
  } finally {
    await dispose();
  }
});

Deno.test("createCloudflareWorldsSdk - keyword search over imported literals", async () => {
  const { sdk, dispose } = await createTestWorldsSdk();
  try {
    await sdk.import({
      source: {
        kind: "serialized",
        data:
          '<urn:ethan> <urn:knows> "Ethan writes robust retrieval infrastructure" .\n',
        contentType: NQUADS,
      },
    });

    const response = await sdk.search({ query: "Ethan" });
    assertEquals(response.results?.length, 1);
    assertEquals(response.results?.[0].subject, "urn:ethan");
  } finally {
    await dispose();
  }
});

Deno.test("createCloudflareWorldsSdk - SPARQL insert triggers search projection (deferred reindex)", async () => {
  const { sdk, dispose } = await createTestWorldsSdk();
  try {
    await sdk.sparql({
      query: `PREFIX urn: <urn:>
      INSERT DATA { urn:ethan urn:knows "Gregory wrote the D1 layer" . }`,
    });

    const response = await sdk.search({ query: "Gregory" });
    assertEquals(response.results?.length, 1);
  } finally {
    await dispose();
  }
});

Deno.test("createCloudflareWorldsSdk - invalid vectorDimensions throws", async () => {
  const substrate = await createTestD1();
  try {
    await createCloudflareWorldsSdk({
      database: substrate.database,
      vectorDimensions: 0,
    });
    throw new Error(
      "expected createCloudflareWorldsSdk to reject vectorDimensions 0",
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
