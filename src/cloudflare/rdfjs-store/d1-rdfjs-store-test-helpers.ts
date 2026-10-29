import { DataFactory } from "@wazoo/sparql-engine/data-model";
import { D1RdfjsStore } from "./mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";

export const { namedNode, literal, blankNode } = DataFactory;

export async function createTestD1Store(): Promise<
  { store: D1RdfjsStore; dispose(): Promise<void> }
> {
  const substrate = await createTestD1();
  const store = new D1RdfjsStore({ connection: substrate.connection });
  await store.ensureSchema();
  return { store, dispose: substrate.dispose };
}

// ──────────────────────────────────────────────────
// match() read tests
// ──────────────────────────────────────────────────
