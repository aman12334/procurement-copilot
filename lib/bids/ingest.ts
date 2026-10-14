/**
 * INGEST: format-specific parsing (deterministic). Produces
 *  - a structured text representation passed to the model,
 *  - native attachments (PDF document understanding, image vision),
 *  - document chunks used later for evidence retrieval (RAG).
 */
import mammoth from "mammoth";
import type { Attachment } from "@/lib/ai/client";
import type { DocumentChunk } from "./schema";

export type SourceType = "xlsx" | "pdf" | "docx" | "image" | "email";

export interface InputFile {
  name: string;
  data: Buffer;
}

export interface IngestedDocument {
  source_file: string;
  source_type: SourceType;
  text: string;
  attachments: Attachment[];
  chunks: Omit<DocumentChunk, "vendor_id" | "chunk_id">[];
  stats: Record<string, number>;
}

export class UnsupportedFormatError extends Error {}

export function detectSourceType(name: string): SourceType {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["xlsx", "xlsm"].includes(ext)) return "xlsx";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return "image";
  if (["txt", "eml", "md", "text"].includes(ext)) return "email";
  throw new UnsupportedFormatError(`Unsupported file type ".${ext}" (${name}). Supported: xlsx, pdf, docx, png/jpg, txt/eml.`);
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------ XLSX
export async function ingestXlsx(file: InputFile): Promise<IngestedDocument> {
  const XLSX = await import("xlsx");
  // cellFormula keeps formulas; cell.v holds the cached result; cell.c holds cell comments/notes.
  const wb = XLSX.read(file.data, { type: "buffer", cellFormula: true, cellNF: false, cellDates: true });
  const out: string[] = [];
  const chunks: IngestedDocument["chunks"] = [];
  let rows = 0, notes = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    out.push(`=== Sheet "${name}" (rows ${range.s.r + 1}-${range.e.r + 1}) ===`);
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cells: string[] = [];
      const rowNotes: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr] as { v?: unknown; f?: string; w?: string; c?: { t?: string }[] } | undefined;
        if (!cell) continue;
        const v = cell.v instanceof Date ? cell.v.toISOString().slice(0, 10) : cell.v;
        const t = clean(v === undefined || v === null ? "" : String(v));
        if (t) cells.push(`${XLSX.utils.encode_col(c)}: ${t}${cell.f ? ` (formula =${cell.f})` : ""}`);
        if (cell.c?.length) rowNotes.push(`[cell note on ${addr}: ${clean(cell.c.map((n) => n.t ?? "").join(" "))}]`);
      }
      if (!cells.length && !rowNotes.length) continue;
      rows++;
      notes += rowNotes.length;
      const body = `${cells.join(" | ")}${rowNotes.length ? " " + rowNotes.join(" ") : ""}`;
      out.push(`R${r + 1} | ${body}`);
      chunks.push({ source_file: file.name, location: `Sheet "${name}" row ${r + 1}`, page: null, kind: "document", text: body });
    }
  }
  return { source_file: file.name, source_type: "xlsx", text: out.join("\n"), attachments: [], chunks, stats: { sheets: wb.SheetNames.length, rows, cell_notes: notes } };
}

// ------------------------------------------------------------------ DOCX
const decode = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

