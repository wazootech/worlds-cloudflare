import type * as rdfjs from "@rdfjs/types";
import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
import {
  isReplaceImportCommit,
  type PreparedPatch,
  preparePatch,
  selectNovelQuads,
} from "@worlds/sdk/quad-store";
import { effectiveLookupChunkSize } from "@/cloudflare/d1/d1-batch-executor.ts";
import type { CommitPatchToD1Options } from "./commit-patch-to-d1-types.ts";
import { queryCachePresence } from "./commit-patch-to-d1-helpers.ts";

/**
 * D1CommitPlan is a patch after everything a commit can decide without
 * writing: the filtered and hashed patch, and the insertions that are novel.
 */
export interface D1CommitPlan {
  /** prepared is the patch after the include/exclude filter and hashing. */
  prepared: PreparedPatch;

  /** novelInsertions are the quads the commit must write. */
  novelInsertions: rdfjs.Quad[];

  /** novelQuadIds are the content hashes of `novelInsertions`, index for index. */
  novelQuadIds: string[];
}

/**
 * planD1Commit filters and hashes the patch and selects the novel insertions
 * with the shared helpers, before any write. A throw here (a matcher on
 * malformed input, hashing, a failed lookup) leaves the world untouched, even
 * for a replace import whose wipe has not run yet.
 *
 * A replace import wipes the world before it writes, so nothing existing
 * counts and the presence lookup is skipped (`replacing`). Every other commit
 * looks the insertions up scoped to the world, ignoring derived rows when
 * inference is on.
 */
export async function planD1Commit(
  patch: Patch,
  options: CommitPatchToD1Options,
  context?: TransactionContext,
): Promise<D1CommitPlan> {
  const prepared = preparePatch(patch, {
    include: options.include,
    exclude: options.exclude,
  });
  const lookupChunkSize = effectiveLookupChunkSize(
    options.maxLookupChunkSize,
    Boolean(options.worldId),
  );
  const { novelInsertions, novelQuadIds } = await selectNovelQuads(prepared, {
    replacing: isReplaceImportCommit(context),
    lookupExisting: (keys) =>
      queryCachePresence(
        options.connection,
        keys,
        lookupChunkSize,
        options.worldId,
        options.inference?.enabled === true,
      ),
  });
  return { prepared, novelInsertions, novelQuadIds };
}
