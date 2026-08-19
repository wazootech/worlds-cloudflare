import type * as rdfjs from "@rdfjs/types";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import { toRdfjsTerm } from "@worlds/sdk/quad-store";
import { hashQuads } from "@worlds/sdk/quad-store";
import type { InsertQuadRow } from "@/cloudflare/quad-store/d1-quad-query-builder.ts";

const { quad } = DataFactory;

/**
 * quadFromD1Row reconstructs an RDF/JS quad from a D1 `quads` table row.
 * Rows come from the D1ConnectionDriver, which exposes plain column records
 * (not the @cloudflare/workers-types array-like Row).
 */
export function quadFromD1Row(row: Record<string, unknown>): rdfjs.Quad {
  const subject = toRdfjsTerm({
    termType: String(row.s_type),
    value: String(row.s),
  }) as rdfjs.Quad_Subject;
  const predicate = toRdfjsTerm({
    termType: "NamedNode",
    value: String(row.p),
  }) as rdfjs.Quad_Predicate;
  const object = toRdfjsTerm({
    termType: String(row.o_type),
    value: String(row.o),
    language: row.o_lang ? String(row.o_lang) : undefined,
    datatype: row.o_datatype ? String(row.o_datatype) : undefined,
  }) as rdfjs.Quad_Object;
  const graph = toRdfjsTerm({
    termType: String(row.g_type),
    value: String(row.g),
  }) as rdfjs.Quad_Graph;

  return quad(subject, predicate, object, graph);
}

/** quadToInsertRow flattens a quad into a D1 insert row with a content-addressed id. */
export async function quadToInsertRow(
  quad: rdfjs.Quad,
): Promise<InsertQuadRow> {
  const [id] = await hashQuads([quad]);
  const subject = quad.subject;
  const object = quad.object;
  const graph = quad.graph;
  return {
    quad_id: id,
    s: subject.value,
    s_type: subject.termType,
    p: quad.predicate.value,
    o: object.value,
    o_type: object.termType,
    o_datatype: object.termType === "Literal"
      ? (object as rdfjs.Literal).datatype?.value ?? null
      : null,
    o_lang: object.termType === "Literal"
      ? (object as rdfjs.Literal).language || null
      : null,
    g: graph.value,
    g_type: graph.termType,
  };
}
