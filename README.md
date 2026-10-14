# Procurement Copilot – AI-assisted sourcing prototype

This project covers a corrugated-packaging sourcing event from the buyer's requirement through to a defensible award recommendation.

```
Buyer requirement ─▶ 1 RFx Copilot (Stage 2)
Vendor responses  ─▶ 2 Bid processing: ingest ▸ extract ▸ match ▸ interpret (LLM) ▸ normalize ▸ validate ▸ exceptions (code)
                      ▸ HITL review ▸ finalize = trusted canonical bids (Stage 3)
                  ─▶ 3 Comparison (vendor + SKU level)
                  ─▶ 4 Sourcing Analyst: plan (LLM) ▸ structured tools + scenario engine + evidence retrieval (code) ▸ grounded answer (LLM)
                  ─▶ 5 Decision: deterministic scenarios ▸ explicit recommendation rules ▸ sensitivity ▸ buyer approval ▸ PDF/JSON export (Stage 4)
```

**Principle:** the model reads, interprets and explains; code calculates and decides every number.

For a short overview with screenshots of a full run, see [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md).

[`stage1/`](stage1/README.md) holds the synthetic dataset. At runtime the app reads only `stage1/buyer`, `stage1/vendors` and `stage1/images`, through the guard in `lib/event/files.ts`.
- `stage1/ground_truth` and `stage1/_build` are used **only** by `eval/`.
- A test enforces this.
- Vercel bundling excludes those folders.

## Run

```bash
npm install
cp .env.example .env.local      # set LLM_PRIMARY_PROVIDER and the matching key
npm run dev                     # http://localhost:3000
```

| Variable | Notes |
|---|---|
| `LLM_PRIMARY_PROVIDER` | `openai` (default setup), `gemini` or `anthropic` (`AI_PROVIDER` still accepted) |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Model is pinned explicitly; `OPENAI_TIMEOUT_MS`, `OPENAI_MAX_OUTPUT_TOKENS`, `OPENAI_REASONING_EFFORT` optional |
| `LLM_FALLBACK_ENABLED`, `FREE_PROVIDER`, `FREE_MODEL` | Optional recorded fallback to a free Gemini tier on quota, rate-limit or outage |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | e.g. `gemini-3.8-flash`. Free tier allows 20 requests per day per model |
| `GEMINI_THINKING_LEVEL`, `GEMINI_TIMEOUT_MS` | `LOW` (default) / `MEDIUM` / `HIGH`; default timeout 120000 |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT` | `claude-haiku-5-5`, `low` |
| `EVAL_USD_INR`, `EVAL_FREIGHT_LOADING_PCT` | Optional overrides. Defaults come from the RFx (88.50; 5%) |

All keys are read server-side only (`lib/ai/model.ts`). The server is stateless: bids, scenarios (as constraints) and the decision audit trail are kept in the browser and recomputed server-side on every request.

**Demo path:**
1. **1 · RFx**
2. **2 · Bid processing & review:** Load & process each vendor, then review, then Finalize.
3. **3 · Comparison**
4. **4 · Sourcing Analyst:** the suggested demo questions are provided as buttons.
5. **5 · Decision & export:** approve, then export PDF/JSON.

The "Next →" button in the nav moves through the steps.

## Test, evaluate, build

```bash
npm test                 # offline tests (mocked model) – Stages 2-4
npm run typecheck
npm run build            # production build (stop `npm run dev` first – both write .next)
npm run test:live        # opt-in: real model – RFx generation, bid extraction, analyst
npm run eval:process     # LIVE: process all Stage 1 responses → eval/results/bids/*.json
npm run eval             # offline: score bids vs ground truth → eval/results/report.md
npm run eval:decision    # offline: Stage 4 scenario/recommendation properties → eval/results/decision_report.md (+ sample exports)
npm run eval:analyst     # LIVE: analyst golden questions incl. the Stage 4 demo conversation → eval/results/analyst_report.md
```

## Layout (main parts)

```
lib/ai/            model config, Gemini + Claude clients (PDF/image attachments), shared structured call (1 retry), prompts/
lib/event/         guarded file access (files.ts) + sourcing-event context from buyer files (context.ts)
lib/bids/          ingest (xlsx/pdf/docx/image/email) · schema · agent · compute (deterministic canonical bid) · hitl
lib/analyst/       retrieval (BM25) · tools (bid + scenario tools) · agent (plan → tools → grounded answer → citation check)
lib/scenarios/     engine (exact supplier-subset search) · standard set · recommend (explicit rules) · sensitivity · export (PDF/JSON)
app/               pages: / · /bids · /compare · /analyst · /decision ; API: /api/rfx /api/bids/* /api/analyst /api/decision/*
eval/              offline/live evaluation harness (only place allowed to read stage1/ground_truth)
data/event/        invited-supplier registry (identity only)
```

## Known limitations

- **Free-tier Gemini quota:** 20 requests a day per model. A full live run uses about 8 calls for processing and about 2 per analyst question. Use billing, or split models via `GEMINI_MODEL`.
- **Latency:** extraction of one response takes about 45–90 s, and an analyst answer is 2 model calls. Routes allow up to 300 s.
- **Browser-held state:** bids and decisions live in each browser's `localStorage`, not a shared database.
- **Freight:** where it is "extra / at actuals", the evaluation uses the RFx loading rule (5%) or a buyer assumption, and the scenario flags landed cost as incomplete.
- **Recommendation rules:** the recommendation applies fixed, documented rules (`RECOMMENDATION_POLICY`), not an optimised score.

## Demo data

Everything in `stage1/` is a **fictional** sourcing event built for this demo. The buyer, vendors, people, emails (`*.example`), GSTINs and certificate numbers are invented; any resemblance to real companies is coincidental. Email sending and receiving is simulated, and working data is stored in the browser.

## License

- **Code:** [MIT](LICENSE) © 2026 Aman Tiwari.
- **Demo dataset (`stage1/`) and documentation (`docs/`):** [CC BY 4.0](LICENSE-DATA). Reuse with credit.
- **Dependencies:** each keeps its own license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
