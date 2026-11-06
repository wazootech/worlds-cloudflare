import { createCloudflareWorldsSdk } from "@/cloudflare/create-cloudflare-sdk.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import type { TestD1 } from "@/cloudflare/d1-test-substrate.ts";
import type { InferenceOptions } from "@/cloudflare/d1-client-base-options.ts";

export const PREFIX = `PREFIX ex: <http://example.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
`;
export const DERIVED_GRAPH = "https://wazoo.dev/ns/reasoner#derived";

export async function setup(inference?: InferenceOptions, worldId?: string) {
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

export const on: InferenceOptions = { enabled: true };

export async function withWorld(
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

export const TYPE = "type";
