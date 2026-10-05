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

export const D1_DATA_PLANE_SCHEMA_VERSION = 4;
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
  if (versionTableResult.rows.length > 0) {
    const versionResult = await connection.execute<{ version: number }>({
      sql:
        `SELECT version FROM ${SCHEMA_VERSION_TABLE} ORDER BY version DESC LIMIT 1`,
    });
    schemaVersion = versionResult.rows[0]?.version == null
      ? null
      : Number(versionResult.rows[0].version);
  } else {
    issues.push({
      table: SCHEMA_VERSION_TABLE,
      detail: "missing schema version table",
    });
  }
  if (versionTableResult.rows.length > 0) {
    const versionColumns = await connection.execute<{
      name: string;
      pk: number;
    }>({
      sql: `PRAGMA table_info(${SCHEMA_VERSION_TABLE})`,
    });
    const primaryKeys = versionColumns.rows.filter((row) => row.pk > 0);
    if (
      primaryKeys.length !== 1 ||
      primaryKeys[0]?.name !== "schema_version_id"
    ) {
      issues.push({
        table: SCHEMA_VERSION_TABLE,
        detail: `primary key must be schema_version_id, found ${
          primaryKeys.map((row) => row.name).join(", ") || "none"
        }`,
      });
    }
  }
  if (
    schemaVersion !== null && schemaVersion !== D1_DATA_PLANE_SCHEMA_VERSION
  ) {
    issues.push({
      table: SCHEMA_VERSION_TABLE,
      detail: `expected schema version ${D1_DATA_PLANE_SCHEMA_VERSION}, found ${
        schemaVersion ?? "none"
      }`,
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
    if (actual.has("world_uid")) {
      issues.push({ table, detail: "legacy world_uid column remains" });
    }
    const expectedPrimaryKey = table === "quads" ? "quad_id" : "chunk_id";
    const primaryKeys = columnResult.rows.filter((row) => row.pk > 0);
    if (
      primaryKeys.length !== 1 ||
      primaryKeys[0]?.name !== expectedPrimaryKey
    ) {
      issues.push({
        table,
        detail: `primary key must be ${expectedPrimaryKey}, found ${
          primaryKeys.map((row) => row.name).join(", ") || "none"
        }`,
      });
    }
    if (actual.has("id")) {
      issues.push({ table, detail: "legacy id column remains" });
    }
    for (const column of columns) {
      if (!actual.has(column)) {
        issues.push({ table, detail: `missing column ${column}` });
      }
    }
  }

  const ftsTableResult = await connection.execute<{ sql: string }>({
    sql:
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'",
  });
  const ftsSql = ftsTableResult.rows[0]?.sql;
  if (!ftsSql) {
    issues.push({ table: "chunks_fts", detail: "missing table" });
  }
  const ftsColumnResult = await connection.execute<{ name: string }>({
    sql: "PRAGMA table_info(chunks_fts)",
  });
  const ftsColumns = new Set(ftsColumnResult.rows.map((row) => row.name));
  if (!ftsColumns.has("fts_value")) {
    issues.push({ table: "chunks_fts", detail: "missing column fts_value" });
  }
  if (ftsColumns.has("world_uid")) {
    issues.push({
      table: "chunks_fts",
      detail: "legacy world_uid column remains",
    });
  }
  if (ftsColumns.has("quad_id")) {
    issues.push({
      table: "chunks_fts",
      detail: "redundant quad_id column remains",
    });
  }
  const normalizedFtsSql = (ftsSql ?? "").replaceAll(/\s+/g, "").toLowerCase();
  if (
    !normalizedFtsSql.includes("content='chunks'") ||
    !normalizedFtsSql.includes("content_rowid='chunk_id'") ||
    ftsColumns.size !== 1
  ) {
    issues.push({
      table: "chunks_fts",
      detail: "not canonical external-content FTS5 schema",
    });
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
    throw new Error(
      `D1 schema is incompatible with @worlds/cloudflare: ${
        report.issues.map((issue) => `${issue.table}: ${issue.detail}`).join(
          ", ",
        )
      }`,
    );
  }
}
