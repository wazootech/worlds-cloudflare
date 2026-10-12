/**
 * Vectorize provisioning contract (worlds-cloudflare#38).
 *
 * `VectorizeVectorSearchIndex` only works against an index that was created
 * with the right shape and has `world_id` registered as a filterable metadata
 * property BEFORE vectors are written. This module is the single, testable
 * statement of that shape: it plans the exact `wrangler` commands and checks
 * an index that already exists, so provisioning is reproducible and a missing
 * or misconfigured index fails loudly instead of degrading to keyword-only.
 *
 * It performs no I/O. `scripts/verify-vectorize.ts` feeds it `wrangler` output.
 */

/** VECTORIZE_FILTERABLE_PROPERTY is the metadata key that scopes vectors per world. */
export const VECTORIZE_FILTERABLE_PROPERTY = "world_id";

/** VECTORIZE_FILTERABLE_PROPERTY_TYPE is the metadata index type of `world_id`. */
export const VECTORIZE_FILTERABLE_PROPERTY_TYPE = "string";

/** VECTORIZE_METRIC is the distance metric; search scores assume cosine in [-1, 1]. */
export const VECTORIZE_METRIC = "cosine";

/**
 * DEFAULT_VECTORIZE_DIMENSIONS matches the SDK factory's `vectorDimensions`
 * default. Index dimensions are immutable and must equal the width of every
 * embedding the configured embedding service produces.
 */
export const DEFAULT_VECTORIZE_DIMENSIONS = 1536;

/** VectorizeIndexExpectation is the shape an index must have. */
export interface VectorizeIndexExpectation {
  /** name of the Vectorize index (the wrangler `index_name`). */
  name: string;
  /** dimensions the index must have; defaults to DEFAULT_VECTORIZE_DIMENSIONS. */
  dimensions?: number;
}

/** VectorizeIndexObservation is what `wrangler vectorize get --json` reports. */
export interface VectorizeIndexObservation {
  name?: string;
  config?: { dimensions?: number; metric?: string };
}

/** VectorizeMetadataIndexObservation is one `list-metadata-index --json` row. */
export interface VectorizeMetadataIndexObservation {
  propertyName?: string;
  property_name?: string;
  indexType?: string;
  index_type?: string;
}

/**
 * planVectorizeProvisioning returns the ordered wrangler commands that create
 * a conforming index. Order matters: vectors written before the metadata
 * index exists are not filterable and must be re-upserted (run a reindex).
 */
export function planVectorizeProvisioning(
  expectation: VectorizeIndexExpectation,
): string[] {
  const dimensions = expectation.dimensions ?? DEFAULT_VECTORIZE_DIMENSIONS;
  assertValidExpectation(expectation.name, dimensions);
  return [
    `wrangler vectorize create ${expectation.name} --dimensions ${dimensions} --metric ${VECTORIZE_METRIC}`,
    `wrangler vectorize create-metadata-index ${expectation.name} --propertyName ${VECTORIZE_FILTERABLE_PROPERTY} --type ${VECTORIZE_FILTERABLE_PROPERTY_TYPE}`,
  ];
}

/**
 * checkVectorizeIndex compares an observed index with the expectation and
 * returns every problem found (empty means conforming). `index` is undefined
 * when the index does not exist.
 */
export function checkVectorizeIndex(
  expectation: VectorizeIndexExpectation,
  index: VectorizeIndexObservation | undefined,
  metadataIndexes: VectorizeMetadataIndexObservation[],
): string[] {
  const dimensions = expectation.dimensions ?? DEFAULT_VECTORIZE_DIMENSIONS;
  assertValidExpectation(expectation.name, dimensions);
  if (!index) {
    return [
      `index "${expectation.name}" does not exist; provision it with:\n  ${
        planVectorizeProvisioning(expectation).join("\n  ")
      }`,
    ];
  }
  const problems: string[] = [];
  const observedDimensions = index.config?.dimensions;
  if (observedDimensions !== dimensions) {
    problems.push(
      `index "${expectation.name}" has ${observedDimensions} dimensions, expected ${dimensions}; dimensions are immutable, so the index must be recreated`,
    );
  }
  const observedMetric = index.config?.metric;
  if (observedMetric !== VECTORIZE_METRIC) {
    problems.push(
      `index "${expectation.name}" uses metric ${observedMetric}, expected ${VECTORIZE_METRIC}; the metric is immutable, so the index must be recreated`,
    );
  }
  const filterable = metadataIndexes.find((row) =>
    (row.propertyName ?? row.property_name) === VECTORIZE_FILTERABLE_PROPERTY
  );
  if (!filterable) {
    problems.push(
      `index "${expectation.name}" has no metadata index on ${VECTORIZE_FILTERABLE_PROPERTY}; world-scoped queries cannot filter. Run:\n  wrangler vectorize create-metadata-index ${expectation.name} --propertyName ${VECTORIZE_FILTERABLE_PROPERTY} --type ${VECTORIZE_FILTERABLE_PROPERTY_TYPE}\nthen reindex, because vectors written earlier are not filterable`,
    );
  } else {
    const type = filterable.indexType ?? filterable.index_type;
    // wrangler reports the type capitalized ("String"); create-metadata-index
    // takes it lowercase, so compare case-insensitively.
    if (type?.toLowerCase() !== VECTORIZE_FILTERABLE_PROPERTY_TYPE) {
      problems.push(
        `metadata index ${VECTORIZE_FILTERABLE_PROPERTY} on "${expectation.name}" has type ${type}, expected ${VECTORIZE_FILTERABLE_PROPERTY_TYPE}`,
      );
    }
  }
  return problems;
}

function assertValidExpectation(name: string, dimensions: number): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    throw new Error(
      `invalid Vectorize index name "${name}": use lowercase letters, digits and dashes`,
    );
  }
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error(`invalid Vectorize dimensions: ${dimensions}`);
  }
}
