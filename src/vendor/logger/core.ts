import {
  isBrowser,
  nodeEnv,
  parseEnvLogLevel,
  shouldLog,
  type LogLevelName,
  type ActiveLevel,
} from "./levels";
import { sanitizeString, sanitizeValue } from "./sanitize";
import { defaultTransport, writeLine, type TransportFn } from "./transport";

export interface AppLogger {
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

let currentLevel: LogLevelName = parseEnvLogLevel();
let transport: TransportFn = defaultTransport;

export function setLogLevel(level: LogLevelName) {
  currentLevel = level;
}

export function setLoggerTransport(fn: TransportFn) {
  transport = fn;
}

export function getLogger(moduleName: string): AppLogger {
  const base = { module: moduleName };

  const emit = (level: ActiveLevel, ...args: any[]) => {
    if (!shouldLog(level, currentLevel)) return;

    const [first, ...rest] = args;
    const isStringMessage = typeof first === "string";
    const message = isStringMessage ? (first as string) : "[log]";
    const rawContext = isStringMessage
      ? rest.length === 0
        ? undefined
        : rest.length === 1
          ? rest[0]
          : rest
      : typeof first !== "undefined"
        ? rest.length
          ? [first, ...rest]
          : first
        : undefined;

    const payload = {
      timestamp: new Date().toISOString(),
      level,
      ...base,
      message: sanitizeString(message),
      context: sanitizeValue(rawContext ?? {}),
      environment: nodeEnv,
      runtime: isBrowser ? "browser" : "server",
    };

    try {
      transport(level, payload);
    } catch (e) {
      try {
        writeLine("stderr", "[logger] transport failure", e as any);
      } catch {}
    }
  };

  return {
    debug: (...args) => emit("debug", ...args),
    info: (...args) => emit("info", ...args),
    warn: (...args) => emit("warn", ...args),
    error: (...args) => emit("error", ...args),
  };
}

export const appLogger = getLogger("app");
