/**
 * Import line items from a CSV in the Stage 1 rfx_master.csv format (same column names),
 * so a buyer's SKU spreadsheet can replace model-generated template lines.
 */
import { LineItemSchema, type LineItem } from "./schema";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

const num = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : Number(v.replace(/,/g, "")));
const str = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : v.trim());

export function lineItemsFromCsv(text: string, category = "Corrugated packaging"): { items: LineItem[]; errors: string[] } {
  const [header, ...rows] = parseCsv(text);
  if (!header) return { items: [], errors: ["CSV is empty"] };
  const idx = (name: string) => header.indexOf(name);
  const errors: string[] = [];
  for (const required of ["line_id", "item_description"])
    if (idx(required) < 0) errors.push(`Missing column "${required}"`);
  if (errors.length) return { items: [], errors };
  const get = (r: string[], name: string) => (idx(name) >= 0 ? r[idx(name)] : undefined);
  const items: LineItem[] = [];
  rows.forEach((r, n) => {
    const known = new Set(["line_id", "sku", "item_description", "category", "style", "ply", "flute", "dimensions_text", "dimension_basis",
      "board_construction", "combined_board_gsm", "min_bursting_factor_outer_liner", "min_bursting_strength_kg_cm2",
      "recycled_content_min_pct", "printing", "coating", "annual_qty", "uom", "delivery_plant", "end_use", "notes"]);
    const extra = header.map((h, i) => ({ name: h, value: r[i] ?? "" })).filter((s) => !known.has(s.name) && s.value.trim() !== "");
    const candidate = {
      line_id: get(r, "line_id")?.trim() ?? "",
      sku: str(get(r, "sku")),
      item_description: get(r, "item_description")?.trim() ?? "",
      category: str(get(r, "category")) ?? category,
      style: str(get(r, "style")),
      ply: num(get(r, "ply")),
      flute: str(get(r, "flute")),
      dimensions_text: str(get(r, "dimensions_text")),
      dimension_basis: str(get(r, "dimension_basis")),
      board_construction: str(get(r, "board_construction")),
      combined_board_gsm: num(get(r, "combined_board_gsm")),
      min_bursting_factor_outer_liner: num(get(r, "min_bursting_factor_outer_liner")),
      min_bursting_strength_kg_cm2: num(get(r, "min_bursting_strength_kg_cm2")),
      recycled_content_min_pct: num(get(r, "recycled_content_min_pct")),
      printing: str(get(r, "printing")),
      coating: str(get(r, "coating")),
      annual_qty: num(get(r, "annual_qty")),
      uom: str(get(r, "uom")) ?? "piece",
      delivery_plant: str(get(r, "delivery_plant")),
      end_use: str(get(r, "end_use")),
      notes: str(get(r, "notes")),
      additional_specs: extra,
      source: "explicit" as const,
    };
    const parsed = LineItemSchema.safeParse(candidate);
    if (parsed.success) items.push(parsed.data);
    else errors.push(`Row ${n + 2}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  });
  return { items, errors };
}
