import type { ActiveLevel } from "./levels";

const bigIntSafeReplacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

export const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
};

export function colorize(
  level: ActiveLevel,
  text: string,
  supportsColor: boolean,
) {
  if (!supportsColor) return text;
  switch (level) {
    case "debug":
      return `${ANSI.gray}${text}${ANSI.reset}`;
    case "info":
      return `${ANSI.cyan}${text}${ANSI.reset}`;
    case "warn":
      return `${ANSI.yellow}${text}${ANSI.reset}`;
    case "error":
      return `${ANSI.red}${text}${ANSI.reset}`;
  }
}

export function formatDevLine(
  level: ActiveLevel,
  payload: any,
  supportsColor: boolean,
) {
  const ts = new Date(payload.timestamp || Date.now()).toISOString();
  const levelTag = (level.toUpperCase() as string).padEnd(5);
  const base = `${supportsColor ? ANSI.dim : ""}${ts}${supportsColor ? ANSI.reset : ""} ${colorize(level, levelTag, supportsColor)} ${supportsColor ? ANSI.bold : ""}[${payload.module}]${supportsColor ? ANSI.reset : ""} ${payload.message}`;
  const ctx = payload.context || {};
  const hasCtx = ctx && typeof ctx === "object" && Object.keys(ctx).length > 0;
  if (!hasCtx) return base;
  const prettyCtx = JSON.stringify(ctx, bigIntSafeReplacer, 2);
  const indented = prettyCtx
    .split("\n")
    .map((l: string) => `  ${l}`)
    .join("\n");
  return `${base}\n${indented}`;
}
