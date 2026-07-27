# Munshot Podcasts — Podcast Intelligence

> Choose podcasts → get one-page AI summaries → double-click what's interesting → read one weekly master summary.

A minimal, editorial dashboard that turns the podcasts you care about into a passive intelligence layer. This repo is a **polished UI prototype**: every screen is real and interactive, driven by realistic mock data through a typed API seam (`src/lib/api.ts`) so a live backend drops in without touching the components.

Built for a tech & investing listener tracking shows like **Stratechery, Invest Like the Best, All-In, Odd Lots, The AI Daily Brief, In Good Company, Acquired,** and **Cheeky Pint**.

![stack](https://img.shields.io/badge/React-18-blue) ![stack](https://img.shields.io/badge/Vite-5-646cff) ![stack](https://img.shields.io/badge/Tailwind-3-38bdf8) ![stack](https://img.shields.io/badge/TypeScript-5-3178c6)

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build
```

## What's in the box

The product's 13 core features, each mapped to where it lives in the UI:

| # | Feature | Where |
|---|---------|-------|
| 1 | Podcast / YouTube selection | **Discover** — search by name or paste an RSS/YouTube URL, add to your library |
| 2 | Automatic new-episode detection | **Home** processing queue + **Episodes** status column |
| 3 | Transcript ingestion | Status pipeline + the **Transcript** tab |
| 4 | One-page AI summary | **Episode → Summary** (Executive Synthesis) |
| 5 | Key takeaways | Blue accent-bar modules on Home, Episode, Weekly |
| 6 | Q&A summary | **Episode → Q&A** |
| 7 | Interesting moments | **Episode → Summary** ("double-click" cards with *why it matters*) |
| 8 | Transcript with highlights | **Episode → Transcript** — highlighted spans ↔ Intelligence Modules |
| 9 | Weekly master summary | **Weekly Summary** — overview, themes, interesting, takeaways, contradictions, mentions, questions, citations |
| 10 | Episode history / archive | **Episodes** — searchable, filterable table |
| 11 | Search | **Search** — episodes, podcasts, people, companies, themes, moments |
| 12 | Processing status | `detected → fetching → transcribing → summarizing → ready / failed` everywhere, with a pipeline view on non-ready episodes |
| 13 | Basic settings | **Settings** — manage feeds, summary length, weekly toggle, email notifications |

See [`FEASIBILITY.md`](./FEASIBILITY.md) for the per-feature buildability assessment.

## Architecture

```
src/
  lib/
    types.ts        # the domain model — the UI ⇄ backend contract
    mock-data.ts    # realistic sample content (real podcast lineup)
    api.ts          # ← THE SEAM. async functions; swap mock for fetch()
    format.ts       # duration / date / status helpers
  store/
    AppData.tsx     # loads everything through the api seam, provides via context
    Player.tsx      # docked media-player state
  components/        # Sidebar, TopBar, MediaPlayer, CoverTile, StatusBadge, …
  pages/             # Home, Discover, Episodes, EpisodeDetail, Weekly, Settings, Search
```

**The seam.** No component imports mock data directly. Each function in `api.ts` returns exactly the shape a real endpoint would, e.g.

```ts
export const listEpisodes = () =>
  fetch('/api/episodes').then((r) => r.json() as Promise<Episode[]>)
```

Replace the bodies and the UI is live.

### Design system

Clean, minimal, editorial SaaS. A near-white `#fafbfc` canvas, white cards with subtle borders + faint shadows, **Inter** type, and a single bright blue accent (`#2563eb`) reserved for actions and active states. Green denotes a ready summary. Tokens live in [`tailwind.config.js`](./tailwind.config.js) — the whole app re-skins from that one file. Cover art is generated from each show's brand color + monogram (an SVG), so the prototype ships with zero external image dependencies.

## Per-user sign-in inside chat.muns.io

Embedded in chat.muns.io, every user gets their own roster + processed history
(KV keys scoped by the Munshot identity), while episode summaries stay one
global cache shared by everyone. The dashboard side is fully wired
(`src/lib/munshot.ts` — it announces `dashboard:ready` and consumes
`host:init`), **but the host platform must send the other half of the
handshake**: chat.muns.io currently embeds dashboards without any host-side
SDK, so the sidebar badge shows "Not signed in".

→ Drop [`munshot-host-snippet.js`](./munshot-host-snippet.js) into the
chat.muns.io dashboards page (it initializes every dashboard iframe with the
signed-in user's context and answers late `dashboard:ready` announcements).
To rehearse the whole flow locally, open `localhost:5173/embed-harness.html`
during `vite dev` — it simulates a correctly-behaving host, user switching
included.

### Downloads inside the iframe (PDF + Word)

The dashboard iframe is sandboxed `allow-scripts allow-same-origin allow-popups
allow-forms allow-downloads` — note **no `allow-modals`**, which per the HTML
spec turns every script-initiated `window.print()` into a silent no-op for the
whole frame tree. So the PDF is **not** produced by the browser's print → Save
as PDF; it's generated as a real `.pdf` with a library (jsPDF) and handed over
as a Blob download — exactly the model the Word `.doc` export already uses, and
the one delivery (`allow-downloads`) that always works inside that sandbox.
`src/lib/pdfRender.ts` draws the full house style as vector — the dark gradient
cover (painted to a canvas, embedded as the cover image), gold section rules,
the drop-cap lead, diamond-bullet idea cards, the dark quote panel, and the
zebra source table — with real, selectable text. Fonts follow the same serif/
sans/mono split as the `.doc` (Times / Helvetica / Courier ≈ Georgia / Calibri /
Consolas), the standard PDF families, so nothing needs embedding.

## Weekly email digest (the Monday send) + the PDF report

The weekly brief is **investable-research-grade**, modelled on Guidepoint AskGP:
a synthesised cross-episode **Overview** (with `[n]` citations), thematic
**Key Points**, a **Quantitative Summary** table, a **Comparison Across Sources**
table, and grouped **Sources**. Each episode also carries an *investable insight*
(what changed · why it matters · who benefits · who's at risk · diligence
questions — `server/summarize.ts`, `SUMMARY_REVISION` r7), which the weekly
synthesis (`synthesizeWeekly`) rolls up across the week. The on-screen Weekly
page, the emailed brief, the PDF, and the Word export all render this one shape.

**The email is a brief that links to a hosted PDF.** The raw-email endpoint can't
carry attachments, so the cron renders the edition to a real `.pdf` (jsPDF —
`weeklyPdfBytes` in `src/lib/pdfRender.ts`), stores the bytes in KV keyed by a
content hash (`server/reportStore.ts`, served at `GET /api/report/:id`, 30-day
TTL), and sends a polished HTML brief with a prominent **Download full PDF
report** button.

**All sends route through our own origin.** The app is a partitioned iframe, so a
cross-origin browser send to the raw-email endpoint can't carry the muns.io
session cookie (this was the *"Couldn't reach the email service"* bug). Instead,
subscribe-welcome and "Email this edition" POST to `POST /api/email/send`
(`functions/api/email/send.ts`), which holds the service token server-side and
relays it — the browser never sees the token.

Because Cloudflare Pages can't run cron itself, the Monday timer is a scheduled
**GitHub Actions** workflow ([`.github/workflows/weekly-digest.yml`](./.github/workflows/weekly-digest.yml))
that POSTs `/api/cron/weekly-digest`. It assembles the edition server-side
(`server/weeklyDigest.ts` → `assembleWeekly` + `synthesizeWeekly` with a
deterministic fallback), renders + hosts the PDF, and mails every subscriber.
Only episodes summarised **and** published in the last 7 days are included; with
none, it skips (never an empty email).

**Setup — Pages env + repo secrets:**

| Where | Name | Purpose |
|-------|------|---------|
| Pages project (Settings → Variables) | `MUNSHOT_EMAIL_TOKEN` | **Service** token authorizing server-to-server sends (the "god token"). Used by the cron *and* the `/api/email/send` proxy. Store as an **encrypted secret** — never commit it. |
| Pages project | `CRON_SECRET` | Bearer token guarding `/api/cron/weekly-digest`. |
| Pages project | `SITE_URL` | Deployed origin, e.g. `https://podcast-afg.pages.dev` — required to build an absolute link to the hosted PDF (a cron has no request). |
| Pages project | `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) + optional `SUMMARY_MODEL` | The summariser. Use a strong model (e.g. `claude-opus-4-8`) — the investable-insight + quant extraction quality scales with model strength. |
| GitHub repo (Settings → Secrets → Actions) | `SITE_URL`, `CRON_SECRET` | Same values as the Pages vars. |

Trigger it by hand any time from the Actions tab (**workflow_dispatch**) to test.
Locally, `vite dev` mirrors every route (`/api/email/send`, `/api/report/:id`,
`/api/cron/weekly-digest`); set `MUNSHOT_EMAIL_TOKEN` + `SITE_URL` in `.env` /
`.env.local` to exercise real sends. The cron is open locally when no
`CRON_SECRET` is set.

## What's mocked vs. real

- **Real:** every screen, route, interaction, status pipeline, search, settings, tracking toggles, the docked player UI, highlight ↔ summary linking.
- **Mocked:** the data itself (in `mock-data.ts`) and a ~240ms simulated latency in `api.ts`. No audio actually plays; transcription/LLM/RSS are represented by sample output.

## Next steps to go live

1. Implement `api.ts` against a backend (episode rows, summaries, transcripts).
2. RSS/YouTube polling worker → writes `detected` episodes.
3. Transcript ingest endpoint (the customer supplies the transcription API).
4. Claude summarization pass → fills `synthesis / takeaways / qa / moments`, returning quoted spans for the transcript highlights.
5. Weekly aggregation job (summary-of-summaries) + email digest. ✅ **Done** — see [Weekly email digest](#weekly-email-digest-the-monday-send).
