/**
 * Parity suite for @worlds/cloudflare (workspace#59, #66, #72) — keeps the
 * D1 backend continuously validated against the shared in-memory reference.
 *
 * Runs the shared fixture corpus with reference = createMemoryWorldsSdk (the
 * portable in-memory reference) and candidate = createCloudflareWorldsSdk over a
 * miniflare D1 binding.
 *
 * Exemptions (explicit, documented on workspace#72 — never silent):
 *   - chunkBoundaryWorld is excluded via the harness's fixtures override:
 *     cloudflare chunks literals at 1000 chars (the chunker divergence);
 *     memory has no chunker, so chunk-derived search ids/text cannot be
 *     compared.
 *   - rdfStarWorld reports under its declared gate (D1 cannot store
 *     RDF-star; the fixture can never fail the suite).
 *
 * Search ordering is compared set-wise (strictSearchOrder: false): FTS5
 * ranking vs scan order is an engine detail, not a parity contract.
 */
import { assertEquals } from "@std/assert";
import { createCloudflareWorldsSdk } from "@/cloudflare/mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { createMemoryWorldsSdk } from "@worlds/sdk/memory";
import { parityCorpus, runParitySuite } from "@worlds/sdk/testing";

const CHUNKER_DIVERGENT_FIXTURE = "chunkBoundaryWorld";

const disposers: Array<() => Promise<void>> = [];

async function createCloudflareSdkForParity() {
  const substrate = await createTestD1();
  disposers.push(substrate.dispose);
  return createCloudflareWorldsSdk({ database: substrate.database });
}

Deno.test(
  "parity suite - cloudflare agrees with the in-memory reference on the corpus",
  async () => {
    const fixtures = parityCorpus.fixtures.filter(
      (fixture) => fixture.name !== CHUNKER_DIVERGENT_FIXTURE,
    );

    let report;
    try {
      report = await runParitySuite({
        reference: () => createMemoryWorldsSdk(),
        candidate: () => createCloudflareSdkForParity(),
        fixtures,
        strictSearchOrder: false,
      });
    } finally {
      for (const dispose of disposers.splice(0)) {
        await dispose();
      }
    }

    assertEquals(
      report.results.length,
      fixtures.length + parityCorpus.replaceCases.length,
      "every non-exempted corpus fixture and replace case runs on both",
    );
    assertEquals(
      report.ok,
      true,
      report.results
        .map(
          (r) =>
            `${r.name}: ${r.failures.join("; ")}` +
            `${r.notes ? ` [notes: ${r.notes.join("; ")}]` : ""}`,
        )
        .join("\n"),
    );
  },
);
