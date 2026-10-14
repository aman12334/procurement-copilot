"use client";
/** Horizontal bar chart (grouped) for analyst answers and the comparison page. Values arrive computed; this only draws. */
import type { ChartData } from "@/lib/analyst/charts";

export function formatChartValue(v: number | null, unit: ChartData["unit"]): string {
  if (v === null) return "—";
  if (unit === "inr") return v >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `₹${(v / 1e5).toFixed(1)} L` : `₹${Math.round(v).toLocaleString("en-IN")}`;
  if (unit === "inr_per_unit") return `₹${v.toFixed(2)}`;
  if (unit === "percent") return `${v > 0 ? "+" : ""}${v}%`;
  return String(v);
}

export function chartCsv(c: ChartData): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = [["group", "label", "value", "note"], ...c.groups.flatMap((g) => g.bars.map((b) => [g.label, b.label, b.value === null ? "" : String(b.value), b.note ?? ""]))];
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}

export function download(name: string, text: string, type = "text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function Chart({ c, exportable = true }: { c: ChartData; exportable?: boolean }) {
  const vals = c.groups.flatMap((g) => g.bars.map((b) => b.value)).filter((v): v is number => v !== null);
  const hasNeg = vals.some((v) => v < 0);
  const max = Math.max(...vals.map(Math.abs), c.threshold?.value ?? 0, 1);
  const LABEL = 64, VALUE = 92, ROW = 22, W = 560;
  const plot = W - LABEL - VALUE;
  const zero = hasNeg ? LABEL + plot / 2 : LABEL;
  const scale = (hasNeg ? plot / 2 : plot) / max;
  const rows = c.groups.flatMap((g) => [...(g.label ? [{ group: g.label }] : []), ...g.bars.map((b) => ({ bar: b }))]);
  const H = rows.length * ROW + 8;
  return (
    <figure className="chart">
      <figcaption>
        <strong>{c.title}</strong> <span className="hint">· computed from {c.source}</span>
        {exportable && <button className="btn small" style={{ marginLeft: 8 }} onClick={() => download(`${c.kind}.csv`, chartCsv(c))}>CSV</button>}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={c.title}>
        {rows.map((r, i) => {
          const y = i * ROW + 4;
          if ("group" in r) return <text key={i} x={0} y={y + 14} className="chart-group">{r.group}</text>;
          const b = r.bar!;
          const w = b.value === null ? 0 : Math.max(1, Math.abs(b.value) * scale);
          const x = b.value !== null && b.value < 0 ? zero - w : zero;
          const fill = b.highlight ? "var(--ok)" : b.label === "Hist." ? "var(--muted)" : "var(--accent)";
          return (
            <g key={i} opacity={b.muted ? 0.45 : 1}>
              <title>{`${b.label}: ${formatChartValue(b.value, c.unit)}${b.note ? ` – ${b.note}` : ""}`}</title>
              <text x={LABEL - 6} y={y + 14} textAnchor="end" className="chart-label">{b.label}</text>
              {b.value !== null && <rect x={x} y={y + 3} width={w} height={ROW - 8} rx={2} fill={fill} />}
              <text x={W - VALUE + 6} y={y + 14} className="chart-value">{formatChartValue(b.value, c.unit)}{b.note && b.value === null ? ` ${b.note}` : ""}</text>
            </g>
          );
        })}
        {hasNeg && <line x1={zero} x2={zero} y1={0} y2={H} stroke="var(--line)" />}
        {c.threshold && (
          <g>
            <line x1={zero + c.threshold.value * scale} x2={zero + c.threshold.value * scale} y1={0} y2={H} stroke="var(--err)" strokeDasharray="4 3" />
            <text x={zero + c.threshold.value * scale + 4} y={H - 2} className="chart-threshold">{c.threshold.label}</text>
          </g>
        )}
      </svg>
      {c.groups.some((g) => g.bars.some((b) => b.note && b.value !== null)) && (
        <div className="hint chart-notes">{c.groups.flatMap((g) => g.bars.filter((b) => b.note && b.value !== null && g.bars.length <= 8).map((b) => `${g.label ? g.label + " " : ""}${b.label}: ${b.note}`)).slice(0, 8).join(" · ")}</div>
      )}
    </figure>
  );
}
