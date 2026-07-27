---
name: dashboard-skill
description: Build Munshot embedded financial dashboards with standard UI, SDK/auth context, datasource, export, layout, and dashboard pattern rules.
---

# Dashboard Skill

Use this skill when building or reviewing Munshot embedded dashboards. It defines how dashboards should look, how they communicate with the Munshot host, which APIs they may call, and how common financial dashboard types should be structured.

Dashboards built with this skill should feel native to Munshot: iframe-ready, consistent, source-aware, and suitable for repeated financial analysis.

## How To Use This Skill

Read only the reference files needed for the task, then follow them strictly.

Recommended order for building a new dashboard:

1. `reference/ui-standards.md`
2. `reference/auth-standards.md`
3. `reference/datasource-registry.md`
4. `reference/dashboard-patterns.md`
5. `reference/examples.md`

## Reference Files

- `reference/ui-standards.md`
  - Mandatory 3-zone iframe layout
  - sticky header
  - widget grid
  - `WidgetCard`
  - loading, empty, and error UI states
  - visual export capture target
  - design tokens and UI checklist

- `reference/auth-standards.md`
  - Munshot Dashboard SDK requirements
  - host context contract
  - JWT/session handling
  - selected ticker handling
  - `useHostContext`
  - SDK communication patterns
  - visual snapshot request channel

- `reference/datasource-registry.md`
  - registered datasources
  - backend service mapping
  - base URLs
  - request and response fields
  - auth and rate-limit expectations

- `reference/dashboard-patterns.md`
  - dashboard hierarchy inside Zone 2
  - filters/context, KPIs, primary analysis, insights, detail, and source widgets
  - dashboard variants such as screeners, heatmaps, sector intelligence, brand discounts, document intelligence, and watchlists
  - state, table, source, and performance standards

- `reference/examples.md`
  - compact dashboard blueprints
  - example widget roles by dashboard type

## Non-Negotiable Rules

- Build the actual dashboard as the first screen, not a landing page.
- Use the 3-zone iframe shell from `ui-standards.md`.
- Use `WidgetCard` for all data widgets.
- Use the Munshot Dashboard SDK and host context; do not create standalone auth.
- Read bearer token from `context.session.token`.
- Read ticker from `context.market.selectedTicker`.
- Use only datasources registered in `datasource-registry.md`.
- Show source/provenance for web, news, document, AI, or extracted data.
- Implement loading, empty, error, partial-data, and visual export states.
