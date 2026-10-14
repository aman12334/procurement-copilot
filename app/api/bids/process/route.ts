/**
 * POST /api/bids/process – run the Bid Processing Agent for one vendor.
 * Body: { vendor_id, files?: string[] }               → process the vendor's stored response (or a listed alternate)
 *    or { vendor_id, upload: [{ name, data_base64 }] } → process an uploaded response
 */
import { z } from "zod";
import { processVendorResponse } from "@/lib/bids/agent";
import { detectSourceType, UnsupportedFormatError, type InputFile } from "@/lib/bids/ingest";
import { readEventFile } from "@/lib/event/files";
import { EventPayloadSchema, MAX_UPLOAD_BYTES, badRequest, clientOrError, findVendor, resolveContext, statusFor } from "@/lib/server/bids";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  event: EventPayloadSchema,
  vendor_id: z.string(),
  files: z.array(z.string()).optional(),
  upload: z.array(z.object({ name: z.string().min(1).max(200), data_base64: z.string() })).max(5).optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid request.", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const ctx = await resolveContext(parsed.data.event);
  const vendor = findVendor(ctx, parsed.data.vendor_id);
  if (!vendor) return badRequest(`Unknown vendor ${parsed.data.vendor_id}`);

  let files: InputFile[];
  try {
    if (parsed.data.upload?.length) {
      files = parsed.data.upload.map((u) => {
        detectSourceType(u.name);
        const data = Buffer.from(u.data_base64, "base64");
        if (data.length > MAX_UPLOAD_BYTES) throw new UnsupportedFormatError(`${u.name} is larger than 4 MB.`);
        return { name: u.name.replace(/[^\w.\- ]+/g, "_"), data };
      });
    } else {
      // Only the vendor's own registered response files may be read – never arbitrary paths.
      const allowed = [...vendor.response_files, ...(vendor.alternate_files ?? [])];
      const wanted = parsed.data.files?.length ? parsed.data.files : vendor.response_files.map((f) => f.split("/").pop()!);
      const paths = wanted.map((w) => allowed.find((a) => a.split("/").pop() === w));
      if (paths.some((p) => !p)) return badRequest(`File not registered for ${vendor.vendor_id}: ${wanted.join(", ")}`);
      files = await Promise.all(paths.map(async (p) => ({ name: p!.split("/").pop()!, data: await readEventFile(p!) })));
    }
  } catch (e) {
    return badRequest((e as Error).message);
  }

  const c = clientOrError();
  if ("error" in c) return c.error;
  const result = await processVendorResponse(c.client, ctx, vendor, files);
  return Response.json(result, { status: result.ok ? 200 : statusFor(result.error.code) });
}
