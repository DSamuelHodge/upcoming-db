import { defineConfig } from "drizzle-kit";

const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || "http://127.0.0.1:8080";

if (url.startsWith("file:") || url.startsWith("sqlite:")) {
  throw new Error("drizzle-kit must target a LibSQL/Turso instance, not a SQLite file URL");
}

export default defineConfig({
  schema: "./schema.ts",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: {
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
});
