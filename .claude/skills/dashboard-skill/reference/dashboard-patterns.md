## Dashboard Patterns

### Core Dashboard Grammar

Dashboards may cover screeners, sector monitors, heatmaps, brand discount trackers, document intelligence views, portfolio/watchlists, or company comparison tools. They must still feel like the same product.

The fixed UI shell is always the 3-zone layout from UI Standards. The flexible dashboard pattern lives inside Zone 2, the scrollable content area.

```text
Zone 2 Content Order
+-- Context/filter widgets
+-- KPI summary widgets
+-- Primary analysis widget(s)
+-- Supporting insight widgets
+-- Detail/drilldown widgets
+-- Source/provenance widgets
```

Standardize the hierarchy, not the exact chart type.

### Content Hierarchy

Every dashboard should include these roles when the data supports them:

- **Context / Filters**: The controls that define the universe, period, entity, source type, or segment.
- **KPI Summary**: Three to five compact metrics that summarize the current state.
- **Primary Analysis**: The dominant chart, table, heatmap, matrix, or extraction result.
- **Supporting Insights**: Risk, opportunity, watch, change, or explanation widgets.
- **Detail / Drilldown**: Table, ranked list, source-level breakdown, product list, or company comparison.
- **Source / Trust**: Source trail, extraction time, data freshness, API name, citation count, or confidence note.

These roles should be implemented as `WidgetCard` components. Do not invent a different visual shell for each role.

### Widget Placement

Use widget width to create hierarchy inside the grid:

- KPI widgets: normal `WidgetCard`, usually one grid cell each.
- Filter/context widget: normal or wide card depending on complexity.
- Primary analysis widget: wide card, often `gridColumn: "span 2"` on desktop.
- Insight widgets: normal cards grouped near the primary analysis.
- Detail tables: wide cards.
- Source trail: normal card unless source data is the main subject.

Recommended arrangement:

```text
Row 1: filter/context card, optional status/source freshness card
Row 2: KPI cards
Row 3: wide primary analysis card + insight cards
Row 4: wide detail table/card + source trail card
```

On small screens, the grid naturally collapses to one column. Preserve the same order.

### Dashboard Type Variants

Choose the primary widget based on the dashboard type:

- **Screener**: Primary widget is a dense filterable table. KPI widgets summarize count, median valuation, strongest signal, and latest update.
- **Heatmap**: Primary widget is a color-coded matrix. KPI widgets summarize strongest cluster, weakest cluster, dispersion, and freshness.
- **Sector Dashboard**: Primary widget is a momentum, trend, or sector comparison chart. Detail widget compares companies.
- **Company Dashboard**: Primary widget is a company-specific operating or market trend. Supporting widgets cover risks, catalysts, filings, and sources.
- **Brand Discounts Dashboard**: Primary widget is a discount or product matrix. Detail widget lists brand, product, retailer, discount depth, price, and source date.
- **Document Intelligence Dashboard**: Primary widget is an answer, extraction summary, or claim map. Detail widget lists extracted claims and citations.
- **Portfolio / Watchlist Dashboard**: Primary widget is holdings or watchlist ranking. Supporting widgets highlight alerts, exposures, and recent changes.

Do not force every dashboard to use the same chart. The consistent part is the shell, widget card structure, hierarchy, and state handling.

### KPI Standards

KPI widgets must be meaningful, not decorative.

Each KPI should include:

- Short label
- Main value
- Trend or comparison when available
- Time period or scope
- Status color only when it adds meaning

Good KPI examples:

- Sector Score: `72`, `+5 pts vs prior month`
- Avg MLR Pressure: `84.6%`, `+120 bps QoQ`
- Products on Discount: `248`, `+18% WoW`
- Screened Companies: `412`, `32 passed filters`
- Source Freshness: `18h`, `All core feeds updated`

Avoid vague KPI labels like `Total Data`, `Overall Info`, or duplicate metrics.

### Insight Standards

Insight widgets should explain the data, not repeat it.

Use concise blocks with one of these roles:

- **Risk**: What could hurt performance or confidence.
- **Opportunity**: What looks attractive or improving.
- **Watch**: What needs monitoring but is not decisive yet.
- **Change**: What moved since the last refresh.
- **Source Note**: What the data is based on or where confidence is limited.

Each insight should have:

- A short category label or badge
- One direct sentence
- One supporting sentence

### Table Standards

Tables are for drilldown and comparison.

Financial dashboard tables should:

- Use compact rows and clear column labels.
- Keep the first column visually prominent.
- Use status chips for risk, confidence, direction, or category.
- Include mini trends only when they improve scan speed.
- Support sorting, filtering, pagination, or virtual scrolling when data is large.
- Avoid loading more than 10,000 rows into the DOM at once.

Common columns by dashboard type:

- Screener: entity, ticker, score, valuation, growth, quality, signal, source date.
- Sector: company, score, operating metric, risk, valuation, signal.
- Heatmap: row group, column group, value, change, confidence.
- Discounts: brand, product, retailer, list price, discount, final price, source date.
- Document intelligence: claim, source, confidence, extracted value, citation.

### Source And Trust Standards

Every dashboard that uses external, AI-extracted, web, news, or document-derived data must show source context.

Include at least one of:

- Source trail widget
- Data source attribution
- Last updated timestamp
- Extraction timestamp
- Citation count
- Confidence or freshness indicator

Source trail entries should be short:

```text
Source title
What was extracted, and when
```

### State Standards

Follow the UI Standards state components inside every widget:

- **Loading**: shimmer skeleton matching the final widget shape.
- **Refreshing**: keep previous data visible and show a subtle refresh state.
- **Empty**: centered empty state with a message and next-step hint.
- **No ticker**: show empty state and do not call ticker-dependent APIs.
- **No token yet**: show a non-blocking waiting state inside affected widgets.
- **Partial data**: render available widgets and mark unavailable ones clearly.
- **API error**: friendly centered error state; never show raw stack traces.
- **Auth/context error**: explain that host session or selected context is unavailable.

### Performance Standards

- Debounce filter changes by at least 300ms.
- Cache static metadata, filter options, and slow-changing source lists.
- Use pagination or virtual scrolling for large tables.
- Lazy-load expensive secondary widgets when possible.
- Avoid repeated calls to the same datasource with identical parameters.
- Respect datasource `cache_ttl_seconds` and `rate_limit` from the registry.

### Implementation Rules For Claude

When generating a dashboard, Claude must:

- Build the actual dashboard as the first screen, not a landing page.
- Use the 3-zone shell from UI Standards.
- Use `WidgetCard` for all data widgets.
- Use only datasources registered in the Datasource Registry.
- Read `session.token` and market selection from `useHostContext`; never hardcode auth tokens or production tickers.
- Put dashboard roles in this order: filters/context, KPIs, primary analysis, insights, detail, sources.
- Select the primary widget based on the dashboard type.
- Keep the interface dense, calm, and suitable for repeated financial analysis.
- Include loading, empty, error, and partial-data states.
- Include source freshness or provenance when using extracted, web, news, document, or AI-generated data.
- Keep layout responsive without changing the meaning or order of sections.
- Avoid decorative UI that does not support analysis.
