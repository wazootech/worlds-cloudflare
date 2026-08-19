import { Miniflare } from "miniflare";
import { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import type { D1DatabaseLike } from "@/cloudflare/d1/d1-connection-driver.ts";

/**
 * TestD1 is the miniflare-backed D1 substrate used by the store tests: a real
 * D1 binding (prepare/bind/all/batch/exec) plus an explicit dispose for teardown.
 */
export interface TestD1 {
  /** database is the raw miniflare D1 binding. */
  database: D1DatabaseLike;

  /** connection wraps the binding in the D1ConnectionDriver the store consumes. */
  connection: D1ConnectionDriver;

  /** dispose tears down the miniflare instance. */
  dispose(): Promise<void>;
}

/**
 * createTestD1 boots a miniflare D1 database with an isolated storage name so
 * tests never share state, and wraps it in the store's connection driver.
 */
export async function createTestD1(
  name = `d1-test-${crypto.randomUUID()}`,
): Promise<TestD1> {
  const mf = new Miniflare({
    modules: true,
    d1Databases: { DB: name },
    script: "export default { async fetch() { return new Response('ok'); } }",
  });
  const database = await mf.getD1Database("DB") as unknown as D1DatabaseLike;
  const connection = new D1ConnectionDriver(database);
  return {
    database,
    connection,
    dispose: () => mf.dispose(),
  };
}
