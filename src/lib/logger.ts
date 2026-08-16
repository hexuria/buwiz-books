import { reportError } from "./error-reporter";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LoggerMeta {
  [key: string]: unknown;
}

function normalizeMeta(meta: LoggerMeta | undefined): LoggerMeta | undefined {
  if (!meta) return undefined;

  const normalized: LoggerMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      normalized[key] = {
        message: value.message,
        stack: value.stack,
        name: value.name,
      };
      continue;
    }
    normalized[key] = value;
  }

  return normalized;
}

function emit(level: LogLevel, scope: string, message: string, meta?: LoggerMeta) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...normalizeMeta(meta),
  };

  const line = JSON.stringify(payload);
  switch (level) {
    case "debug":
      console.debug(line);
      break;
    case "info":
      console.info(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      // Forward errors to the pluggable error-tracking backend (no-op unless configured).
      reportError({ scope, message, meta: normalizeMeta(meta), timestamp: payload.ts });
      break;
  }
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, meta?: LoggerMeta) => emit("debug", scope, message, meta),
    info: (message: string, meta?: LoggerMeta) => emit("info", scope, message, meta),
    warn: (message: string, meta?: LoggerMeta) => emit("warn", scope, message, meta),
    error: (message: string, meta?: LoggerMeta) => emit("error", scope, message, meta),
  };
}
