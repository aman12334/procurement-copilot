/**
 * GET /api/event/file?vendor_id=VND-1001&name=<file name> – open a vendor's response document from the comparison.
 * Only files registered for that vendor (server-side registry) can be served; never arbitrary paths.
 */
import { loadEventContext } from "@/lib/event/context";
import { readEventFile } from "@/lib/event/files";

export const runtime = "nodejs";

const TYPES: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", txt: "text/plain; charset=utf-8", eml: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export async function GET(req: Request) {
  const u = new URL(req.url);
  const vendorId = u.searchParams.get("vendor_id") ?? "";
  const name = u.searchParams.get("name") ?? "";
  const ctx = await loadEventContext();
  const v = ctx.vendors.find((x) => x.vendor_id === vendorId);
  const ref = v && [...v.response_files, ...(v.alternate_files ?? [])].find((f) => f.split("/").pop() === name);
  if (!ref) return Response.json({ ok: false, error: { code: "NOT_FOUND", message: "Not a registered response file for this vendor." } }, { status: 404 });
  const ext = name.split(".").pop()!.toLowerCase();
  const inline = ["pdf", "png", "jpg", "jpeg", "txt", "eml"].includes(ext);
  return new Response(new Uint8Array(await readEventFile(ref)), { headers: {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/"/g, "")}"`,
    // Vendor HTML is downloaded (never rendered) and sandboxed, so vendor markup cannot run in the app origin.
    "X-Content-Type-Options": "nosniff", ...(ext === "html" ? { "Content-Security-Policy": "sandbox" } : {}),
  } });
}
