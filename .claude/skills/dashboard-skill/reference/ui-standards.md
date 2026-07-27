## UI Standards

These UI standards come from the Munshot frontend dashboard builder guide and are mandatory for embedded dashboards.

### Mandatory 3-Zone Layout

Every dashboard must use this exact iframe shell:

```text
Dashboard App
+-- Zone 1: Sticky Header Bar, height 48px
+-- Zone 2: Scrollable Content Area, flex: 1
+-- Zone 3: Optional Sticky Footer, height about 40px
```

Use this outer shell:

```css
.dashboard-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: linear-gradient(to bottom, rgba(249, 250, 251, 0.8), #ffffff);
  font-family:
    system-ui,
    -apple-system,
    sans-serif;
  color: #111827;
}
```

Rules:

- The dashboard must fill the iframe with `height: 100vh`.
- The page itself must not scroll. Only Zone 2 scrolls.
- Do not create marketing pages, hero sections, or standalone navigation shells.
- Do not use a persistent left sidebar unless the host product explicitly provides one outside the iframe.

### Zone 1: Header Bar

The header is required and must always be sticky at the top.

```tsx
<header
  style={{
    position: "sticky",
    top: 0,
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 24px",
    height: 48,
    background: "rgba(255, 255, 255, 0.95)",
    backdropFilter: "blur(8px)",
    borderBottom: "1px solid #e5e7eb",
    flexShrink: 0,
  }}
>
  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
    <h1 style={{ fontSize: 15, fontWeight: 700, color: "#111827", margin: 0 }}>
      Dashboard Title
    </h1>
    {ticker && <TickerPill ticker={ticker} company={company} />}
  </div>
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    {/* view toggle, filter button, refresh, export */}
  </div>
</header>
```

Header rules:

- Height must be exactly `48px`.
- Background must be `rgba(255,255,255,0.95)`.
- Use `backdrop-filter: blur(8px)`.
- Bottom border must be `1px solid #e5e7eb`.
- Title must be `15px`, `700`, `#111827`.
- Show the active ticker pill only when a ticker is selected.
- Never put charts, tables, or large descriptions in the header.

Ticker pill style:

```tsx
<span
  style={{
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "2px 10px",
    background: "#eef2ff",
    color: "#4338ca",
    borderRadius: 99,
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid #e0e7ff",
  }}
>
  <span
    style={{ width: 6, height: 6, background: "#6366f1", borderRadius: "50%" }}
  />
  {ticker}
  {company && (
    <span style={{ color: "#818cf8", fontWeight: 400 }}>- {company}</span>
  )}
</span>
```

### Zone 2: Scrollable Content Area

Zone 2 holds all dashboard content and must be the only scrolling area.

```tsx
<main
  id="dashboard-main"
  data-dashboard-capture-root="true"
  style={{
    flex: 1,
    overflow: "auto",
    padding: "24px 32px",
  }}
>
  {/* filters, KPI widgets, charts, tables, source widgets */}
</main>
```

Use `padding: 24px 32px` by default. Use `24px` horizontal padding for narrower dashboards.

The main scrollable content container must expose a stable capture target using `id="dashboard-main"` or `data-dashboard-capture-root="true"` so the host can request visual export snapshots.

### Widget Grid

Use CSS Grid for dashboard widgets.

Default widget grid:

```tsx
<div
  style={{
    display: "grid",
    gap: 20,
    gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
  }}
>
  <WidgetCard />
  <WidgetCard />
</div>
```

Wide widget grid:

```tsx
<div style={{
  display: "grid",
  gap: 20,
  gridTemplateColumns: "repeat(auto-fill, minmax(480px, 1fr))",
}}>
```

Rules:

- Default grid gap is `20px`.
- Default card minimum width is `340px`.
- Wide chart/table cards can use `minmax(480px, 1fr)`.
- A wide widget may span two columns with `gridColumn: "span 2"` when there is room.
- On narrow screens, widgets must collapse naturally to one column.

### Widget Card

Every data widget must use the same card structure.

```tsx
function WidgetCard({ title, subtitle, children }) {
  return (
    <div
      style={{
        background: "rgba(255, 255, 255, 0.9)",
        border: "1px solid rgba(229, 231, 235, 0.8)",
        borderRadius: 16,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        backdropFilter: "blur(8px)",
        boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
        transition: "all 0.35s cubic-bezier(0.4, 0, 0.2, 1)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 16px",
          borderBottom: "1px solid rgba(229, 231, 235, 0.8)",
          background: "rgba(255,255,255,0.95)",
          backdropFilter: "blur(8px)",
          flexShrink: 0,
        }}
      >
        <div>
          <h3
            style={{
              margin: 0,
              fontSize: 14,
              fontWeight: 600,
              color: "#111827",
            }}
          >
            {title}
          </h3>
          {subtitle && (
            <p
              style={{
                margin: "2px 0 0",
                fontSize: 11,
                color: "#9ca3af",
                lineHeight: 1.3,
              }}
            >
              {subtitle}
            </p>
          )}
        </div>
      </div>
      <div
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          background: "rgba(249,250,251,0.5)",
        }}
      >
        {children}
      </div>
    </div>
  );
}
```

Hover state:

```css
.widget-card:hover {
  transform: translateY(-4px);
  border-color: rgba(79, 70, 229, 0.2);
  box-shadow:
    0 20px 40px rgba(0, 0, 0, 0.08),
    0 8px 16px rgba(79, 70, 229, 0.06);
}
```

Widget card rules:

- Card radius is `16px`.
- Card header padding is `10px 16px`.
- Card title is `14px`, `600`, `#111827`.
- Card subtitle is `11px`, `#9ca3af`.
- Card body background is `rgba(249,250,251,0.5)`.
- Do not put cards inside other cards.
- Use the card body for charts, tables, KPIs, source trails, and states.

