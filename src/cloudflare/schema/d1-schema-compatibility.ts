import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";

export interface D1SchemaCompatibilityIssue {
  table: string;
  detail: string;
}

export interface D1SchemaCompatibilityReport {
  compatible: boolean;
  issues: D1SchemaCompatibilityIssue[];
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  quads: [
    "id",
    "s",
    "s_type",
    "p",
    "o",
    "o_type",
    "o_datatype",
    "o_lang",
    "g",
    "g_type",
  ],
  chunks: [
    "id",
    "quad_id",
    "subject",
    "predicate",
    "graph",
    "value",
    "fts_value",
    "vector",
  ],
};

/** Inspect the actual D1 schema and report missing required tables or columns. */
export async function checkD1SchemaCompatibility(
  connection: D1ConnectionDriver,
): Promise<D1SchemaCompatibilityReport> {
  const issues: D1SchemaCompatibilityIssue[] = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const tableResult = await connection.execute<{ name: string }>({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: [table],
    });
    if (tableResult.rows.length === 0) {
      issues.push({ table, detail: "missing table" });
      continue;
    }

    const columnResult = await connection.execute<{ name: string }>({
      sql: `PRAGMA table_info(${table})`,
    });
    const actual = new Set(columnResult.rows.map((row) => row.name));
    for (const column of columns) {
      if (!actual.has(column)) {
        issues.push({ table, detail: `missing column ${column}` });
      }
    }
  }
  return { compatible: issues.length === 0, issues };
}

/** Validate the schema and throw an actionable error before serving traffic. */
export async function assertD1SchemaCompatible(
  connection: D1ConnectionDriver,
): Promise<void> {
  const report = await checkD1SchemaCompatibility(connection);
  if (!report.compatible) {
    throw new Error(
      `D1 schema is incompatible with @worlds/cloudflare: ${
        report.issues.map((issue) => `${issue.table}: ${issue.detail}`).join(
          ", ",
        )
      }`,
    );
  }
}
