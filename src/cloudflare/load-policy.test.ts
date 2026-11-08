import { assert, assertEquals, assertRejects } from "@std/assert";
import { createCloudflareWorldsSdk } from "./create-cloudflare-sdk.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";

const POLICY_ERROR = /not permitted by policy|blocked address|requires https/;

const REMOTE_LOADS = [
  "LOAD <https://example.invalid/data.ttl> INTO GRAPH <urn:graph:g>",
  "LOAD <https://127.0.0.1/data.ttl> INTO GRAPH <urn:graph:g>",
  "LOAD <https://169.254.169.254/latest/meta-data> INTO GRAPH <urn:graph:g>",
  "LOAD <https://[::1]/data.ttl> INTO GRAPH <urn:graph:g>",
];

Deno.test("hosted SDK denies remote SPARQL LOAD by default and never fetches", async () => {
  const substrate = await createTestD1();
  const sdk = await createCloudflareWorldsSdk({ database: substrate.database });
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (input: Request | URL | string) => {
    calls.push(String(input));
    return Promise.reject(new Error("unexpected network call"));
  };
  try {
    for (const query of REMOTE_LOADS) {
      const error = await assertRejects(() => sdk.sparql({ query }));
      assert(
        POLICY_ERROR.test((error as Error).message),
        `unexpected error for ${query}: ${(error as Error).message}`,
      );
    }
    assertEquals(calls, []);
  } finally {
    globalThis.fetch = realFetch;
    await substrate.dispose();
  }
});
