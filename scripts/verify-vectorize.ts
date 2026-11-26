/**
 * verify-vectorize checks that a Vectorize index exists and is shaped the way
 * VectorizeVectorSearchIndex requires (worlds-cloudflare#38). It only reads:
 * `wrangler vectorize get` and `list-metadata-index`. Exit code 1 on any
 * problem, so it can gate a deploy or a human's post-provision checklist.
 *
 *   deno task vectorize:verify <index-name> [--dimensions 1536]
 *   bun scripts/verify-vectorize.ts <index-name> [--dimensions 1536]
 *
 * Requires wrangler credentials for the account that owns the index
 * (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID or `wrangler login`).
 */
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  checkVectorizeIndex,
  DEFAULT_VECTORIZE_DIMENSIONS,
  type VectorizeIndexObservation,
  type VectorizeMetadataIndexObservation,
} from "../src/cloudflare/search-index/vector-search/vectorize-provisioning.ts";

function wrangler(args: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  // npx is a .cmd shim on Windows, which only a shell can launch.
  const out = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return {
    ok: out.status === 0,
    stdout: out.stdout ?? "",
    stderr: out.stderr ?? "",
  };
}

function parseJson<T>(text: string): T | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start)) as T;
  } catch {
    return undefined;
  }
}

const args = process.argv.slice(2);
const dimIndex = args.indexOf("--dimensions");
let dimensions = DEFAULT_VECTORIZE_DIMENSIONS;
if (dimIndex >= 0) {
  dimensions = Number(args[dimIndex + 1]);
  args.splice(dimIndex, 2);
}
const name = args[0];
if (!name) {
  console.error(
    "usage: deno task vectorize:verify <index-name> [--dimensions N]",
  );
  process.exit(2);
}

const got = wrangler(["vectorize", "get", name, "--json"]);
let index: VectorizeIndexObservation | undefined;
let metadataIndexes: VectorizeMetadataIndexObservation[] = [];
if (got.ok) {
  index = parseJson<VectorizeIndexObservation>(got.stdout);
  const listed = wrangler(["vectorize", "list-metadata-index", name, "--json"]);
  if (!listed.ok) {
    console.error(listed.stderr || listed.stdout);
    process.exit(1);
  }
  metadataIndexes =
    parseJson<VectorizeMetadataIndexObservation[]>(listed.stdout) ?? [];
} else if (!/not_found|3000|does not exist/i.test(got.stdout + got.stderr)) {
  // Auth or network failure: not evidence the index is missing.
  console.error(got.stderr || got.stdout);
  process.exit(1);
}

const problems = checkVectorizeIndex(
  { name, dimensions },
  index,
  metadataIndexes,
);
if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exit(1);
}
console.log(
  `OK   ${name}: ${dimensions} dimensions, cosine, world_id filterable`,
);
