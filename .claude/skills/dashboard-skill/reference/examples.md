## Examples

Use examples as compact blueprints, not long case studies. Every example must still use:

- The 3-zone iframe shell from `ui-standards.md`.
- `WidgetCard` for every data widget.
- `useHostContext` for `context.session.token` and `context.market.selectedTicker`.
- Only registered datasources from `datasource-registry.md`.
- The standard Zone 2 order: filters/context, KPIs, primary analysis, insights, detail, sources.
- A stable visual export target on Zone 2 and the `dashboard.capture.visual` SDK handler.

When an example names a datasource, build the URL from `base_urls[datasource.service] + datasource.endpoint path`. Use `Authorization: Bearer ${session.token}` for all registered APIs.

### Screener Dashboard

- **Purpose**: Filter and rank companies by financial, market, or custom signals.
- **Context**: Use selected market/ticker only when relevant; otherwise expose filter controls for sector, country, metric, date range, and signal type.
- **Datasources**: Use `document_search` for proprietary document-backed signals, `news_search` for recent event signals, and `muns_chat` only for AI explanation widgets.
- **Primary widget**: Wide screener table.
- **KPI widgets**: screened companies, companies passing filters, median valuation, strongest signal, source freshness.
- **Insight widgets**: one risk note, one opportunity note, and one change note generated from the same filtered universe.
- **Detail widget**: selected company or row breakdown.
- **Source widget**: datasource list, latest update timestamp, and citation/source count.

### Sector Intelligence Dashboard

- **Purpose**: Compare companies and signals within a sector.
- **Context**: Read ticker from host context if the dashboard is company-anchored; otherwise use sector and country filters.
- **Datasources**: Use `news_search` for current events, `document_search` for filings/transcripts, `web_search` or `web_reader` for public web context, and `agent_run` for long-running analyst refresh workflows.
- **Primary widget**: Wide sector momentum, comparison chart, or company matrix.
- **KPI widgets**: sector score, average pressure metric, policy/risk level, source freshness.
- **Insight widgets**: risk, opportunity, watch, and change notes.
- **Detail widget**: company comparison table.
- **Source widget**: filings, news, web, or document source trail with extraction timestamps.

### Heatmap Dashboard

- **Purpose**: Show relative strength, weakness, concentration, or dispersion across many entities.
- **Context**: Use filters for universe, metric, date range, and grouping; do not require ticker unless the heatmap is company-specific.
- **Datasources**: Use the datasource that owns the metric; use `muns_chat` only to summarize selected cells or explain outliers.
- **Primary widget**: Wide heatmap matrix.
- **KPI widgets**: strongest cluster, weakest cluster, dispersion, latest update.
- **Insight widgets**: notable outliers and changes since prior period.
- **Detail widget**: selected cell breakdown table.
- **Source widget**: source freshness, confidence notes, and the metric definition used for color encoding.

### Brand Discounts Dashboard

- **Purpose**: Track discounts, pricing changes, and retailer behavior for brands/products.
- **Context**: Use brand, retailer, country, product category, and date filters. Ticker is optional unless mapped to a listed company.
- **Datasources**: Use `web_reader` for known product or retailer URLs, `web_search` for discovery, and `muns_chat` only for narrative interpretation.
- **Primary widget**: Wide discount matrix or product table.
- **KPI widgets**: products tracked, average discount, deepest discount, retailers active.
- **Insight widgets**: pricing pressure, unusual discounting, restock or promotion notes.
- **Detail widget**: product rows with brand, retailer, list price, final price, discount, source date.
- **Source widget**: web reader URLs, extraction timestamp, and failed/partial extraction notes.

### Document Intelligence Dashboard

- **Purpose**: Convert documents, filings, transcripts, or web pages into structured findings.
- **Context**: Use selected ticker when available; use document/category/date filters when no ticker is selected.
- **Datasources**: Use `document_search` for indexed proprietary documents, `web_reader` for URL extraction, and `muns_chat` for answer synthesis over retrieved evidence.
- **Primary widget**: Wide extraction summary or answer widget.
- **KPI widgets**: documents read, claims extracted, citation count, confidence/freshness.
- **Insight widgets**: key risks, opportunities, contradictions, and watch items.
- **Detail widget**: claim table with extracted value, source, citation, confidence.
- **Source widget**: required source trail with document IDs, citation count, and extraction timestamps.

### Web Reader Dashboard

- **Purpose**: Read one or more URLs and turn them into inspectable dashboard evidence.
- **Context**: Require user-provided URLs; ticker is optional and only used as analysis context.
- **Datasources**: Use `web_reader` only. Do not call search, chat, or agent APIs unless the user explicitly asks for interpretation beyond extraction.
- **Primary widget**: Wide extracted-content summary with title, key facts, and page-level status.
- **KPI widgets**: URLs submitted, URLs successfully read, extraction failures, latest extraction time.
- **Insight widgets**: content quality, missing sections, and notable extracted facts.
- **Detail widget**: URL-by-URL extraction table with status, title, domain, and extracted text preview.
- **Source widget**: exact source URLs and extraction timestamps.

### AI Analyst Dashboard

- **Purpose**: Stream an AI answer or analyst-agent result into a dashboard while preserving source and run metadata.
- **Context**: Wait for `session.token`; include selected ticker, date range, document IDs, or dashboard inputs only when available.
- **Datasources**: Use `muns_chat` for direct question answering and `agent_run` for registered analyst workflows. Both are `nestjs` services.
- **Primary widget**: Wide streaming answer card that shows progressive output and final status.
- **KPI widgets**: run status, tokens/steps if available, selected ticker, generated-at time.
- **Insight widgets**: extracted risks, opportunities, assumptions, and follow-up questions from the streamed output.
- **Detail widget**: request context table showing task, ticker, dates, documents, and dashboard inputs sent.
- **Source widget**: response headers such as chat/message ID or analyst/output ID, plus any citations returned in the stream.

### Minimum Implementation Pattern

Every generated dashboard should follow this skeleton:

```text
Header: title, optional ticker pill, refresh/export/filter actions
Main: context/filter WidgetCard
Main: 3-5 KPI WidgetCards
Main: wide primary analysis WidgetCard
Main: supporting insight WidgetCards
Main: detail/drilldown WidgetCard
Main: source/provenance WidgetCard
SDK: ready/context subscription, bearer token from host, visual snapshot handler
States: loading shimmer, waiting-for-session, empty/no ticker, partial data, friendly error
```
