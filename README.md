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
cross-backend interchangeability lives at the `@worlds/sdk` `Sdk` seam.

## Status

Active development. The D1 quad store layer
([`D1RdfjsStore`](#planned-exports) + `D1SchemaBuilder` + miniflare substrate)
and the keyword search index (`CloudflareSearchIndex`, FTS5) are implemented and
tested against miniflare. Vectorize (semantic search) and Workers AI
(embeddings) integrations remain planned. The phased plan is tracked in
[worlds-sdk-ts#136](https://github.com/wazootech/worlds-sdk-ts/issues/136).

## Planned exports

| Export           | Role                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| `.`              | Root barrel: `createCloudflareSdk`, `D1RdfjsStore`, `D1QuadStore`         |
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

## License

TBD — match sibling Worlds packages.
