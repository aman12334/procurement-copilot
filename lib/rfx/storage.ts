/**
 * Draft persistence. Uses a minimal key-value interface so it works with browser
 * localStorage (Vercel-friendly, no server filesystem) and an in-memory store in tests.
 */
import { RfxDraftSchema, type RfxDraft } from "./schema";

export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const INDEX_KEY = "rfx.drafts.index";
const draftKey = (id: string) => `rfx.draft.${id}`;

export interface SavedDraftMeta {
  draft_id: string;
  title: string;
  saved_at: string;
}

export interface SavedDraft extends SavedDraftMeta {
  rfx: RfxDraft;
  conversation?: { role: "buyer" | "agent"; text: string }[];
}

function readIndex(store: KVStore): SavedDraftMeta[] {
  try {
    return JSON.parse(store.getItem(INDEX_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveDraft(store: KVStore, draft: Omit<SavedDraft, "saved_at">, now = new Date()): SavedDraftMeta {
  const record: SavedDraft = { ...draft, saved_at: now.toISOString() };
  store.setItem(draftKey(draft.draft_id), JSON.stringify(record));
  const meta = { draft_id: draft.draft_id, title: draft.title, saved_at: record.saved_at };
  const index = readIndex(store).filter((m) => m.draft_id !== draft.draft_id);
  store.setItem(INDEX_KEY, JSON.stringify([meta, ...index]));
  return meta;
}

/** Loads and re-validates a draft; returns null if missing or no longer schema-valid. */
export function loadDraft(store: KVStore, draftId: string): SavedDraft | null {
  const raw = store.getItem(draftKey(draftId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SavedDraft;
    const rfx = RfxDraftSchema.safeParse(parsed.rfx);
    return rfx.success ? { ...parsed, rfx: rfx.data } : null;
  } catch {
    return null;
  }
}

export function listDrafts(store: KVStore): SavedDraftMeta[] {
  return readIndex(store);
}

export function deleteDraft(store: KVStore, draftId: string): void {
  store.removeItem(draftKey(draftId));
  store.setItem(INDEX_KEY, JSON.stringify(readIndex(store).filter((m) => m.draft_id !== draftId)));
}

export class MemoryStore implements KVStore {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
