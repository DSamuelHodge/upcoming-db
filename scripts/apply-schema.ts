import { createClient } from "@libsql/client";
import { readSchemaSql, statementsFromSql } from "../src/schema-sql";

function requireLibsqlUrl(): string {
  const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
  if (!url) {
    throw new Error(
      "Set TURSO_DATABASE_URL (libsql://…turso.io) or LIBSQL_URL (http://host:port). SQLite file paths are rejected."
    );
  }
  if (url.startsWith("file:") || url.startsWith("sqlite:") || /\.db(\b|$)/.test(url)) {
    throw new Error(
      `Refusing SQLite file URL (${url}). Use a LibSQL/Turso instance: libsql://… or http(s)://…`
    );
  }
  return url;
}

const url = requireLibsqlUrl();
const authToken = process.env.TURSO_AUTH_TOKEN;
const client = createClient(authToken ? { url, authToken } : { url });

for (const stmt of statementsFromSql(readSchemaSql())) {
  await client.execute(stmt);
}

const tables = await client.execute(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' ORDER BY name"
);
const indexes = await client.execute(
  "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
);

console.log(`Applied schema.ts/schema.sql on LibSQL instance ${url}`);
console.log("tables:", tables.rows.map((r) => r.name).join(", "));
console.log("indexes:", indexes.rows.map((r) => r.name).join(", "));
await client.close();
