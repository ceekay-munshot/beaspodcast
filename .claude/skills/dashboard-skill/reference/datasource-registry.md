## Datasource Registry

The following datasources are available for dashboard development.

Dashboard implementations should:

- Use registered datasources whenever possible.
- Use `datasource.service` with `base_urls` to build the full API URL.
  - `fastapi` means call `https://fastapi.muns.io` + endpoint path.
  - `nestjs` means call `https://devde.muns.io` + endpoint path.
- Follow documented request and response contracts.
- Respect rate limits and cache recommendations.
- Use host-provided authentication.
- Handle API failures gracefully.
- Avoid introducing undocumented API dependencies.

<!-- GENERATED CONTENT - DO NOT EDIT MANUALLY -->

```yaml
base_urls:
  fastapi: https://fastapi.muns.io
  nestjs: https://devde.muns.io
datasources:
- id: web_search
  name: Web Search
  description: Search the public internet using Brave Search.
  service: fastapi
  endpoint: POST /tools/web-search
  auth:
    type: bearer_jwt
  rate_limit:
    requests_per_minute: 60
  request_fields:
  - field: query
    type: string
    required: true
    description: Search query
  - field: country
    type: string
    required: false
    description: Country code for localized results
  response_fields:
  - field: results
    type: array
    required: true
    description: Structured search results
  cache_ttl_seconds: 300
- id: web_reader
  name: Web Reader
  description: Read and extract content from one or more URLs.
  service: fastapi
  endpoint: POST /tools/web-reader
  auth:
    type: bearer_jwt
  rate_limit:
    requests_per_minute: 60
  request_fields:
  - field: urls
    type: string[]
    required: true
    description: URLs to extract content from
  - field: task
    type: string
    required: false
    description: Optional extraction objective
  response_fields:
  - field: results
    type: object
    required: true
    description: Extracted page content
  cache_ttl_seconds: 300
- id: news_search
  name: News Search
  description: Search recent news articles.
  service: fastapi
  endpoint: POST /tools/news-search
  auth:
    type: bearer_jwt
  rate_limit:
    requests_per_minute: 60
  request_fields:
  - field: query
    type: string
    required: true
  - field: country
    type: string
    required: false
  - field: from_date
    type: date
    required: false
  - field: to_date
    type: date
    required: false
  response_fields:
  - field: results
    type: array
    required: true
    description: News articles
  cache_ttl_seconds: 180
- id: document_search
  name: Document Search
  description: Search proprietary documents indexed in Pinecone.
  service: fastapi
  endpoint: POST /tools/document-search
  auth:
    type: bearer_jwt
  rate_limit:
    requests_per_minute: 60
  request_fields:
  - field: query
    type: string
    required: true
  - field: user_index
    type: integer
    required: true
  - field: ticker_symbol
    type: string|string[]
    required: false
  - field: from_date
    type: date
    required: false
  - field: to_date
    type: date
    required: false
  - field: categories
    type: string[]
    required: false
  - field: doc_indexes
    type: string[]
    required: false
  response_fields:
  - field: structured_data
    type: array
    required: true
  - field: citations
    type: array
    required: false
  cache_ttl_seconds: 120
- id: muns_chat
  name: Muns Chat
  description: Stream an AI answer for a dashboard question using Muns chat context, documents, tickers, and dashboard inputs.
  service: nestjs
  endpoint: POST /chat/chat-muns
  auth:
    type: bearer_jwt
  rate_limit:
    requests_per_minute: 30
  request_fields:
  - field: tasks
    type: string[]
    required: true
    description: User question or task list. Usually provide one dashboard-specific question.
  - field: query_context.chatHistory
    type: object[]
    required: true
    description: Prior chat messages. Use [] for a new dashboard query.
  - field: query_context.TICKER_SYMBOL
    type: string[]
    required: false
    description: Tickers relevant to the dashboard.
  - field: query_context.FROM_DATE
    type: date
    required: false
    description: Start date for time-bounded analysis.
  - field: query_context.TO_DATE
    type: date
    required: false
    description: End date for time-bounded analysis.
  - field: query_context.DOCUMENT_IDS
    type: string[]
    required: false
    description: Uploaded document UUIDs to ground the answer.
  - field: query_context.DOC_INDEX
    type: integer[]
    required: false
    description: Internal document indexes when already known.
  - field: query_context.DASHBOARD_INPUTS
    type: object[]
    required: false
    description: Dashboard extraction inputs to forward into the model context.
  - field: query_context.mode
    type: enum
    required: false
    description: fast or expert. Defaults to expert.
  - field: chat_id
    type: string
    required: false
    description: Existing chat ID when continuing a prior chat.
  response_fields:
  - field: stream
    type: text/event-stream
    required: true
    description: Raw streamed answer chunks from Muns AI.
  - field: X-Chat-Id
    type: header
    required: true
    description: Chat ID created or reused for the request.
  - field: X-Message-Id
    type: header
    required: true
    description: Message ID for the streamed response.
  cache_ttl_seconds: 0
- id: agent_run
  name: Agent Run
  description: Run a registered analyst agent and stream its output for dashboard generation or refresh workflows.
  service: nestjs
  endpoint: POST /agents/run
  auth:
    type: bearer_jwt
  rate_limit:
    requests_per_minute: 20
  request_fields:
  - field: agent_id
    type: string
    required: false
    description: Active analyst UUID. Provide either agent_id or agent_library_id, not both.
  - field: agent_library_id
    type: string
    required: false
    description: Library agent UUID. Provide either agent_library_id or agent_id, not both.
  - field: user_query
    type: string
    required: false
    description: Specific dashboard question or run objective.
  - field: metadata
    type: object
    required: false
    description: Run context such as stock_ticker, from_date, to_date, urls, or autoAddUpcoming.
  - field: DASHBOARD_INPUTS
    type: object[]
    required: false
    description: Dashboard extraction inputs to include in agent context.
  - field: CATEGORIES
    type: string[]
    required: false
    description: Categories to include in the agent query context.
  - field: WRITING_STYLES
    type: string[]
    required: false
    description: Optional registered writing style names for output formatting.
  response_fields:
  - field: stream
    type: text/event-stream
    required: true
    description: Raw streamed agent output.
  - field: X-Active-Analyst-Id
    type: header
    required: true
    description: Active analyst ID used for the run.
  - field: X-Analyst-Output-Id
    type: header
    required: true
    description: Analyst output ID where the run is persisted.
  cache_ttl_seconds: 0
- id: portfolio_list
  name: Portfolio List
  description: Retrieve the user's portfolio or watchlist items with stock details such as ticker, company, sector, and industry.
  service: nestjs
  endpoint: GET /portfolio/list
  auth:
    type: bearer_jwt
  rate_limit:
    requests_per_minute: 60
  request_fields: []
  response:
    type: object[]
    fields:
    - field: id
      type: string
      required: true
      description: Portfolio item UUID.
    - field: ticker
      type: string
      required: true
      description: Stock ticker symbol.
    - field: rank
      type: integer
      required: true
      description: Ordering or ranking position of the portfolio item.
    - field: createdAt
      type: datetime
      required: true
      description: Timestamp when the portfolio item was added.
    - field: groupId
      type: string
      required: true
      description: Portfolio or watchlist group UUID.
    - field: company_name
      type: string
      required: false
      description: Full company name.
    - field: country
      type: string
      required: false
      description: Country where the company operates.
    - field: sector
      type: string|null
      required: false
      description: Company sector classification.
    - field: industry
      type: string|null
      required: false
      description: Company industry classification.
  cache_ttl_seconds: 300
- id: email_send
  name: Email Send (Raw)
  description: Send a transactional email (subject + HTML or plain-text body) to a single recipient. Used to deliver designed dashboard content — reports, editions, briefs — to a user's inbox.
  service: nestjs
  endpoint: POST /email/send/raw
  auth:
    type: bearer_jwt
  rate_limit:
    requests_per_minute: 30
  request_fields:
  - field: email
    type: string
    required: true
    description: Recipient email address. Exactly one recipient per request.
  - field: subject
    type: string
    required: true
    description: Email subject line.
  - field: html
    type: string
    required: false
    description: HTML email body. Provide EITHER html OR text — exactly one, never both, never neither. Use inline styles and table layouts for email-client (Gmail) compatibility.
  - field: text
    type: string
    required: false
    description: Plain-text email body. Mutually exclusive with html.
  response_fields:
  - field: success
    type: boolean
    required: true
    description: Whether the email was accepted for delivery.
  - field: message
    type: string
    required: true
    description: Human-readable status (e.g. "Email sent successfully!") or error reason.
  - field: data
    type: object
    required: false
    description: Nested envelope; data.message carries the server's detail message.
  cache_ttl_seconds: 0
auth_defaults:
  timeout_seconds: 30
  retry_attempts: 3
  retry_backoff_factor: 2.0
  ssl_verify: true
naming_conventions:
  dashboard_file_prefix: dashboard_
  component_file_prefix: component_
  hook_prefix: use
  constant_prefix: DASHBOARD_
```

<!-- END GENERATED CONTENT -->
