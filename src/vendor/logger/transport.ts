import { isBrowser, nodeEnv } from "./levels";
import type { ActiveLevel } from "./levels";
import { formatDevLine } from "./formatting";

const bigIntSafeReplacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

export function writeLine(
  stream: "stdout" | "stderr",
  text: string,
  ctx?: any,
) {
  if (isBrowser) {
    try {
      (window as any).__P2E_LOGS__ = (window as any).__P2E_LOGS__ || [];
      (window as any).__P2E_LOGS__.push({ text, ctx });
    } catch {}
    return;
  }
  try {
    const proc: any = (globalThis as any)?.["process"];
    const out = stream === "stderr" ? proc?.stderr : proc?.stdout;
    if (!out || typeof out.write !== "function") return;
    const suffix =
      ctx && Object.keys(ctx || {}).length
        ? ` ${JSON.stringify(ctx, bigIntSafeReplacer)}`
        : "";
    out.write(`${text}${suffix}\n`);
  } catch {}
}

export type TransportFn = (level: ActiveLevel, payload: any) => void;

export const defaultTransport: TransportFn = (level, payload) => {
  if (nodeEnv === "development") {
    const proc: any = (globalThis as any)?.["process"];
    const supportsColor = !!proc?.stdout?.isTTY;
    const line = formatDevLine(level, payload, supportsColor);
    if (level === "warn" || level === "error") writeLine("stderr", line);
    else writeLine("stdout", line);
  } else {
    writeLine("stdout", JSON.stringify(payload, bigIntSafeReplacer));
  }
};
