import type * as rdfjs from "@rdfjs/types";
import type { D1ClientBaseOptions } from "@/cloudflare/d1-client-base-options.ts";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import type { InferencePlan } from "@/cloudflare/inference/inference-planner.ts";

export interface CommitPatchToD1Options extends D1ClientBaseOptions {
  /** connection is the D1ConnectionDriver wrapping the D1 binding. */
  connection: D1ConnectionDriver;

  /** maxWriteBatchSize caps how many statements are sent per D1 batch. Defaults to 100 (D1's batch cap). */
  maxWriteBatchSize?: number;

  /** worldId scopes this commit to one logical world. */
  worldId?: string;
}

export interface CommitPatchToD1Result {
  novelInsertions: rdfjs.Quad[];
  novelQuadIds: string[];

  /**
   * inference summarizes the inferred rows this commit wrote. Absent when the
   * world has not opted in.
   */
  inference?: {
    derivedInserted: number;
    derivedRemoved: number;
    inconsistencies: InferencePlan["inconsistencies"];
  };
}
