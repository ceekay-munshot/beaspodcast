import { defineConfig, loadEnv } from 'vite'
import type { Connect, Plugin } from 'vite'
import type { ServerResponse } from 'node:http'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { episodesForFeed, getLiveEpisodes, SEED_IDS } from './server/feeds'
import { searchPodcasts } from './server/search'
import { summarizeEpisode, synthesizeWeekly } from './server/summarize'
import { fileSummaryStore } from './server/summaryStore.node'
import { handleChannels } from './server/channelStore'
import { fileChannelStore } from './server/channelStore.node'
import { handleProcessed } from './server/processedStore'
import { fileProcessedStore } from './server/processedStore.node'
import { handleSubscribers } from './server/subscriberStore'
import { fileSubscriberStore } from './server/subscriberStore.node'
import { handleSchedule } from './server/scheduleStore'
import { fileScheduleStore } from './server/scheduleStore.node'
import { checkCronAuth, processPendingBatch, runWeeklyDigest } from './server/weeklyDigest'
import { sendRawEmail, type RawEmail } from './src/lib/email'
import { reportId, reportUrl } from './server/reportStore'
import { contentDispositionInline, REPORT_DL_PARAM } from './src/lib/reportName'
import { cleanAttachments } from './src/lib/email'
import { weeklyPdfBytes } from './src/lib/pdfRender'
import { USER_HEADER, userKeyFrom } from './server/identity'
import { resolveVideoId } from './server/resolveVideo'

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
}

// The Munshot identity header, canonicalized — Node lowercases incoming header
// names, and USER_HEADER is already lowercase. Null = anonymous (legacy stores).
function userOf(req: Connect.IncomingMessage): string | null {
  const h = req.headers[USER_HEADER]
  return userKeyFrom(Array.isArray(h) ? h[0] : h)
}

