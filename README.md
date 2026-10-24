# @worlds/cloudflare

Durable backend for the Worlds client
([`@worlds/sdk`](https://jsr.io/@worlds/sdk)) targeting Cloudflare-native
deployments: **D1** first, with optional **Vectorize** (semantic search) and
**Workers AI** (embeddings) integrations.

Part of the Worlds durable-backend family alongside
[`@worlds/libsql`](https://github.com/wazootech/worlds-libsql) and
[`@worlds/postgres`](https://github.com/wazootech/worlds-postgres). The
provider-strategy vocabulary is backend-internal (per the de-escalated seam
decision,
[worlds-sdk-ts#170](https://github.com/wazootech/worlds-sdk-ts/issues/170));
cross-backend interchangeability lives at the `@worlds/sdk` `WorldsSdk` seam.

## Status

Active development. The D1 quad store layer ([`D1RdfjsStore`](#exports) +
`D1SchemaBuilder` + miniflare substrate), the keyword search index
(`CloudflareSearchIndex`, FTS5), the SDK factory (`createCloudflareWorldsSdk`),
and the shared parity suite (against `@worlds/sdk/memory`'s
`createMemoryWorldsSdk`) are implemented and tested. Vectorize (semantic search)
and Workers AI (embeddings) integrations remain planned. The phased plan is
tracked in
[worlds-cloudflare#7](https://github.com/wazootech/worlds-cloudflare/issues/7).

**World scoping with Vectorize.** One Vectorize index is shared by every world,
so `createCloudflareWorldsSdk` requires `worldId` whenever `vectorize` is set
and throws otherwise. Every vector is stored with `world_id` metadata, every
vector query is filtered on it, and vector ids are namespaced per world, so
identical triple text in two worlds never shares a vector
([worlds-cloudflare#41](https://github.com/wazootech/worlds-cloudflare/issues/41)).

**Vector sync is reported, not swallowed.** A failed embedding, vector upsert,
or stale-vector delete never fails an import (D1 is the source of truth and
keyword search keeps serving), but it is logged as a structured `[vector-sync]`
error and counted. `CloudflareSearchIndex.reindex()` returns `vectorSync`
(`attempted`, `upserted`, `failedUpserts`, `embeddingFailures`,
`staleDeleteFailures`, `errors`), and rerunning reindex repairs the drift
([worlds-cloudflare#40](https://github.com/wazootech/worlds-cloudflare/issues/40)).

This package consumes the shared, driver-free SQL plan layer from
[`@worlds/sqlite/sql-core`](https://jsr.io/@worlds/sqlite) — the FTS5
sanitizer/stopwords, `buildChunkFtsValue`, `buildSearchResultId`, the
`chunks_fts` DDL/triggers emitters, filter-clause helpers, and the keyword
branch plan. The D1-specific pieces stay local: the `chunks` table's `F32_BLOB`
vector column reserved for Vectorize sync, the blob-bind chunk insert, and the
empty-query fallback statement.

## D1 schema rollout

The D1 store creates its canonical schema on an empty database and verifies an
existing canonical schema before serving traffic. It does not migrate older
UID-era tables or preserve their rows. Reset each target D1 from its canonical
schema before deploying this breaking release; startup rejects an incompatible
schema instead of changing it in place.

## Inference (opt-in, experimental)

A world can opt in to OWL 2 RL materialization with
[`@wazoo/reasoner`](https://jsr.io/@wazoo/reasoner). It is off by default; a
world that does not set `inference` behaves exactly as before.

```ts
const sdk = await createCloudflareWorldsSdk({
  database: env.DB,
  worldId,
  inference: { enabled: true }, // graphs: "per-graph" (default) | "union"
});
```

- **Storage.** Inferred quads are stored in `quads` with `derived = 1`; asserted
  quads have `derived = 0`. A quad that is both is stored once, as asserted.
  Inferred quads are visible to SPARQL and export like any other. They are not
  chunked for search on commit.
- **Write path.** Each commit loads the world's asserted quads, rebuilds a
  `Reasoner`, then uses `retract` for deletions and `extend` for insertions to
  get exactly the inferred rows to remove and add. Removal only ever deletes
  `derived = 1` rows. Retracting an asserted quad that is still entailed keeps
  it as a derived row.
- **Named graphs.** Default `"per-graph"`: entailment sees every graph; an
  inferred quad is listed in the graph(s) that entail it alone, else in
  `https://wazoo.dev/ns/reasoner#derived`. `"union"` lists everything in the
  default graph.
- **Limits.** The reasoner has no serialize/restore, so every commit costs a
  read and run over all asserted quads. `maxAssertedQuads` (default 100000)
  fails a commit with `InferenceSizeGuardError`, before any write, when the
  world is larger. Commits that go through `D1RdfjsStore` directly (not the SDK
  or SPARQL update) do not infer. `include`/`exclude` filters narrow the patch,
  not the reasoning input.
- **Enabling on an existing world.** Add the column with
  `migrations/0001-quads-derived-column.sql` (or start from an empty database).
  Existing data is not back-filled: inferred rows appear only for later changes,
  so enable it on a new or freshly imported (`mode: "replace"`) world.
- **Inconsistencies.** `commitPatchToD1` returns the reasoner's
  `inconsistencies`; they do not block the write. SHACL validation does not
  exist in this package; if added, it must run after inference.

## Install

### Package managers

```sh
# Deno (first-class JSR support)
deno add jsr:@worlds/cloudflare

# Bun / npm / pnpm / Yarn (via JSR npm compatibility layer)
npx jsr add @worlds/cloudflare
```

### CDN (browser / no build step)

[esm.sh](https://esm.sh) serves JSR packages as ES modules — no install, no
bundler needed.

```js
import { createCloudflareWorldsSdk } from "https://esm.sh/jsr/@worlds/cloudflare@0.8.0";
```

With an import map:

```html
<script type="importmap">
{
  "imports": {
    "@worlds/cloudflare": "https://esm.sh/jsr/@worlds/cloudflare@0.8.0"
  }
}
</script>
<script type="module">
import { createCloudflareWorldsSdk } from "@worlds/cloudflare";
</script>
```

Pin to an exact build for deterministic caching:

```js
import { createCloudflareWorldsSdk } from "https://esm.sh/jsr/@worlds/cloudflare@0.8.0?pin=v1724100000";
```

## Exports

| Export           | Role                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| `.`              | Root barrel: `createCloudflareWorldsSdk`, `D1RdfjsStore`, `D1QuadStore`   |
| `./quad-store`   | `D1QuadStore` (import/export/transaction over D1), `D1SearchQueryBuilder` |
| `./search-index` | `CloudflareSearchIndex` (FTS5 keyword search), `D1SearchIndexProjector`   |
| `./rdfjs-store`  | `D1RdfjsStore` (RDF/JS Store over D1), `D1QuadStream`                     |
| `./schema`       | `D1SchemaBuilder` (idempotent D1 DDL: quads, chunks, FTS5 + triggers)     |
| `./vectorize`    | `CloudflareVectorSearchIndex`, RRF utilities (planned)                    |
| `./workers-ai`   | `WorkersAiEmbeddingService` (planned)                                     |

## Setup

```sh
npx jsr add @worlds/cloudflare
```

## Releases

Every push to `main` runs the [Publish workflow](.github/workflows/publish.yml),
which publishes only when `deno.json`'s `version` is not yet on JSR:

- **Release PR** (bumps `version`): merging it publishes the new version of
  `@worlds/cloudflare`.
- **Routine PR** (no bump): the Publish job skips green with a notice. That is
  expected, not a failure.

To release, bump `version` in `deno.json` (minor for additive public API, patch
for fixes) in the PR that should ship. If the package ever imports a pinned
`jsr:@worlds/cloudflare@<version>` of itself, commit that entry to `deno.lock`;
otherwise a cold CI run rewrites the lockfile and `deno publish` aborts on the
dirty tree.

## License

TBD — match sibling Worlds packages.
