import type * as rdfjs from "@rdfjs/types";
import { Reasoner } from "@wazoo/reasoner";
import type { Inconsistency } from "@wazoo/reasoner";

/** InferencePlanInput describes one patch against a world's asserted quads. */
export interface InferencePlanInput {
  /** assertedBefore is every asserted (not inferred) quad before the patch. */
  assertedBefore: Iterable<rdfjs.Quad>;

  /** deletions are the asserted quads the patch removes. */
  deletions: readonly rdfjs.Quad[];

  /** insertions are the asserted quads the patch adds. */
  insertions: readonly rdfjs.Quad[];

  /** graphs is the reasoner's named-graph mode (default `"per-graph"`). */
  graphs?: "per-graph" | "union";
}

/** InferencePlan is the change to the inferred rows that a patch causes. */
export interface InferencePlan {
  /**
   * derivedToAdd are the quads the insertions newly entail. It can include the
   * inserted quads themselves; write them with INSERT OR IGNORE so an asserted
   * row is never replaced by a derived one.
   */
  derivedToAdd: rdfjs.Quad[];

  /**
   * derivedToRemove are the quads no longer entailed after the deletions. It
   * can include the deleted quads; delete them as `derived = 1` rows only.
   */
  derivedToRemove: rdfjs.Quad[];

  /**
   * entailedDeletions are deleted quads that the remaining data still
   * entails. They stop being asserted but must stay stored, as derived.
   */
  entailedDeletions: rdfjs.Quad[];

  /** inconsistencies are the OWL 2 RL `false` rules the new closure violates. */
  inconsistencies: Inconsistency[];
}

/** quadKey identifies a quad by term type and value, datatype and language included. */
export function quadKey(quad: rdfjs.Quad): string {
  return [quad.subject, quad.predicate, quad.object, quad.graph]
    .map((term) => {
      if (term.termType === "Literal") {
        return `L|${term.value}|${term.datatype.value}|${term.language}`;
      }
      return `${term.termType}|${term.value}`;
    })
    .join("\u0000");
}

/**
 * planInference reasons about one patch.
 *
 * It rebuilds a Reasoner from the asserted quads (the reasoner has no
 * serialize/restore, so there is no persisted state to resume), runs it, then
 * uses `retract` and `extend` to get exactly the inferred quads the patch
 * removes and adds instead of diffing two closures. The result is correct only
 * if the stored inferred rows equal the closure of `assertedBefore`; a world
 * that had data before inference was enabled needs a one-time rebuild.
 */
export function planInference(input: InferencePlanInput): InferencePlan {
  const reasoner = new Reasoner({ graphs: input.graphs ?? "per-graph" });
  const asserted = new Map<string, rdfjs.Quad>();
  for (const quad of input.assertedBefore) asserted.set(quadKey(quad), quad);
  reasoner.add(asserted.values());
  reasoner.run();

  const deletions = dedupe(input.deletions);
  const derivedToRemove = reasoner.retract(
    deletions.filter((quad) => asserted.has(quadKey(quad))),
    "application",
  );
  for (const quad of deletions) asserted.delete(quadKey(quad));

  // A quad already asserted would be counted twice by the reasoner.
  const fresh = dedupe(input.insertions).filter((quad) =>
    !asserted.has(quadKey(quad))
  );
  const derivedToAdd = reasoner.extend(fresh, "application");

  const entailedDeletions = deletions.filter((quad) =>
    !asserted.has(quadKey(quad)) && quad.predicate.termType === "NamedNode" &&
    reasoner.has(quad.subject, quad.predicate, quad.object, quad.graph)
  );

  return {
    derivedToAdd,
    derivedToRemove,
    entailedDeletions,
    inconsistencies: reasoner.inconsistencies(),
  };
}

function dedupe(quads: readonly rdfjs.Quad[]): rdfjs.Quad[] {
  const seen = new Map<string, rdfjs.Quad>();
  for (const quad of quads) seen.set(quadKey(quad), quad);
  return [...seen.values()];
}
