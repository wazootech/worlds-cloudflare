import { assertEquals } from "@std/assert";
import { createCloudflareWorldsSdk } from "./create-cloudflare-sdk.ts";
import { createTestD1 } from "./d1-test-substrate.ts";

const NQUADS = "application/n-quads";
const CANDIDATES = 3;

const lines = (count: number, text: (i: number) => string) =>
  Array.from(
    { length: count },
    (_, i) => `<urn:s${i}> <urn:p> "${text(i)}" .\n`,
  ).join("");

Deno.test("one world's dense matches cannot crowd out another world's FTS candidates", async () => {
  const substrate = await createTestD1();
  try {
    const open = (worldId: string) =>
      createCloudflareWorldsSdk({
        database: substrate.database,
        worldId,
        candidateCount: CANDIDATES,
      });
    const victim = await open("victim");
    const noisy = await open("noisy");

    await victim.import({
      mode: "replace",
      source: {
        kind: "serialized",
        data: lines(2, (i) => `a longer note ${i} that mentions zebra once`),
        contentType: NQUADS,
      },
    });
    // Many short, token-dense rows that outrank the victim's under bm25.
    await noisy.import({
      mode: "replace",
      source: {
        kind: "serialized",
        data: lines(CANDIDATES * 4, () => "zebra zebra zebra"),
        contentType: NQUADS,
      },
    });

    const victimHits = await victim.search({ query: "zebra" });
    assertEquals(victimHits.results?.length, 2);
    for (const hit of victimHits.results ?? []) {
      assertEquals(hit.text.includes("longer note"), true);
    }

    const noisyHits = await noisy.search({ query: "zebra" });
    assertEquals(noisyHits.results?.length, CANDIDATES);
  } finally {
    await substrate.dispose();
  }
});
