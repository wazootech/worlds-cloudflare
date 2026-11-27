import type { D1Statement } from "@/cloudflare/d1/d1-connection-driver.ts";

/**
 * DEFAULT_D1_MAX_BATCH_WEIGHT is the estimated serialized bytes one D1
 * `batch()` call may carry (16 MiB). The Worker-to-D1 RPC rejects a batch whose
 * serialized arguments exceed 32 MiB (measured on a real D1, 2026-11-22, see
 * README), so this leaves 2x headroom for the estimator's error.
 */
export const DEFAULT_D1_MAX_BATCH_WEIGHT = 16 * 1024 * 1024;

/**
 * BLOB_BYTE_WEIGHT multiplies a BLOB parameter's length. The binding serializes
 * BLOB bytes roughly as numbers: a 1,536-dim chunk row measured about 3.6x its
 * raw bytes, so 4 is the conservative round-up.
 */
export const BLOB_BYTE_WEIGHT = 4;

/** STATEMENT_OVERHEAD_BYTES is the per-statement envelope allowance. */
export const STATEMENT_OVERHEAD_BYTES = 64;

/** SCALAR_PARAM_BYTES is the allowance for a number, boolean, or null parameter. */
export const SCALAR_PARAM_BYTES = 8;

/** paramWeight estimates one bound parameter's serialized bytes. */
function paramWeight(value: unknown): number {
  if (typeof value === "string") return value.length + 2;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value.byteLength * BLOB_BYTE_WEIGHT;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum: number, item) => sum + paramWeight(item), 0);
  }
  return SCALAR_PARAM_BYTES;
}

/**
 * d1StatementWeight ESTIMATES the serialized bytes of one D1 statement: the SQL
 * text length, a fixed overhead, and each bound parameter (strings by UTF-16
 * code units, BLOBs at `BLOB_BYTE_WEIGHT` per byte, scalars a few bytes). It is
 * calibrated from measured real-D1 points, not a contract, and errs high.
 */
export function d1StatementWeight(statement: D1Statement): number {
  let weight = statement.sql.length + STATEMENT_OVERHEAD_BYTES;
  for (const arg of statement.args ?? []) weight += paramWeight(arg);
  return weight;
}