export async function ingestDocx(file: InputFile): Promise<IngestedDocument> {
  const { value: html } = await mammoth.convertToHtml({ buffer: file.data });
  const out: string[] = [];
  const chunks: IngestedDocument["chunks"] = [];
  let para = 0, tables = 0, heading = "";
  for (const m of html.matchAll(/<(h[1-6]|p|table)[^>]*>([\s\S]*?)<\/\1>/g)) {
    const [, tag, inner] = m;
    if (tag === "table") {
      tables++;
      const rows = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
        [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => clean(decode(c[1]))));
      out.push(`[Table ${tables}${heading ? ` under "${heading}"` : ""}]`);
      const header = rows[0] ?? [];
      rows.forEach((cells, i) => {
        out.push(`| ${cells.join(" | ")} |`);
        if (i > 0) {
          const text = header.length === cells.length ? cells.map((c, j) => `${header[j]}: ${c}`).join("; ") : cells.join(" | ");
          chunks.push({ source_file: file.name, location: `Table ${tables} row ${i}${heading ? ` (${heading})` : ""}`, page: null, kind: "document", text });
        }
      });
      out.push("");
    } else {
      const text = clean(decode(inner));
      if (!text) continue;
      if (tag.startsWith("h")) {
        heading = text;
        out.push(`## ${text}`);
      } else {
        para++;
        out.push(`[¶${para}] ${text}`);
        chunks.push({ source_file: file.name, location: `paragraph ${para}${heading ? ` (${heading})` : ""}`, page: null, kind: "document", text });
      }
    }
  }
  return { source_file: file.name, source_type: "docx", text: out.join("\n"), attachments: [], chunks, stats: { paragraphs: para, tables } };
}

// ------------------------------------------------------------------ PDF
export async function ingestPdf(file: InputFile): Promise<IngestedDocument> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(file.data));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = text as string[];
  const out: string[] = [];
  const chunks: IngestedDocument["chunks"] = [];
  pages.forEach((p, i) => {
    out.push(`=== Page ${i + 1} (text layer) ===\n${p.trim()}`);
    // Chunk each page into ~600-char windows on line boundaries for retrieval.
    let buf = "";
    for (const line of p.split(/\n/)) {
      if ((buf + line).length > 600 && buf) {
        chunks.push({ source_file: file.name, location: `page ${i + 1}`, page: i + 1, kind: "document", text: clean(buf) });
        buf = "";
      }
      buf += line + "\n";
    }
    if (buf.trim()) chunks.push({ source_file: file.name, location: `page ${i + 1}`, page: i + 1, kind: "document", text: clean(buf) });
  });
  return {
    source_file: file.name, source_type: "pdf", text: out.join("\n\n"),
    attachments: [{ name: file.name, mimeType: "application/pdf", dataBase64: file.data.toString("base64") }],
    chunks, stats: { pages: totalPages },
  };
}

// ------------------------------------------------------------------ image
const MAX_IMAGE_EDGE = 2400; // keeps phone photos legible while staying well under provider image limits

export async function ingestImage(file: InputFile): Promise<IngestedDocument> {
  const sharp = (await import("sharp")).default;
  const img = sharp(file.data, { failOn: "none" }).rotate(); // honour EXIF orientation, do not "fix" the photo otherwise
  const meta = await img.metadata();
  const jpeg = await img
    .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  return {
    source_file: file.name, source_type: "image", text: "(image attached – read it directly)",
    attachments: [{ name: file.name, mimeType: "image/jpeg", dataBase64: jpeg.toString("base64") }],
    chunks: [], // filled from the model's transcription after extraction
    stats: { width: meta.width ?? 0, height: meta.height ?? 0, original_bytes: file.data.length, sent_bytes: jpeg.length },
  };
}

// ------------------------------------------------------------------ email / text
export function ingestEmail(file: InputFile): IngestedDocument {
  const raw = file.data.toString("utf8").replace(/\r\n/g, "\n");
  const paras = raw.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const numbered = raw.split("\n").map((l, i) => `L${i + 1}: ${l}`).join("\n");
  return {
    source_file: file.name, source_type: "email", text: numbered, attachments: [],
    chunks: paras.map((p, i) => ({ source_file: file.name, location: `email paragraph ${i + 1}`, page: null, kind: "document" as const, text: clean(p) })),
    stats: { lines: raw.split("\n").length, paragraphs: paras.length },
  };
}

export async function ingestFile(file: InputFile): Promise<IngestedDocument> {
  switch (detectSourceType(file.name)) {
    case "xlsx": return ingestXlsx(file);
    case "docx": return ingestDocx(file);
    case "pdf": return ingestPdf(file);
    case "image": return ingestImage(file);
    case "email": return ingestEmail(file);
  }
}