### Category Badges

Use category badges in the top-right of widget headers when useful.

```tsx
<span
  style={{
    fontSize: 10,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    padding: "2px 8px",
    borderRadius: 6,
    border: "1px solid #dbeafe",
    background: "#eff6ff",
    color: "#2563eb",
  }}
>
  markets
</span>
```

Category colors:

| Category    | Background | Text      | Border    |
| ----------- | ---------- | --------- | --------- |
| `markets`   | `#eff6ff`  | `#2563eb` | `#dbeafe` |
| `crypto`    | `#fff7ed`  | `#ea580c` | `#fed7aa` |
| `analytics` | `#f5f3ff`  | `#7c3aed` | `#ede9fe` |
| `tools`     | `#f0fdf4`  | `#16a34a` | `#bbf7d0` |
| `india`     | `#fffbeb`  | `#d97706` | `#fde68a` |
| `heatmaps`  | `#fff1f2`  | `#e11d48` | `#fecdd3` |
| `sector`    | `#f0fdfa`  | `#0d9488` | `#99f6e4` |

### Loading, Empty, And Error UI

Every widget must implement all three states.

Loading state must use a shimmer skeleton, not a blank card or raw spinner.

```css
@keyframes shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}
.shimmer {
  background-image: linear-gradient(
    90deg,
    #e5e7eb 0%,
    #f3f4f6 50%,
    #e5e7eb 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: 6px;
}
```

Empty state should be centered inside the widget body with:

- An icon or simple visual marker
- A clear message
- A short hint for what to do next
- Minimum height of about `160px`

Error state should be centered inside the widget body with:

- A red icon container using `#fef2f2`
- Error icon/text using `#ef4444`
- Friendly message, not raw stack trace
- Small "Please try again later" or equivalent hint

### Design Tokens

Use only these UI chrome tokens unless data visualization semantics require additional chart colors.

| Token           | Value                                                        | Use                                 |
| --------------- | ------------------------------------------------------------ | ----------------------------------- |
| Primary         | `#4f46e5`                                                    | Active states, icons, hover borders |
| Primary light   | `#eef2ff`                                                    | Ticker badge and icon backgrounds   |
| Primary border  | `#e0e7ff`                                                    | Ticker badge border                 |
| Primary text    | `#4338ca`                                                    | Ticker badge text                   |
| Page background | `linear-gradient(to bottom, rgba(249,250,251,0.8), #ffffff)` | Outer shell only                    |
| Card background | `rgba(255,255,255,0.9)`                                      | Widget cards                        |
| Card header     | `rgba(255,255,255,0.95)`                                     | Card header row                     |
| Card body bg    | `rgba(249,250,251,0.5)`                                      | Card content area                   |
| Header bar      | `rgba(255,255,255,0.95)`                                     | Sticky header                       |
| Border default  | `rgba(229,231,235,0.8)`                                      | Card border and header border       |
| Border hover    | `rgba(79,70,229,0.2)`                                        | Card hover border                   |
| Text primary    | `#111827`                                                    | Titles and primary text             |
| Text secondary  | `#374151`                                                    | Body text and subheadings           |
| Text muted      | `#6b7280`                                                    | Secondary labels                    |
| Text hint       | `#9ca3af`                                                    | Subtitles, timestamps, captions     |
| Error red       | `#ef4444`                                                    | Error icons                         |
| Error bg        | `#fef2f2`                                                    | Error icon container                |

Typography:

| Use             | Size    | Weight | Color     |
| --------------- | ------- | ------ | --------- |
| Dashboard title | 15px    | 700    | `#111827` |
| Widget title    | 14px    | 600    | `#111827` |
| Widget subtitle | 11px    | 400    | `#9ca3af` |
| Body text       | 14px    | 400    | `#374151` |
| Hint / caption  | 12-13px | 400    | `#9ca3af` |
| Badge / label   | 10-12px | 600    | varies    |

Spacing:

| Use                   | Value       |
| --------------------- | ----------- |
| Header height         | `48px`      |
| Main padding          | `24px 32px` |
| Mobile/narrow padding | `24px`      |
| Grid gap              | `20px`      |
| Card radius           | `16px`      |
| Card header padding   | `10px 16px` |

Interactions:

```css
transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
```

### Pre-Submission UI Checklist

- [ ] Layout uses exactly 3 zones: sticky header, scrollable main, optional footer.
- [ ] Header is 48px, blurred white, and has bottom border `#e5e7eb`.
- [ ] Active ticker appears as an indigo pill when selected.
- [ ] Active ticker is read from `context.market.selectedTicker`; no production ticker is hardcoded.
- [ ] Main content scrolls; body/root shell does not.
- [ ] Main content has `id="dashboard-main"` or `data-dashboard-capture-root="true"` for visual exports.
- [ ] Grid uses `repeat(auto-fill, minmax(340px, 1fr))` or wide `480px` variant.
- [ ] All data widgets use `WidgetCard`.
- [ ] Loading state uses shimmer skeleton.
- [ ] Empty state is present for no ticker or no data.
- [ ] Widgets wait for `context.session.token` before calling authenticated APIs.
- [ ] Error state is user-friendly and centered.
- [ ] No custom fonts are loaded; use `system-ui`.
- [ ] UI chrome uses indigo primary plus grayscale, not arbitrary bright colors.
- [ ] Dashboard works at `width: 100%` and `height: 100vh` inside an iframe.
- [ ] Dashboard implements `dashboard.capture.visual` using `html-to-image` and returns a `Blob`.
