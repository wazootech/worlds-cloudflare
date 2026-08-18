# @worlds/cloudflare

Durable backend for the Worlds client
([`@worlds/sdk`](https://jsr.io/@worlds/sdk)) targeting Cloudflare-native
deployments: **D1** first, with optional **Vectorize** (semantic search) and
**Workers AI** (embeddings) integrations.

Part of the Worlds durable-backend family alongside
[`@worlds/libsql`](https://github.com/wazootech/worlds-libsql) and
[`@worlds/postgres`](https://github.com/wazootech/worlds-postgres), per the
provider-seam design
([worlds-sdk-ts#164](https://github.com/wazootech/worlds-sdk-ts/issues/164)).

## Status

Scaffold only — **parked (post-beta)** as of 2026-08-17 per the provider-seam
decision
([worlds-sdk-ts#164](https://github.com/wazootech/worlds-sdk-ts/issues/164)):
the beta runs single-backend on Turso (`@worlds/libsql`). The phased plan (D1
hexastore schema, `D1RdfjsStore`, import/export, Vectorize + Workers AI
integrations) is tracked in
[worlds-sdk-ts#136](https://github.com/wazootech/worlds-sdk-ts/issues/136)
(`backlog`) — re-open when the beta ships.

## Planned exports

| Export         | Role                                                  |
| -------------- | ----------------------------------------------------- |
| `.`            | Root barrel: `createCloudflareSdk`, `createD1Sdk`     |
| `./d1`         | `D1QuadStore`, `D1RdfjsStore`, `D1SearchIndex`, types |
| `./vectorize`  | `CloudflareVectorSearchIndex`, RRF utilities          |
| `./workers-ai` | `WorkersAiEmbeddingService`                           |

## Setup

```sh
npx jsr add @worlds/cloudflare
```

## License

TBD — match sibling Worlds packages.
