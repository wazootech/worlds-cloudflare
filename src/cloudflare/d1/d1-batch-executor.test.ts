import { assertEquals } from "@std/assert";
import { D1BatchExecutor } from "./d1-batch-executor.ts";
import { D1ConnectionDriver } from "./d1-connection-driver.ts";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
} from "./d1-connection-driver.ts";

class RecordingStatement implements D1PreparedStatementLike {
  public bind(..._values: unknown[]): D1PreparedStatementLike {
    return this;
  }

  public all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return Promise.resolve({ results: [] });
  }

  public first<T = Record<string, unknown>>(): Promise<T | null> {
    return Promise.resolve(null);
  }

  public run(): Promise<{ success: boolean }> {
    return Promise.resolve({ success: true });
  }
}

class RecordingDatabase implements D1DatabaseLike {
  public batchCalls: number[] = [];

  public prepare(_sql: string): D1PreparedStatementLike {
    return new RecordingStatement();
  }

  public batch(statements: D1PreparedStatementLike[]): Promise<unknown[]> {
    this.batchCalls.push(statements.length);
    return Promise.resolve([]);
  }

  public exec(_sql: string): Promise<void> {
    return Promise.resolve();
  }
}

function createStatement(
  sql: string,
  args: number[],
): { sql: string; args: number[] } {
  return { sql, args };
}

Deno.test("D1BatchExecutor - flush chunks staged statements at the configured writeBatchSize", async () => {
  const database = new RecordingDatabase();
  const connection = new D1ConnectionDriver(database);
  const executor = new D1BatchExecutor({ connection, writeBatchSize: 100 });

  const statements = Array.from(
    { length: 250 },
    (_, index) => createStatement("INSERT INTO t VALUES (?)", [index]),
  );
  await executor.stage(statements);
  await executor.flush();

  assertEquals(database.batchCalls, [100, 100, 50]);
});

Deno.test("D1BatchExecutor - flush sends one batch when staged statements fit writeBatchSize", async () => {
  const database = new RecordingDatabase();
  const connection = new D1ConnectionDriver(database);
  const executor = new D1BatchExecutor({ connection, writeBatchSize: 100 });

  await executor.stage([
    createStatement("INSERT INTO t VALUES (?)", [1]),
    createStatement("INSERT INTO t VALUES (?)", [2]),
  ]);
  await executor.flush();

  assertEquals(database.batchCalls, [2]);
});

Deno.test("D1BatchExecutor - flush with no staged statements makes no batch calls", async () => {
  const database = new RecordingDatabase();
  const connection = new D1ConnectionDriver(database);
  const executor = new D1BatchExecutor({ connection, writeBatchSize: 100 });

  await executor.flush();

  assertEquals(database.batchCalls, []);
});

Deno.test("D1BatchExecutor - repeated stage and flush accumulates batches independently", async () => {
  const database = new RecordingDatabase();
  const connection = new D1ConnectionDriver(database);
  const executor = new D1BatchExecutor({ connection, writeBatchSize: 100 });

  await executor.stage(
    Array.from(
      { length: 150 },
      (_, index) => createStatement("INSERT INTO t VALUES (?)", [index]),
    ),
  );
  await executor.flush();
  await executor.stage([
    createStatement("INSERT INTO t VALUES (?)", [999]),
  ]);
  await executor.flush();

  assertEquals(database.batchCalls, [100, 50, 1]);
});
