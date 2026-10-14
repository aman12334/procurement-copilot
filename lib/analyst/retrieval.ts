/**
 * Evidence retrieval (the "R" in RAG): BM25 over document chunks from every processed vendor response –
 * raw document text, image transcriptions, extracted term statements and questionnaire answers.
 * Deterministic and dependency-free (no embeddings service needed).
 */
import type { DocumentChunk } from "@/lib/bids/schema";

const STOP = new Set("a an the of to in for on and or is are was were be by with as at from that this it its our your we you do does did what which who why how".split(" "));

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[₹]/g, " inr ").split(/[^a-z0-9.\-]+/).map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export interface RetrievalHit { chunk: DocumentChunk; score: number }

export class EvidenceIndex {
  private docs: { chunk: DocumentChunk; tf: Map<string, number>; len: number }[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  constructor(chunks: DocumentChunk[]) {
    for (const chunk of chunks) {
      const toks = tokenize(`${chunk.text} ${chunk.location} ${chunk.kind}`);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ chunk, tf, len: toks.length });
    }
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
  }

  get size() { return this.docs.length; }

  search(query: string, opts: { vendorIds?: string[]; k?: number } = {}): RetrievalHit[] {
    const k1 = 1.4, b = 0.75, N = this.docs.length;
    const q = [...new Set(tokenize(query))];
    const filter = opts.vendorIds?.length ? new Set(opts.vendorIds) : null;
    const hits: RetrievalHit[] = [];
    for (const d of this.docs) {
      if (filter && !filter.has(d.chunk.vendor_id)) continue;
      let score = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / (this.avgLen || 1))));
      }
      if (score > 0) hits.push({ chunk: d.chunk, score: Math.round(score * 1000) / 1000 });
    }
    return hits.sort((a, b2) => b2.score - a.score).slice(0, opts.k ?? 6);
  }
}
