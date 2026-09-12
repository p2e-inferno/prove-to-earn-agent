export type LogLevelName = "debug" | "info" | "warn" | "error" | "silent";
export type ActiveLevel = Exclude<LogLevelName, "silent">;

export const LEVEL_ORDER: Record<ActiveLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const isBrowser = typeof window !== "undefined";
export const nodeEnv = process.env.NODE_ENV || "development";

export function parseEnvLogLevel(): LogLevelName {
  const raw =
    (isBrowser ? process.env.NEXT_PUBLIC_LOG_LEVEL : process.env.LOG_LEVEL) ||
    "";
  const val = raw.toLowerCase() as LogLevelName;
  if (
    val === "debug" ||
    val === "info" ||
    val === "warn" ||
    val === "error" ||
    val === "silent"
  )
    return val;
  return nodeEnv === "development" ? "debug" : "silent";
}

export function shouldLog(level: ActiveLevel, current: LogLevelName): boolean {
  if (current === "silent") return false;
  return LEVEL_ORDER[level] >= LEVEL_ORDER[current as ActiveLevel];
}
