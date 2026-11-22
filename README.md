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

**Vector sync is reported, not swallowed.** A failed vector upsert or
stale-vector delete never fails an import (D1 is the source of truth and keyword
search keeps serving), but it is logged as a structured `[vector-sync]` error
and counted. `CloudflareSearchIndex.reindex()` returns `vectorSync`
(`attempted`, `upserted`, `failedUpserts`, `staleDeleteFailures`, `errors`;
`embeddingFailures` is always 0, kept so report schemas keep parsing), and
rerunning reindex repairs the drift
([worlds-cloudflare#40](https://github.com/wazootech/worlds-cloudflare/issues/40)).

**An embedding failure throws.** Like every `worlds-*` backend, a commit or
reindex whose embedding service fails (or returns vectors of the wrong length)
rejects before anything is written, so the caller can retry. Writes therefore
fail while the embedding service is down; there is no keyword-only fallback and
no stale marker.

**Commit path.** Commits run through the shared `commitSqlPatch` and reindex
through `rebuildSqlSearchIndex` from `@worlds/sqlite/sql-core`; this package
only supplies a D1 driver and dialect (`src/cloudflare/commit/`). Differences
from the shared behavior, each forced by the platform or kept for hosted
consumers:

- **Atomicity is bounded by one `batch()` call.** D1's atomic unit is a single
  `batch()`. A commit with at most `maxWriteBatchSize` statements (default 750)
  is one atomic batch, including its chunk rows, and a failed replace import
  keeps the old graph. A larger commit takes the core's chunked fallback: not
  atomic, a failure removes the quads written so far, and a replace import that
  fails after its wipe leaves an empty graph. Each quad costs about two
  statements (a quad row and a chunk row), so an import of roughly 375 quads or
  more takes the chunked fallback; raise `maxWriteBatchSize` to keep larger
  imports atomic, mindful of the payload limit below. The default used to be
  100, which sent imports of 50 or more quads down the non-atomic fallback.
  Cloudflare documents no per-batch statement cap (read 2026-11-22,
  <https://developers.cloudflare.com/d1/platform/limits/>): a `db.batch()`
  "counts as a single query" against the 1000 (paid) / 50 (free) queries per
  invocation, the 30 second query duration "also applies to the entire batch
  call", and the 100 bound parameters and 100,000 byte statement length are
  per-statement limits that still apply inside a batch (the lookup chunk size
  stays 100). The binding has one more limit, found by measurement: **the
  Worker-to-D1 RPC rejects a `batch()` whose serialized arguments exceed 32
  MiB**
  (`D1_ERROR: Serialized RPC arguments or return values are limited to
  32MiB`).
  It is a byte limit, so the safe statement count depends on row size.
  - **Measured on a real D1 throwaway database, 2026-11-22** (Worker binding,
    `wrangler dev --remote`, the repo's `quads`/`chunks` schema with the 7 quad
    indexes, the chunk index, the FTS5 table and its triggers; one run each, so
    timings are indicative, not statistical). "Mixed" alternates a quad row and
    a chunk row, as an import does; "chunks" is chunk rows only (a reindex).
    Chunk rows carry a float32 BLOB vector and about 200 characters of text.

    | statements | row kind                  | payload (raw) | wall ms (Worker) | result                                |
    | ---------- | ------------------------- | ------------- | ---------------- | ------------------------------------- |
    | 100        | mixed, 384-dim            | 0.11 MB       | 99 (87 on rerun) | ok                                    |
    | 500        | mixed, 384-dim            | 0.57 MB       | 268              | ok                                    |
    | 1,000      | mixed, 384-dim            | 1.1 MB        | 387              | ok                                    |
    | 2,000      | mixed, 384-dim            | 2.3 MB        | 710              | ok                                    |
    | 4,000      | mixed, 384-dim            | 4.6 MB        | 1,411            | ok                                    |
    | 2,000      | chunks, 384-dim           | 4.0 MB        | 1,034            | ok                                    |
    | 3,000      | chunks, 384-dim           | 6.0 MB        | 2,044            | ok                                    |
    | 4,000      | chunks, 384-dim           | 8.0 MB        | 3,243            | ok                                    |
    | 100        | mixed, 1,536-dim          | 0.34 MB       | 121              | ok                                    |
    | 500        | mixed, 1,536-dim          | 1.7 MB        | 391              | ok                                    |
    | 1,000      | mixed, 1,536-dim          | 3.4 MB        | 870              | ok                                    |
    | 2,000      | mixed, 1,536-dim          | 6.9 MB        | 1,425            | ok (about 22.7 MB serialized)         |
    | 4,000      | mixed, 1,536-dim          | 13.8 MB       | n/a              | rejected, 45.3 MB serialized > 32 MiB |
    | 1,000      | chunks, 1,536-dim         | 6.6 MB        | 1,511            | ok                                    |
    | 1,400      | chunks, 1,536-dim         | 9.2 MB        | 1,707            | ok                                    |
    | 1,500      | chunks, 1,536-dim         | 9.9 MB        | 2,584            | ok                                    |
    | 1,510      | chunks, 1,536-dim         | 10.0 MB       | n/a              | rejected, 33.6 MB serialized > 32 MiB |
    | 2,000      | chunks, 1,536-dim (heavy) | 13.2 MB       | n/a              | rejected, 44.5 MB serialized > 32 MiB |

    A 1,536-dim chunk row serializes to about 22 KB (3.6x its raw BLOB bytes),
    so pure heavy-chunk batches top out near 1,500 statements. At 750 the heavy
    worst case is about 16.7 MB serialized, 2x under the limit; a mixed import
    of 1,536-dim rows is about 3.8x under. Time was never the constraint: every
    accepted batch finished in under 3 s against the documented 30 s, and D1
    reported under 0.6 s of summed SQL time for every batch up to 2,000
    statements (1.7 s at 4,000 chunk rows). **Atomic rollback** was verified on
    real D1: a batch whose last statement duplicated an earlier primary key
    (after 500, then 2,000 statements, 384-dim and 1,536-dim) failed with
    `UNIQUE constraint failed` and left zero rows in `quads` and `chunks`; a
    last statement against a missing table did the same (rejected before any row
    was written).
  - **Not measured:** concurrent writers or load, production latency under
    realistic contention (this was an idle new database from one location,
    WNAM), batches above 4,000 statements of 384-dim rows (the 32 MiB bound
    suggests about 6,000 chunk rows of 384 dimensions), chunk text far longer
    than 200 characters (a larger `value`/`fts_value` shrinks the safe count),
    and databases with large existing tables. Production batch timing and the
    `Too many API requests by single Worker invocation` limit were not
    exercised.
- **Vectorize is outside D1.** Vectors sync after the D1 write lands, so a
  Vectorize failure is logged drift (above), never a rollback.
- **Deleting a quad leaves its chunk rows** until a reindex or the hosted API's
  orphan cleanup, because those rows are the only record of the Vectorize ids to
  remove.
- **`searchIndexOnImport` defaults to `"incremental"`**, the shared default: an
  import projects chunks and embeds only the quads it writes, so a failed
  embedding throws before anything is written. `"deferred"` (persist quads, then
  rebuild the whole world's index) is an option, not the default. Measured on
  miniflare (worlds-cloudflare#92), `incremental` issues the same number of
  statements and about the same number of `batch()` calls as `deferred`, embeds
  fewer texts when merging into a populated world, and leaves nothing behind
  when embedding fails; `deferred` leaves quads without chunk rows.

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
- **Shared databases.** Before 0.12.0 a world-scoped `quads` table keyed rows by
  `quad_id` alone, so two worlds holding the same triple shared one row (#60).
  Existing databases need `migrations/0002-quads-world-scoped-key.sql`, run
  after `0001`; new databases get the `(world_id, quad_id)` key.
- **Enabling on an existing world.** Add the column with
  `migrations/0001-quads-derived-column.sql` (or start from an empty database).
  Enabling alone does not back-fill: inferred rows appear only for later
  changes. To materialize inference for data already stored, call
  `backfillInference({ database, worldId, inference })`. It runs the reasoner
  once over the asserted quads, clears the world's inferred rows, writes the
  closure, and reports counts and inconsistencies. It is idempotent, honors
  `maxAssertedQuads` before any write, and never touches asserted rows. The
  clear and the writes are separate batches, so after a failure run it again.
- **Inconsistencies.** `backfillInference` returns the reasoner's
  `inconsistencies`; a commit does not report them and they do not block the
  write. SHACL validation does not exist in this package; if added, it must run
  after inference.

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
