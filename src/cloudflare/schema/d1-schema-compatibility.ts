import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";

export interface D1SchemaCompatibilityIssue {
  table: string;
  detail: string;
}

export interface D1SchemaCompatibilityReport {
  compatible: boolean;
  issues: D1SchemaCompatibilityIssue[];
  schemaVersion: number | null;
}

export const D1_DATA_PLANE_SCHEMA_VERSION = 3;
const SCHEMA_VERSION_TABLE = "worlds_data_plane_schema";

const REQUIRED_COLUMNS: Record<string, string[]> = {
  quads: [
    "quad_id",
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
    "chunk_id",
    "quad_id",
    "subject",
    "predicate",
    "graph",
    "value",
    "fts_value",
    "vector",
  ],
};

const REQUIRED_PRIMARY_KEYS: Record<string, string> = {
  [SCHEMA_VERSION_TABLE]: "schema_version_id",
  quads: "quad_id",
  chunks: "chunk_id",
};

/** Inspect the actual D1 schema and report missing required tables or columns. */
export async function checkD1SchemaCompatibility(
  connection: D1ConnectionDriver,
  options: { worldId?: string } = {},
): Promise<D1SchemaCompatibilityReport> {
  const issues: D1SchemaCompatibilityIssue[] = [];
  let schemaVersion: number | null = null;
  const versionTableResult = await connection.execute<{ name: string }>({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [SCHEMA_VERSION_TABLE],
  });
  if (versionTableResult.rows.length === 0) {
    issues.push({
      table: SCHEMA_VERSION_TABLE,
      detail: "missing schema version table",
    });
  } else {
    const versionTableInfo = await connection.execute<{
      name: string;
      pk: number;
    }>({
      sql: `PRAGMA table_info(${SCHEMA_VERSION_TABLE})`,
    });
    const versionColumns = new Set(
      versionTableInfo.rows.map((column) => column.name),
    );
    for (const column of ["schema_version_id", "version", "applied_at"]) {
      if (!versionColumns.has(column)) {
        issues.push({
          table: SCHEMA_VERSION_TABLE,
          detail: `missing column ${column}`,
        });
      }
    }
    const versionPrimaryKeys = versionTableInfo.rows.filter(
      (column) => Number(column.pk) > 0,
    );
    if (
      versionPrimaryKeys.length !== 1 ||
      versionPrimaryKeys[0]?.name !==
        REQUIRED_PRIMARY_KEYS[SCHEMA_VERSION_TABLE]
    ) {
      const found = versionPrimaryKeys.map((column) =>
        column.name
      ).join(", ") ||
        "none";
      issues.push({
        table: SCHEMA_VERSION_TABLE,
        detail: `expected primary key ${
          REQUIRED_PRIMARY_KEYS[SCHEMA_VERSION_TABLE]
        }, found ${found}`,
      });
    }
    if (versionColumns.has("version")) {
      const versionResult = await connection.execute<{ version: number }>({
        sql:
          `SELECT version FROM ${SCHEMA_VERSION_TABLE} ORDER BY version DESC LIMIT 1`,
      });
      schemaVersion = versionResult.rows[0]?.version == null
        ? null
        : Number(versionResult.rows[0].version);
    }
  }
  if (
    schemaVersion !== null && schemaVersion !== D1_DATA_PLANE_SCHEMA_VERSION
  ) {
    issues.push({
      table: SCHEMA_VERSION_TABLE,
      detail:
        `expected schema version ${D1_DATA_PLANE_SCHEMA_VERSION}, found ${schemaVersion}`,
    });
  }
  const requiredColumns = Object.fromEntries(
    Object.entries(REQUIRED_COLUMNS).map(([table, columns]) => [
      table,
      options.worldId ? [...columns, "world_id"] : columns,
    ]),
  );
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const tableResult = await connection.execute<{ name: string }>({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: [table],
    });
    if (tableResult.rows.length === 0) {
      issues.push({ table, detail: "missing table" });
      continue;
    }

    const columnResult = await connection.execute<{
      name: string;
      pk: number;
    }>({
      sql: `PRAGMA table_info(${table})`,
    });
    const actual = new Set(columnResult.rows.map((row) => row.name));
    for (const column of columns) {
      if (!actual.has(column)) {
        issues.push({ table, detail: `missing column ${column}` });
      }
    }
    const primaryKeys = columnResult.rows.filter(
      (column) => Number(column.pk) > 0,
    );
    const expectedPrimaryKey = REQUIRED_PRIMARY_KEYS[table];
    if (
      primaryKeys.length !== 1 ||
      primaryKeys[0]?.name !== expectedPrimaryKey
    ) {
      const found = primaryKeys.map((column) => column.name).join(", ") ||
        "none";
      issues.push({
        table,
        detail: `expected primary key ${expectedPrimaryKey}, found ${found}`,
      });
    }
  }
  return { compatible: issues.length === 0, issues, schemaVersion };
}

/** Validate the schema and throw an actionable error before serving traffic. */
export async function assertD1SchemaCompatible(
  connection: D1ConnectionDriver,
  options: { worldId?: string } = {},
): Promise<void> {
  const report = await checkD1SchemaCompatibility(connection, options);
  if (!report.compatible) {
    const issues = report.issues
      .map((issue) => `${issue.table}: ${issue.detail}`)
      .join(", ");
    throw new Error(
      `D1 schema is incompatible with @worlds/cloudflare: ${issues}. ` +
        `Automatic schema creation is not an in-place migration. Apply the ` +
        `documented clean reset before serving traffic.`,
    );
  }
}