// Serves the live-feed + summary API during `vite dev` / preview, mirroring the
// Cloudflare Pages Functions (functions/api/*) used in production. Both call the
// same shared server/* modules, so local and prod behave identically.
function liveApiPlugin(config: {
  openaiKey?: string
  anthropicKey?: string
  model?: string
  deepgramKey?: string
  deepgramModel?: string
  groqKey?: string
  cronSecret?: string
  emailToken?: string
  siteUrl?: string
  emailAttachments?: boolean
}): Plugin {
  // Shared summary store for dev: a filesystem mirror of the prod KV namespace, so
  // a summary generated once is reused across reloads and across every browser that
  // hits this dev server — exactly like the deployed app.
  const store = fileSummaryStore(path.resolve(process.cwd(), '.cache/summaries'))
  // Durable channel roster for dev: file mirrors of the prod KV entries, so the
  // tracked-show lists survive restarts — exactly like the deployed app. The
  // anonymous roster keeps its legacy single file; each identified user gets
  // their own file (mirroring the per-user KV keys). The `u-` filename prefix
  // defuses dot-only ids; the canonical key charset already excludes `/`.
  const channels = fileChannelStore(path.resolve(process.cwd(), '.cache/channels.json'))
  const channelStoreFor = (uid: string | null) =>
    uid ? fileChannelStore(path.resolve(process.cwd(), '.cache/channels', `u-${uid}.json`)) : channels
  // Per-user processed history for dev (no anonymous variant — mirrors prod,
  // where anonymous history lives only in the browser).
  const processedStoreFor = (uid: string | null) =>
    uid ? fileProcessedStore(path.resolve(process.cwd(), '.cache/processed', `u-${uid}.json`)) : null
  // The weekly-brief subscriber list for dev (one global file, mirroring the
  // single prod KV value the Monday digest reads).
  const subscribers = fileSubscriberStore(path.resolve(process.cwd(), '.cache/weekly-subscribers.json'))
  const schedule = fileScheduleStore(path.resolve(process.cwd(), '.cache/weekly-schedule.json'))
  // Hosted PDF reports for dev — an in-process map mirroring the prod KV store. Good
  // enough for a click-through in the same dev session (a real recipient would need
  // a public origin, which dev isn't — see SITE_URL).
  const reportMem = new Map<string, ArrayBuffer>()
  const devReportStore = {
    async put(bytes: ArrayBuffer): Promise<string> {
      const id = await reportId(bytes)
      reportMem.set(id, bytes)
      return id
    },
    async get(id: string): Promise<ArrayBuffer | null> {
      return reportMem.get(id) ?? null
    },
  }
  const originFor = (req: Connect.IncomingMessage) => config.siteUrl || `http://${req.headers.host ?? 'localhost:5173'}`
  return {
    name: 'munshot-live-api',
    configureServer(server) {
      server.middlewares.use('/api/channels', async (req, res) => {
        try {
          const method = req.method ?? 'GET'
          const { status, body } = await handleChannels(channelStoreFor(userOf(req)), method, method === 'GET' ? '' : await readBody(req), SEED_IDS)
          json(res, status, body)
        } catch {
          if (req.method === 'GET') json(res, 200, [])
          else json(res, 500, { error: 'channels_failed' })
        }
      })

      server.middlewares.use('/api/processed', async (req, res) => {
        try {
          const method = req.method ?? 'GET'
          const { status, body } = await handleProcessed(
            processedStoreFor(userOf(req)),
            store, // the shared summary cache — GETs re-hydrate entries against it
            method,
            method === 'GET' ? '' : await readBody(req),
          )
          json(res, status, body)
        } catch {
          if (req.method === 'GET') json(res, 200, [])
          else json(res, 500, { error: 'processed_failed' })
        }
      })

      server.middlewares.use('/api/subscriptions/weekly', async (req, res) => {
        try {
          const method = req.method ?? 'GET'
          const { status, body } = await handleSubscribers(subscribers, method, method === 'GET' ? '' : await readBody(req), userOf(req))
          json(res, status, body)
        } catch {
          json(res, 500, { error: 'subscribers_failed' })
        }
      })

      // Weekly-digest send schedule (day · time · timezone) — mirrors
      // functions/api/schedule/weekly.ts. GET reads, PUT updates.
      server.middlewares.use('/api/schedule/weekly', async (req, res) => {
        try {
          const method = req.method ?? 'GET'
          const { status, body } = await handleSchedule(schedule, method, method === 'GET' ? '' : await readBody(req))
          json(res, status, body)
        } catch {
          json(res, 500, { error: 'schedule_failed' })
        }
      })

      // Same-origin email proxy — mirrors functions/api/email/send.ts. Holds the
      // service token server-side and relays to the raw-email endpoint.
      server.middlewares.use('/api/email/send', async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'method_not_allowed' })
        try {
          const b = JSON.parse((await readBody(req)) || '{}') as { to?: string; subject?: string; text?: string; html?: string; attachments?: unknown }
          const to = (b.to ?? '').trim()
          const text = typeof b.text === 'string' ? b.text : undefined
          const html = typeof b.html === 'string' ? b.html : undefined
          // Same recipient hardening as prod: one valid address, no header-injection newlines.
          if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to) || /[\r\n]/.test(to)) return json(res, 400, { ok: false, message: 'A valid recipient email is required.' })
          if (!b.subject || /[\r\n]/.test(b.subject) || !!text === !!html) return json(res, 400, { ok: false, message: 'A subject and exactly one of text or html are required.' })
          const attachments = config.emailAttachments ? cleanAttachments(b.attachments) : []
          const base = { email: to, subject: b.subject, ...(attachments.length ? { attachments } : {}) }
          const msg: RawEmail = html ? { ...base, html } : { ...base, text: text as string }
          const result = await sendRawEmail(msg, { token: config.emailToken })
          json(res, result.ok ? 200 : 502, result)
        } catch {
          json(res, 500, { ok: false, message: "Couldn't reach the email service." })
        }
      })

      // Hosted PDF report — mirrors functions/api/report/*. POST stores bytes →
      // { id, url }; GET /api/report/:id serves the PDF.
      server.middlewares.use('/api/report', async (req, res) => {
        try {
          const url = new URL(req.url ?? '', 'http://localhost')
          const id = url.pathname.replace(/^\/+/, '').replace(/\.pdf$/i, '')
          if (req.method === 'GET' && id) {
            const bytes = await devReportStore.get(id)
            if (!bytes) {
              res.statusCode = 404
              return res.end('Report not found or expired.')
            }
            res.statusCode = 200
            res.setHeader('content-type', 'application/pdf')
            res.setHeader('content-disposition', contentDispositionInline(url.searchParams.get(REPORT_DL_PARAM)))
            return res.end(Buffer.from(bytes))
          }
          if (req.method === 'POST') {
            const chunks: Buffer[] = []
            await new Promise<void>((resolve) => {
              req.on('data', (c) => chunks.push(Buffer.from(c)))
              req.on('end', () => resolve())
              req.on('error', () => resolve())
            })
            const buf = Buffer.concat(chunks)
            if (!buf.byteLength) return json(res, 400, { error: 'empty' })
            const newId = await devReportStore.put(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
            return json(res, 200, { id: newId, url: reportUrl(originFor(req), newId) })
          }
          json(res, 405, { error: 'method_not_allowed' })
        } catch (e) {
          json(res, 502, { error: 'report_failed', detail: String(e).slice(0, 200) })
        }
      })

      // The Monday digest, on demand in dev. Mirrors the Pages Function: guarded by
      // CRON_SECRET when one is configured; if none is set locally, it's open (dev
      // only) so you can hit it without ceremony. Sends through the real raw-email
      // endpoint using MUNSHOT_EMAIL_TOKEN when present.
      server.middlewares.use('/api/cron/weekly-digest', async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' })
        if (config.cronSecret && !checkCronAuth(req.headers.authorization ?? null, config.cronSecret)) {
          return json(res, 401, { error: 'unauthorized' })
        }
        try {
          // Mirror prod: chip away at this week's pending episodes on every tick.
          const batch = await processPendingBatch({ getEpisodes: getLiveEpisodes, summaryStore: store, summarizeConfig: { ...config, store } }, { limit: 5, budgetMs: 75_000 }).catch(() => ({ processed: 0, remaining: 0 }))
          const result = await runWeeklyDigest({
            getEpisodes: getLiveEpisodes,
            summaryStore: store,
            subscriberStore: subscribers,
            sendEmail: (msg) => sendRawEmail(msg, { token: config.emailToken }),
            summarizeConfig: { ...config, store },
            generatePdf: (weekly, episodeById, podcastById) => weeklyPdfBytes(weekly, episodeById, podcastById),
            storePdf: async (bytes, downloadName) => reportUrl(originFor(req), await devReportStore.put(bytes), downloadName),
            attachPdf: !!config.emailAttachments,
          })
          json(res, result.status, { ...result.body, batch })
        } catch (e) {
          json(res, 500, { error: 'digest_failed', detail: String(e).slice(0, 200) })
        }
      })

      server.middlewares.use('/api/episodes', async (req, res) => {
        try {
          // req.url is the remainder after the mount prefix; base it to read query params.
          const params = new URL(req.url ?? '', 'http://localhost').searchParams
          const feed = params.get('feed')
          const id = params.get('id')
          // The summary store rides along on both paths, so episodes already
          // processed by ANY user come back ready — shared state for everyone.
          json(res, 200, feed && id ? await episodesForFeed(feed, id, store) : await getLiveEpisodes(store))
        } catch {
          json(res, 200, [])
        }
      })

      server.middlewares.use('/api/resolve-video', async (req, res) => {
        try {
          const params = new URL(req.url ?? '', 'http://localhost').searchParams
          json(res, 200, { videoId: await resolveVideoId(params.get('q') ?? '') })
        } catch {
          json(res, 200, { videoId: null })
        }
      })

      server.middlewares.use('/api/search-podcasts', async (req, res) => {
        try {
          const params = new URL(req.url ?? '', 'http://localhost').searchParams
          json(res, 200, await searchPodcasts(params.get('q') ?? '', Number(params.get('limit')) || undefined))
        } catch {
          json(res, 200, [])
        }
      })

      server.middlewares.use('/api/summary', async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' })
        if (!config.openaiKey && !config.anthropicKey) return json(res, 503, { error: 'no_api_key' })
        try {
          const input = JSON.parse((await readBody(req)) || '{}')
          if (input.mode === 'weekly') {
            json(res, 200, { weekly: await synthesizeWeekly(input, { ...config, store }) })
          } else {
            json(res, 200, await summarizeEpisode(input, { ...config, store }))
          }
        } catch (e) {
          json(res, 502, { error: 'summarize_failed', detail: String(e).slice(0, 200) })
        }
      })
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Loads .env / .env.local (gitignored) so the dev server + preview can reach
  // the Anthropic API without exporting env vars by hand.
  const env = loadEnv(mode, process.cwd(), '')
  const pick = (k: string) => env[k] || process.env[k] || ''
  const summaryConfig = {
    openaiKey: pick('OPENAI_API_KEY'),
    anthropicKey: pick('ANTHROPIC_API_KEY'),
    model: pick('SUMMARY_MODEL') || undefined,
    deepgramKey: pick('DEEPGRAM_API_KEY'), // transcription for long episodes
    deepgramModel: pick('DEEPGRAM_MODEL') || undefined,
    groqKey: pick('GROQ_API_KEY'), // free-tier Whisper (short episodes)
    cronSecret: pick('CRON_SECRET') || undefined, // guards /api/cron/weekly-digest (open locally if unset)
    emailToken: pick('MUNSHOT_EMAIL_TOKEN') || undefined, // service token for server-side sends
    siteUrl: pick('SITE_URL') || undefined, // absolute origin for hosted-PDF links
    emailAttachments: pick('EMAIL_ATTACHMENTS') === '1', // attach the weekly PDF (endpoint must support it)
  }

  return {
    plugins: [react(), liveApiPlugin(summaryConfig)],
    // Bind on all interfaces and honor the PORT assigned by the preview harness so
    // the hosted preview can reach the dev server (it proxies in from beyond
    // loopback). allowedHosts lets the proxied preview hostname through Vite's
    // host-header check instead of being rejected as a "blocked request".
    server: {
      host: true,
      port: Number(process.env.PORT) || 5173,
      strictPort: false,
      allowedHosts: true,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  }
})
