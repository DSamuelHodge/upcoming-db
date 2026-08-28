type LogLevel = "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

/**
 * Minimal structured logger: one JSON object per line so downstream log
 * shippers can parse without regexes. CLI/ops scripts (apply-schema,
 * check-schema-drift) keep plain console output intentionally — this is for
 * runtime code.
 */
function emit(level: LogLevel, message: string, fields?: LogFields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields });
  if (level === "info") {
    console.log(line);
  } else {
    console.error(line);
  }
}

export const logInfo = (message: string, fields?: LogFields): void => emit("info", message, fields);
export const logWarn = (message: string, fields?: LogFields): void => emit("warn", message, fields);
export const logError = (message: string, fields?: LogFields): void => emit("error", message, fields);
