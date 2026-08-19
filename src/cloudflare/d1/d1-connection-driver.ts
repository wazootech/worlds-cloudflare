/**
 * D1PreparedStatementLike is the minimal D1 prepared-statement surface the
 * driver uses (prepare → bind → all/first/run). Miniflare's real D1 binding
 * satisfies it structurally, so tests run against the actual binding.
 */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ success: boolean }>;
}

/**
 * D1DatabaseLike is the minimal D1 binding surface the driver uses:
 * prepare, batch (atomic multi-statement transaction), and exec (DDL).
 */
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
  exec(sql: string): Promise<void>;
}

/**
 * D1Statement is a single parameterized SQL statement with `?` placeholders.
 */
export interface D1Statement {
  sql: string;
  args?: unknown[];
}

/**
 * D1Result is the outcome of executing a single statement.
 */
export interface D1Result<Row = Record<string, unknown>> {
  rows: Row[];
}

/**
 * D1ConnectionDriver adapts a D1 binding (miniflare or a real Worker binding)
 * to the uniform execute/batch/exec surface used by the D1 stores. D1 has no
 * interactive transactions: the atomic unit is one `db.batch()` call, which
 * runs its statements sequentially in a transaction and rolls back the whole
 * sequence on any failure.
 */
export class D1ConnectionDriver {
  public constructor(private readonly database: D1DatabaseLike) {}

  /**
   * execute runs a single parameterized statement and returns its rows.
   */
  public async execute<Row = Record<string, unknown>>(
    statement: D1Statement,
  ): Promise<D1Result<Row>> {
    let prepared = this.database.prepare(statement.sql);
    if (statement.args && statement.args.length > 0) {
      prepared = prepared.bind(...statement.args);
    }
    const result = await prepared.all<Row>();
    return { rows: result.results };
  }

  /**
   * batch runs multiple statements atomically in one D1 batch transaction.
   */
  public async batch(statements: readonly D1Statement[]): Promise<void> {
    if (statements.length === 0) {
      return;
    }
    const prepared = statements.map((statement) => {
      let preparedStatement = this.database.prepare(statement.sql);
      if (statement.args && statement.args.length > 0) {
        preparedStatement = preparedStatement.bind(...statement.args);
      }
      return preparedStatement;
    });
    await this.database.batch(prepared);
  }

  /**
   * exec runs a multi-statement DDL/migration string (no bound parameters).
   */
  public async exec(sql: string): Promise<void> {
    await this.database.exec(sql);
  }
}
