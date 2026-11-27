# AI agent coding guidelines

## Code health

Family-wide rules live in the
[wazootech workspace constitution](https://github.com/wazootech/workspace/blob/main/AGENTS.md#code-health-standards);
this repo's specifics:

- Before pushing, run `bun run ci` (format check, lint, type check, manifest
  check, tests). The toolchain is Bun: `bun fmt --no-script`, Oxlint
  (`oxlint --deny-warnings`, `.oxlintrc.json`), `bun check --no-script`
  (`tsc`), `bun test`. Code and tests are Node-compatible (`node:test`,
  `node:assert/strict`, `node:*` APIs); the suite also passed on Deno before the
  cutover (#104), but nothing in CI runs it there now.
- Install with `bun install --frozen-lockfile --ignore-scripts`. `jsr.json` is
  the published manifest and `package.json` mirrors it for Bun;
  `bun run check:manifests` fails on drift.
- Type checking is strict; do not weaken it.
- The single `typescript/no-explicit-any` override for
  `src/cloudflare/rdfjs-store/d1-quad-stream.ts` in `.oxlintrc.json` covers a
  commented EventEmitter listener type; keep its explanatory comment and add no
  new `any` without one.
- Tests run on miniflare (D1 and Vectorize emulation); never point them or
  `scripts/verify-vectorize.ts` at a real Cloudflare account from CI.
- Actions in `.github/workflows/` are pinned to full commit SHAs. Bun is the
  one toolchain that floats (`bun-version: "1.x"`, owner decision in
  wazootech/workspace#50); installs are frozen (`bun install --frozen-lockfile`).
- `secret-scan.yml` runs gitleaks on every PR and push to `main`; report
  findings, never suppress them.
- `code-health.yml` enforces the file-length limit (120 lines of code per source
  file, 300 per test; blank, comment, and import lines excluded) and fails the
  build on a violation. The only exceptions are an explicit, commented allowlist
  in the workflow that may only shrink (`d1-quad-stream.ts`,
  `d1-rdfjs-store.ts`). The TODO/FIXME-without-issue check stays warn-only.
- `.github/CODEOWNERS` and `renovate.json` are present; Renovate only acts where
  the org has the Renovate GitHub App installed.
