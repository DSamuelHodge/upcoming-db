import { readFileSync } from "fs";

// Single loader for the applied schema artifact (schema.sql). Both the test
// harness (test-db.ts) and production apply (apply-schema.ts) go through
// this module so tests and prod run byte-identical DDL.

export function readSchemaSql(): string {
  return readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
}

// Splits on ";" while stripping whole-line "--" comments. Good enough for
// this schema file; if schema.sql ever grows procedural blocks or embedded
// semicolons in strings, replace with a real tokenizer.
export function statementsFromSql(sql: string): string[] {
  return sql
    .split(";")
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim()
    )
    .filter(Boolean);
}

export function schemaStatements(): string[] {
  return statementsFromSql(readSchemaSql());
}
