# Feasibility check — 13 core features

Assessment of each feature's buildability for the real product. The verdict column is about the **system** behind the UI; every feature's *interface* is already built in this prototype.

**TL;DR — all 13 are buildable.** The only real engineering risk sits in transcript-highlight alignment (#8) and the deeper tiers of search (#11). The customer supplies the transcription API, which removes the single biggest unknown.

| # | Feature | Verdict | Implementation notes & caveats |
|---|---------|---------|-------------------------------|
| 1 | Podcast / YouTube selection | ✅ Feasible | Podcast search via the **Apple/iTunes Search API** (free, no key) or PodcastIndex; resolve to an RSS feed. YouTube channel → RSS (`youtube.com/feeds/videos.xml?channel_id=…`, last ~15 videos) or the **YouTube Data API** (API key + quota). |
| 2 | Automatic new-episode detection | ✅ Feasible | Poll each RSS feed on a schedule (cron / queue). Rock-solid for podcasts — RSS is a settled standard. Store a per-feed cursor (GUID / pubDate) to emit only new items. |
| 3 | Transcript ingestion | ✅ Feasible | Customer provides the transcription API → we receive the raw transcript. Only need an ingest endpoint + storage. Prefer a transcript **with timestamps and speaker labels** (enables #7 and #8). |
| 4 | One-page AI summary | ✅ Feasible | One LLM (Claude) pass over the transcript. Main consideration: **chunking** 2–3h transcripts to fit context, then a reduce step. Cost/latency scale with length, not difficulty. |
| 5 | Key takeaways | ✅ Feasible | Same structured LLM call that produces the summary — request a `takeaways[]` field. |
| 6 | Q&A summary | ✅ Feasible | Same call → `qa[]`. Reliable; the model reformats discussion into question/answer blocks. |
| 7 | Interesting moments | ✅ Feasible* | LLM surfaces "genuinely interesting" moments with a *why it matters* — deliberately **not** a rigid topic filter (per the customer: "everyone's going to talk about AI"). \*Needs **timestamps** in the transcript; "interesting" is prompt-tuned and subjective, so expect iteration. |
| 8 | Transcript with highlights | ⚠️ Feasible — trickiest | The LLM must return the **exact quoted span** (or char offsets) for each highlight so the UI can map summary ↔ transcript. Solved with structured output + fuzzy substring matching to tolerate minor transcript drift. This prototype demonstrates the full interaction (hover/click links highlights to Intelligence Modules). |
| 9 | Weekly master summary | ✅ Feasible | A "summary-of-summaries": aggregate the week's episode summaries into one document **with citations** back to source episodes. Lower token cost than re-reading every transcript. |
| 10 | Episode history / archive | ✅ Feasible | Standard persistence (Postgres / D1 / SQLite) + the list/search UI already built. |
| 11 | Search | ⚠️ Tiered | **Basic full-text** (titles, transcripts): feasible now. **People / companies / themes**: needs entity extraction (an LLM pass) stored as metadata — already modelled as `entities` here. **Semantic search**: optional vector layer (e.g. Vectorize / pgvector) later. |
| 12 | Processing status | ✅ Feasible | A simple state machine: `detected → fetching → transcribing → summarizing → ready / failed`, with retry. Surfaced throughout the UI. |
| 13 | Basic settings | ✅ Feasible | Manage feeds + summary length + toggles (UI built). **Email notifications** need a provider (Resend / Cloudflare Email / SES) — small, well-trodden integration. |

## Risks & mitigations

- **Highlight alignment (#8)** — biggest correctness risk. Mitigate by having the model echo verbatim quotes and matching them back into the transcript with normalization (whitespace/punctuation-insensitive). Fall back to timestamp-anchored highlights if a quote can't be located.
- **Long-transcript cost/latency (#4)** — map-reduce summarization; cache by transcript hash; let the user pick summary length (Settings already exposes concise/standard/detailed).
- **YouTube quota (#1/#2)** — prefer the channel RSS feed for detection and reserve the Data API for backfill/metadata.
- **"Interesting" is subjective (#7)** — treat the prompt as a tunable product surface; the customer explicitly wants *surfacing*, not filtering.

## What this prototype proves

The end-to-end **information architecture** and the full reading experience — selection, the one-page summary, the double-click-to-investigate loop, and the weekly master document — are validated. Everything that remains is backend wiring against the seam in `src/lib/api.ts`.
