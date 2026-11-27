import assert from "node:assert/strict";
import test from "node:test";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import { DERIVED_GRAPH } from "@wazoo/reasoner";
import { planInference, quadKey } from "./inference-planner.ts";

const { namedNode, quad, defaultGraph } = DataFactory;

const RDF_TYPE = namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
const SUBCLASS = namedNode("http://www.w3.org/2000/01/rdf-schema#subClassOf");
const ex = (name: string) => namedNode(`http://example.org/${name}`);

const dog = quad(ex("Dog"), SUBCLASS, ex("Animal"), defaultGraph());
const rex = quad(ex("rex"), RDF_TYPE, ex("Dog"), defaultGraph());
const rexAnimal = quad(ex("rex"), RDF_TYPE, ex("Animal"), defaultGraph());

const keys = (quads: Iterable<ReturnType<typeof quad>>) =>
  [...quads].map(quadKey);

test("insertion: extend yields the new entailment", () => {
  const plan = planInference({
    assertedBefore: [dog],
    deletions: [],
    insertions: [rex],
  });
  assert.deepStrictEqual(
    keys(plan.derivedToAdd).includes(quadKey(rexAnimal)),
    true,
  );
  assert.deepStrictEqual(plan.derivedToRemove, []);
});

test("deletion: retract yields what is no longer entailed", () => {
  const plan = planInference({
    assertedBefore: [dog, rex],
    deletions: [rex],
    insertions: [],
  });
  assert.deepStrictEqual(
    keys(plan.derivedToRemove).includes(quadKey(rexAnimal)),
    true,
  );
  assert.deepStrictEqual(plan.entailedDeletions, []);
});

test("retracting an asserted quad that is still derivable keeps it as derived", () => {
  const sub = [
    dog,
    quad(ex("Puppy"), SUBCLASS, ex("Dog"), defaultGraph()),
    quad(ex("Puppy"), SUBCLASS, ex("Animal"), defaultGraph()),
  ];
  // Puppy subClassOf Animal is asserted and also entailed through Dog.
  const redundant = sub[2]!;
  const plan = planInference({
    assertedBefore: sub,
    deletions: [redundant],
    insertions: [],
  });
  assert.deepStrictEqual(keys(plan.entailedDeletions), [quadKey(redundant)]);
  assert.deepStrictEqual(
    keys(plan.derivedToRemove).includes(quadKey(redundant)),
    false,
  );
});

test("deleting a quad that is only derived is ignored by the reasoner but reported as still entailed", () => {
  const plan = planInference({
    assertedBefore: [dog, rex],
    deletions: [rexAnimal],
    insertions: [],
  });
  assert.deepStrictEqual(plan.derivedToRemove, []);
  assert.deepStrictEqual(keys(plan.entailedDeletions), [quadKey(rexAnimal)]);
});

test("inserting a quad that is already asserted changes nothing", () => {
  const plan = planInference({
    assertedBefore: [dog, rex],
    deletions: [],
    insertions: [rex],
  });
  assert.deepStrictEqual(plan.derivedToAdd, []);
});

test("per-graph mode: a cross-graph entailment lands in the derived graph", () => {
  const schema = quad(ex("Dog"), SUBCLASS, ex("Animal"), ex("schema"));
  const data = quad(ex("rex"), RDF_TYPE, ex("Dog"), ex("data"));
  const plan = planInference({
    assertedBefore: [schema],
    deletions: [],
    insertions: [data],
  });
  const crossGraph = quad(ex("rex"), RDF_TYPE, ex("Animal"), DERIVED_GRAPH);
  assert.deepStrictEqual(
    keys(plan.derivedToAdd).includes(quadKey(crossGraph)),
    true,
  );
});

test("union mode lists the entailment in the default graph", () => {
  const schema = quad(ex("Dog"), SUBCLASS, ex("Animal"), ex("schema"));
  const data = quad(ex("rex"), RDF_TYPE, ex("Dog"), ex("data"));
  const plan = planInference({
    assertedBefore: [schema],
    deletions: [],
    insertions: [data],
    graphs: "union",
  });
  assert.deepStrictEqual(
    keys(plan.derivedToAdd).includes(quadKey(rexAnimal)),
    true,
  );
});

test("an inconsistency in the new closure is reported", () => {
  const DISJOINT = namedNode("http://www.w3.org/2002/07/owl#disjointWith");
  const plan = planInference({
    assertedBefore: [quad(ex("Cat"), DISJOINT, ex("Dog"), defaultGraph()), rex],
    deletions: [],
    insertions: [quad(ex("rex"), RDF_TYPE, ex("Cat"), defaultGraph())],
  });
  assert.deepStrictEqual(plan.inconsistencies.length > 0, true);
});
