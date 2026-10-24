import { assertEquals } from "@std/assert";
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

Deno.test("insertion: extend yields the new entailment", () => {
  const plan = planInference({
    assertedBefore: [dog],
    deletions: [],
    insertions: [rex],
  });
  assertEquals(keys(plan.derivedToAdd).includes(quadKey(rexAnimal)), true);
  assertEquals(plan.derivedToRemove, []);
});

Deno.test("deletion: retract yields what is no longer entailed", () => {
  const plan = planInference({
    assertedBefore: [dog, rex],
    deletions: [rex],
    insertions: [],
  });
  assertEquals(keys(plan.derivedToRemove).includes(quadKey(rexAnimal)), true);
  assertEquals(plan.entailedDeletions, []);
});

Deno.test("retracting an asserted quad that is still derivable keeps it as derived", () => {
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
  assertEquals(keys(plan.entailedDeletions), [quadKey(redundant)]);
  assertEquals(keys(plan.derivedToRemove).includes(quadKey(redundant)), false);
});

Deno.test("deleting a quad that is only derived is ignored by the reasoner but reported as still entailed", () => {
  const plan = planInference({
    assertedBefore: [dog, rex],
    deletions: [rexAnimal],
    insertions: [],
  });
  assertEquals(plan.derivedToRemove, []);
  assertEquals(keys(plan.entailedDeletions), [quadKey(rexAnimal)]);
});

Deno.test("inserting a quad that is already asserted changes nothing", () => {
  const plan = planInference({
    assertedBefore: [dog, rex],
    deletions: [],
    insertions: [rex],
  });
  assertEquals(plan.derivedToAdd, []);
});

Deno.test("per-graph mode: a cross-graph entailment lands in the derived graph", () => {
  const schema = quad(ex("Dog"), SUBCLASS, ex("Animal"), ex("schema"));
  const data = quad(ex("rex"), RDF_TYPE, ex("Dog"), ex("data"));
  const plan = planInference({
    assertedBefore: [schema],
    deletions: [],
    insertions: [data],
  });
  const crossGraph = quad(
    ex("rex"),
    RDF_TYPE,
    ex("Animal"),
    DERIVED_GRAPH,
  );
  assertEquals(keys(plan.derivedToAdd).includes(quadKey(crossGraph)), true);
});

Deno.test("union mode lists the entailment in the default graph", () => {
  const schema = quad(ex("Dog"), SUBCLASS, ex("Animal"), ex("schema"));
  const data = quad(ex("rex"), RDF_TYPE, ex("Dog"), ex("data"));
  const plan = planInference({
    assertedBefore: [schema],
    deletions: [],
    insertions: [data],
    graphs: "union",
  });
  assertEquals(keys(plan.derivedToAdd).includes(quadKey(rexAnimal)), true);
});

Deno.test("an inconsistency in the new closure is reported", () => {
  const DISJOINT = namedNode("http://www.w3.org/2002/07/owl#disjointWith");
  const plan = planInference({
    assertedBefore: [
      quad(ex("Cat"), DISJOINT, ex("Dog"), defaultGraph()),
      rex,
    ],
    deletions: [],
    insertions: [quad(ex("rex"), RDF_TYPE, ex("Cat"), defaultGraph())],
  });
  assertEquals(plan.inconsistencies.length > 0, true);
});
