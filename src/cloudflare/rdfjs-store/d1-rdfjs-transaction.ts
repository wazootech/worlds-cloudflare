import type * as rdfjs from "@rdfjs/types";
import type { Patch } from "@worlds/sdk/quad-store";

/**
 * D1Transaction is the atomic patch contract a SPARQL update uses to buffer
 * writes. D1 has no interactive transactions, so commit() persists the whole
 * patch in one `db.batch()` call.
 */
export interface D1Transaction {
  /** add buffers a single quad for insertion on the next commit. */
  add(quad: rdfjs.Quad): unknown;

  /** delete buffers a single quad for deletion on the next commit. */
  delete(quad: rdfjs.Quad): unknown;

  /** commit persists the buffered patch (one D1 batch). */
  commit(): Promise<void>;

  /** rollback discards any uncommitted insertions and deletions. */
  rollback(): void;
}

/** D1PatchApplier is the slice of the store a transaction commits through. */
export interface D1PatchApplier {
  applyPatch(patch: Patch): Promise<void>;
}

/** D1TransactionImpl buffers a SPARQL update patch for atomic commit. */
export class D1TransactionImpl implements D1Transaction {
  private readonly inserted = new Map<string, rdfjs.Quad>();
  private readonly deleted = new Map<string, rdfjs.Quad>();

  public constructor(private readonly store: D1PatchApplier) {}

  public add(quad: rdfjs.Quad): void {
    this.deleted.delete(quadKey(quad));
    this.inserted.set(quadKey(quad), quad);
  }

  public delete(quad: rdfjs.Quad): void {
    if (this.inserted.delete(quadKey(quad))) {
      return; // add + delete of the same quad nets to nothing
    }
    this.deleted.set(quadKey(quad), quad);
  }

  public commit(): Promise<void> {
    return this.store.applyPatch({
      insertions: [...this.inserted.values()],
      deletions: [...this.deleted.values()],
    });
  }

  public rollback(): void {
    this.inserted.clear();
    this.deleted.clear();
  }
}

/** quadKey builds a deduplication key for a quad (subject/predicate/object/graph values). */
function quadKey(quad: rdfjs.Quad): string {
  const objectIsLiteral = quad.object.termType === "Literal";
  const literal = objectIsLiteral ? quad.object as rdfjs.Literal : null;
  return [
    quad.subject.termType,
    quad.subject.value,
    quad.predicate.value,
    quad.object.termType,
    quad.object.value,
    literal?.datatype?.value ?? "",
    literal?.language ?? "",
    quad.graph.termType,
    quad.graph.value,
  ].join("\u0000");
}
