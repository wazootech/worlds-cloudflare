# @worlds/cloudflare

Durable backend for the Worlds client ([`@worlds/client`](https://github.com/wazootech/worlds-client-ts)) targeting Cloudflare-native deployments: **D1** first, with optional **Vectorize** (semantic search) and **Workers AI** (embeddings) integrations.

Part of the Worlds durable-backend family alongside [`@worlds/libsql`](https://github.com/wazootech/worlds-libsql) and [`@worlds/postgres`](https://github.com/wazootech/worlds-postgres), per the provider-seam design ([worlds-sdk-ts#164](https://github.com/wazootech/worlds-sdk-ts/issues/164)).

## Status

Scaffold. Implementation is tracked in [worlds-sdk-ts#136](https://github.com/wazootech/worlds-sdk-ts/issues/136) — the phased plan (D1 hexastore schema, `D1RdfjsStore`, import/export, Vectorize + Workers AI integrations) lives there.

## Planned exports

| Export | Role |
|--------|------|
| `.` | Root barrel: `createCloudflareClient`, `createD1Client` |
| `./d1` | `D1QuadStore`, `D1RdfjsStore`, `D1SearchIndex`, types |
| `./vectorize` | `CloudflareVectorSearchIndex`, RRF utilities |
| `./workers-ai` | `WorkersAiEmbeddingService` |

## Setup

```sh
npx jsr add @worlds/cloudflare
```

## License

TBD — match sibling Worlds packages.
