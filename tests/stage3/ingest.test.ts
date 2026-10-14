import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectSourceType, ingestFile, UnsupportedFormatError } from "@/lib/bids/ingest";

const f = (p: string) => ({ name: p.split("/").pop()!, data: readFileSync(p) });

describe("ingestion of the five Stage 1 formats", () => {
  it("(1) Excel: sheets, rows and cell notes via a real XLSX parser", async () => {
    const d = await ingestFile(f("stage1/vendors/vendor_1/Deccan_Corrupack_Quotation_SCPL_RFQ014.xlsx"));
    expect(d.source_type).toBe("xlsx");
    expect(d.stats).toMatchObject({ sheets: 3, cell_notes: 2 });
    expect(d.text).toContain('=== Sheet "Quotation"');
    expect(d.text).toMatch(/CP-018 .*\(incl\. tear strip\)/);
    expect(d.text).toContain("[cell note on I15: Litho lamination");
    expect(d.attachments).toHaveLength(0);
    expect(d.chunks.some((c) => c.location.startsWith('Sheet "Tech Questionnaire"'))).toBe(true);
  });

  it("(2) PDF: native PDF attachment for the model plus page-level text evidence", async () => {
    const d = await ingestFile(f("stage1/vendors/vendor_2/Shree_Ganesh_Packwell_Quotation_SGP-Q-2026-1187.pdf"));
    expect(d.source_type).toBe("pdf");
    expect(d.stats.pages).toBe(3);
    expect(d.attachments[0].mimeType).toBe("application/pdf");
    const footnote = d.chunks.find((c) => c.text.includes("freight extra at actuals"));
    expect(footnote?.page).toBe(2);
  });

  it("(3) DOCX: paragraphs, headings and tables", async () => {
    const d = await ingestFile(f("stage1/vendors/vendor_3/Indus_Fibreboard_Offer_SCPL_RFQ014.docx"));
    expect(d.source_type).toBe("docx");
    expect(d.stats.tables).toBe(3);
    expect(d.text).toContain("## 2. Export-grade cartons");
    expect(d.text).toMatch(/\| CP-014 \| 5 Ply Heavy Duty RSC \(BF 22\) \| 450 x 350 x 300/);
    expect(d.chunks.some((c) => c.text.includes("valid until 31 December 2026"))).toBe(true);
  });

  it("(4) image: passed natively (downscaled JPEG) for vision extraction", async () => {
    const d = await ingestFile(f("stage1/images/vendor_4_rate_card_angled.png"));
    expect(d.source_type).toBe("image");
    expect(d.attachments[0].mimeType).toBe("image/jpeg");
    expect(d.stats.sent_bytes).toBeLessThan(d.stats.original_bytes);
    expect(Math.max(d.stats.width, d.stats.height)).toBeGreaterThan(1000);
  });

  it("(5) email: raw text preserved with line numbers as evidence", async () => {
    const d = await ingestFile(f("stage1/vendors/vendor_5/Godavari_Packaging_email_response.txt"));
    expect(d.source_type).toBe("email");
    expect(d.text).toMatch(/L\d+: For the trays and inserts we are already supplying to your Hyderabad plant, remaining items same as last year's pricing\./);
    expect(d.chunks.some((c) => c.text.includes("same as last year's pricing"))).toBe(true);
  });

  it("rejects unsupported formats", () => {
    expect(() => detectSourceType("quote.exe")).toThrow(UnsupportedFormatError);
  });
});
