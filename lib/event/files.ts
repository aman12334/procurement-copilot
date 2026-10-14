/**
 * The ONLY way runtime code reads sourcing-event files from disk.
 * Runtime may read the buyer's RFx files and vendor-facing responses – never the
 * offline evaluation truth or the dataset generator.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export const ALLOWED_EVENT_DIRS = ["stage1/buyer", "stage1/vendors", "stage1/images", "data/event"] as const;
// Offline-evaluation-only folders. Runtime access is refused even if requested explicitly.
const FORBIDDEN_DIRS = ["stage1/ground" + "_truth", "stage1/_" + "build"];

export class ForbiddenPathError extends Error {}

export function resolveEventPath(rel: string): string {
  const norm = path.posix.normalize(rel.replace(/\\/g, "/")).replace(/^\.\//, "");
  if (path.isAbsolute(norm) || norm.startsWith("..")) throw new ForbiddenPathError(`Path escapes the project: ${rel}`);
  if (FORBIDDEN_DIRS.some((d) => norm === d || norm.startsWith(d + "/")))
    throw new ForbiddenPathError(`Runtime access to offline evaluation data is not allowed: ${rel}`);
  if (!ALLOWED_EVENT_DIRS.some((d) => norm.startsWith(d + "/")))
    throw new ForbiddenPathError(`Path is outside the sourcing-event folders: ${rel}`);
  // Files are shipped via next.config outputFileTracingIncludes; ignore here so the bundler does not trace the whole project.
  return path.join(/*turbopackIgnore: true*/ process.cwd(), norm);
}

export async function readEventFile(rel: string): Promise<Buffer> {
  return readFile(resolveEventPath(rel));
}

export async function readEventText(rel: string): Promise<string> {
  return (await readEventFile(rel)).toString("utf8");
}
