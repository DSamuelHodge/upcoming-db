import { createClient } from "@libsql/client";
import { Table, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

// Compares a live LibSQL/Turso instance against the canonical Drizzle schema
// (schema.ts). Asserts every table and named index in schema.ts exists on the
// instance; extra objects on the instance are reported as warnings only.
// Exits 0 with a skip notice when no instance URL is configured, so the
// scheduled CI job stays green for contributors without secrets.

const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;

function isLibsqlInstance(value: string | undefined): value is string {
  if (!value) return false;
  return value.startsWith("http://") || value.startsWith("https://") || value.startsWith("libsql://");
}

function expectedObjects(): { tables: string[]; indexes: string[] } {
  const tables: string[] = [];
  const indexes: string[] = [];
  for (const value of Object.values(schema)) {
    if (!(value instanceof Table)) continue;
    const name = getTableName(value);
    if (name.startsWith("sqlite_")) continue;
    tables.push(name);
    for (const idx of getTableConfig(value).indexes) {
      const idxName = idx.config.name;
      // UNIQUE column constraints create unnamed sqlite_autoindex_* entries;
      // only named indexes are enforceable across copies of the schema.
      if (idxName && !idxName.startsWith("sqlite_")) indexes.push(idxName);
    }
  }
  return { tables: tables.sort(), indexes: indexes.sort() };
}

async function main(): Promise<void> {
  if (!isLibsqlInstance(url)) {
    console.log("check-schema-drift: no LIBSQL_URL/TURSO_DATABASE_URL configured; skipping.");
    return;
  }

  const client = createClient(
    process.env.TURSO_AUTH_TOKEN ? { url, authToken: process.env.TURSO_AUTH_TOKEN } : { url }
  );
  try {
    const liveTables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%'"
    );
    const liveIndexes = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'"
    );
    const liveTableNames = new Set(liveTables.rows.map((r) => String(r.name)));
    const liveIndexNames = new Set(liveIndexes.rows.map((r) => String(r.name)));

    const { tables, indexes } = expectedObjects();

    const missingTables = tables.filter((t) => !liveTableNames.has(t));
    const missingIndexes = indexes.filter((i) => !liveIndexNames.has(i));
    const extraTables = [...liveTableNames].filter((t) => !tables.includes(t));
    const extraIndexes = [...liveIndexNames].filter((i) => !indexes.includes(i));

    for (const t of missingTables) console.error(`MISSING table: ${t}`);
    for (const i of missingIndexes) console.error(`MISSING index: ${i}`);
    for (const t of extraTables) console.warn(`extra table on instance (informational): ${t}`);
    for (const i of extraIndexes) console.warn(`extra index on instance (informational): ${i}`);

    if (missingTables.length > 0 || missingIndexes.length > 0) {
      throw new Error(
        `schema drift detected: ${missingTables.length} missing table(s), ${missingIndexes.length} missing index(es). Re-run \`npm run schema:apply\` against this instance.`
      );
    }
    console.log(
      `check-schema-drift: OK — ${tables.length} tables, ${indexes.length} indexes from schema.ts all present on ${url}`
    );
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
