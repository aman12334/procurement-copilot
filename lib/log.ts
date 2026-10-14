/** Structured server logs. Never pass secrets in `data`; keys named like secrets are redacted anyway. */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET = /key|token|secret|password/i;

function redact(v: unknown, depth = 0): unknown {
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET.test(k) && typeof x === "string" ? "[redacted]" : redact(x, depth + 1)]),
  );
}

export function log(level: Level, event: string, data: Record<string, unknown> = {}) {
  const min = (process.env.RFX_LOG_LEVEL as Level) || "info";
  if (process.env.VITEST && !process.env.RFX_LOG_IN_TESTS) return;
  if (ORDER[level] < (ORDER[min] ?? 20)) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(data) as object) });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export const truncate = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n} chars]` : s);
