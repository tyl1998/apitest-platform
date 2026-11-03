# Provider Onboarding: What a Third-Party Vendor Must Provide

> Audience: an **upstream agent platform** that will be plugged into this platform's in-app assistant.
> This platform does not implement an agent. It is a proxy:
> `browser → assistant proxy (SSE pass-through) → your agent platform → this platform's /mcp → database`.
> Onboarding = an administrator fills one **protocol config** (4 endpoints + SSE event mapping + auth template). No code change on our side.
>
> This document is vendor-neutral: the platform ships **no built-in vendor provider** (2026-10-22).
> Every upstream is one administrator-entered protocol config.
> This document answers: **what must your platform hand over before it can be configured as a working provider?**

---

## 0. Checklist

| # | Deliverable | Required | Purpose |
|---|---|---|---|
| 1 | Environment base URL | Yes | All paths are appended to it |
| 2 | Auth scheme and header shape | Yes | Renders the auth header |
| 3 | Create-conversation endpoint | Yes | First call of a new dialogue |
| 4 | Send-message endpoint (**must be SSE**) | Yes | Core path |
| 5 | **Raw SSE sample** of the chat stream | Yes | Event mapping is built from it |
| 6 | Stop-generation endpoint | Optional (no button if absent) | Interrupt mid-answer |
| 7 | Delete-conversation endpoint | Optional (local mapping only if absent) | User deletes a conversation |
| 8 | Message-history endpoint | Optional (live messages only if absent) | Replay on reopen |
| 9 | Attachment support | Optional | User sends images/files |
| 10 | Per-user credential list | Yes | User-parameter schema |
| 11 | A working test account | Yes | Connection test + joint debugging |

---

## 1. Eligibility

We only integrate **agent platforms with conversation management** — not bare LLM endpoints. Required:

1. **Conversation-aware**: you can create a conversation, return an id, and scope messages to it. This platform does not keep context for you.
2. **SSE streaming**: token-by-token deltas, not a single JSON response.
3. **Tool visibility**: when the agent calls tools on our MCP, execution status can appear in the stream.

If 1 or 2 is missing, change it on your side first; we cannot compensate for it.

---

## 2. Protocol config shape

This is what the administrator actually fills in (also the import/export format; **it contains no credentials**):

```json
{
  "name": "unique-provider-name",
  "protocol": {
    "baseUrl": "https://your-agent.example.com",
    "auth": { "header": "Authorization", "value": "Bearer {{user.apiKey}}" },
    "successCode": { "field": "code", "value": "0000" },
    "createConversation": { "...": "see 3.1" },
    "chat": { "...": "see 3.2" },
    "stop": { "...": "see 3.3" },
    "delete": { "...": "see 3.3" },
    "history": { "...": "see 3.4" },
    "attachments": true,
    "sse": { "...": "see 4" }
  },
  "userParams": [ "...see 5" ]
}
```

### 2.1 Common fields

| Field | Required | Notes |
|---|---|---|
| `baseUrl` | Yes | Must start with `http(s)://`; trailing slashes are stripped |
| `auth.header` | No | e.g. `Authorization` |
| `auth.value` | No | Header value **template**, e.g. `Bearer {{user.apiKey}}`. Real credentials are filled by each user, not here |
| `successCode.field` / `.value` | No | Business-code check: HTTP 200 with `field ≠ value` is a failure. **Both must be set** to take effect; otherwise only HTTP status is checked |

### 2.2 Endpoint fields

Every endpoint (`createConversation` / `chat` / `stop` / `delete` / `history`) shares:

| Field | Required | Notes |
|---|---|---|
| `method` | Yes | `GET` / `POST` / … |
| `path` | Yes | Must start with `/`; placeholders allowed (e.g. `/api/v1/chat/{{conversationId}}`) |
| `body` | No | JSON body template; values may contain placeholders |

---

## 3. The four endpoints

For each endpoint, provide: **method + path + request example + success response + failure response + auth requirement**.

### 3.1 Create conversation (`createConversation`, required)

| Need | Details |
|---|---|
| Method + path | e.g. `POST /api/v1/chat/conversation/add` |
| Request body | Fields required (agent id, variables, …) |
| **Where the conversation id lives in the response** | Dot path, e.g. `data` for `{"code":"0000","data":"57"}`, or `data.id`, or `id` |
| Id type | String or number (whole-placeholder values are sent as numbers, unquoted) |
| Failure response | Business-code field and failure value |

### 3.2 Send message (`chat`, required, **SSE**)

| Need | Details |
|---|---|
| Method + path | How the conversation id is carried (e.g. `POST /api/v1/chat/{{conversationId}}`) |
| Request body | Which field holds the user message (e.g. `message`); **whether the conversation id must also be repeated in the body** |
| Response header | Must be `Content-Type: text/event-stream` |
| **Raw event sample** | See section 4 — this decides success |
| Pre-stream failures | Status codes and JSON shape for bad params / unauthorized / unknown conversation (we branch on `Content-Type`: anything that is not an event stream is treated as a plain JSON error) |

> Be explicit about the conversation id: path only, body only, or both. Some platforms return `4000 conversationId is required` when only the path is given.

### 3.3 Stop / delete conversation (`stop` / `delete`, optional)

| Need | Details |
|---|---|
| Method + path | How `{{conversationId}}` is carried |
| Request body | If any |
| Success response | Shape (envelope with business code?) |

If `stop` is absent, the UI hides the stop button. If `delete` is absent, deleting a conversation only clears the local mapping and your copy stays.

### 3.4 History (`history`, optional)

| Need | Details |
|---|---|
| Method + path | Usually `GET` with `{{conversationId}}` |
| Pagination params | Query names for cursor and page size (we supply `{{index}}` / `{{limit}}`; you tell us which query keys they map to) |
| **Message array location** | Dot path in the response, e.g. `data` |
| **Per-message field names** | id / role / text / time |
| Role values | Which value means "user" (we treat `USER` case-insensitively as user; anything else is assistant) |
| Cursor semantics | "Last id/index of previous page" or offset |

### 3.5 Attachments (optional)

If the chat endpoint accepts attachments, provide:

- The field name (we always send an array under **`attachments`**);
- The per-item fields (we send `{ fileUrl, fileName, mimeType }`);
- **Whether you fetch by URL or expect an upload** (today we only pass URLs; we never carry the bytes);
- Allowed types / size limits, and whether URLs must be public or signed.

Otherwise leave `attachments` off; attachments are then never injected.

---

## 4. SSE stream: what we need — the critical part

We do not understand your event semantics. We only read **configured dot paths**. Provide a **real captured SSE stream** covering at least: normal answer chunk, a tool call, completion, an error, and a heartbeat, plus the table below.

### 4.1 Frame format

```
data: {"requestId":"...","eventType":"MESSAGE","data":{"text":"你"},"completed":false}
```

- Standard SSE parsing: **events separated by a blank line**, only `data:` lines are read (one leading space after `data:` is optional);
- Each `data:` payload must be **single-line JSON** (multi-line payloads are joined with `\n` and parsed as a whole — please avoid);
- `: comment` (keep-alive) lines are ignored. `event:` lines are supported only when you configure `on: "NAME@event"`; otherwise "what event is this" must live inside the JSON;
- We send a keep-alive comment every 15s regardless of yours.

### 4.2 Event mapping (fill in dot paths)

| Mapping | Required | What to tell us | Example |
|---|---|---|---|
| `sse.eventField` | Yes | Field that names the event type. If the kind rides on the SSE `event:` line instead of the JSON, set `eventField` and write `on` as `NAME@event` | `eventType` |
| `sse.token` | token or done required | Delta event name + text field (**text path may list alternatives separated by `\|`**) | `on: MESSAGE`, `text: data.text\|data.content` |
| `sse.done` | token or done required | Completion event name + full-text field | `on: FINAL_RESULT`, `text: data.outputText` |
| `sse.done.success` | Optional, recommended | Success flag; `false` becomes an error | `data.success` |
| `sse.token.success` / `sse.error.success` | Optional | Envelope-level failure rule for a 200 body: `{field, ok: [..]}` or `{field, not: false}` | `{field: "code", ok: ["0"]}` |
| `sse.error` | Recommended | Error event name + user-facing message field | (some runtimes send none; errors ride `done` + `success:false`) |
| `sse.tool` | Recommended | Tool event name + name/status fields + fallback name + **input** field | `on: PROCESSING`, `name: data.name`, `status: data.status`, `input: data.result.input` |
| `sse.ignore` | Optional | Events not to forward | `["HEART_BEAT"]` |
| `sse.elicit` | Optional | Confirmation-form event: event name (+ optional discriminator `type`/`typeValue`), text/tool paths, optional `schema` / `allowResume` | `on: MESSAGE`, `type: data.type`, `typeValue: ELICITATION` |
| `protocol.success` / `successCode` | Optional | Envelope failure rule for JSON endpoints (create / stop / delete / history) | `{field: "code", ok: ["0000"]}` |
| `protocol.attachmentsField` | Optional | Chat body field that carries the attachment array | `attachments` |
| `protocol.streamEnd` | Optional | `close` (default: drop the connection after the terminal event) or `continue` (read until the upstream closes) | `close` |

### 4.3 Semantics we must have answers to

1. **How a stream ends**: a dedicated `done` event, or connection close? We only recognize the end event; if the stream closes without one we synthesize a terminal state (text accumulated → `done`, nothing received → `error`).
2. **How errors are expressed**: separate `ERROR` event, or the completion event carrying `success: false`?
3. **Does the completion payload repeat the full text?** We treat it as the authoritative full answer; otherwise accumulated deltas are used.
4. **Heartbeat event name** — so it can be ignored.
5. **Long silence**: we cap silence at 60s between two chunks; if a task may stay silent longer, send heartbeats within that window.
6. **Rate limiting**: do you return HTTP 429 with `Retry-After`? We forward both.
7. **Concurrency on one conversation**: queue, reject, or interrupt?
8. **Mid-stream disconnection**: is the turn void? Is it billed?

### 4.4 Tool confirmation (pre-call dialog, since 2026-10-21)

Our MCP **no longer sends confirmation requests** (elicitation / MRTR removed; delete tools run
in one call). The only thing we need from you: **does your runtime show a pre-call confirmation
based on MCP `tools/list` annotations** — in particular `destructiveHint: true` on `delete_*`?

1. Do you read `annotations` and confirm before calling (yes / no / some tools);
2. Does the dialog show the tool name and input (can a human tell *which object* is affected);
3. On decline, is the call **not made** (rather than made and then reported as an error)?

If the answer is "no dialog", deletes in chat have no human confirmation step — decide your
Token scopes accordingly.

### 4.5 Example: a typical event set

```
data:{"eventType":"MESSAGE","data":{"text":"你"},"completed":false}
data:{"eventType":"PROCESSING","data":{"type":"Search","status":"EXECUTING","name":"知识库检索","result":{"input":{"id":12}}}}
data:{"eventType":"MESSAGE","data":{"type":"ELICITATION","text":"确认删除？","toolCallId":"call-1","elicitationSchema":{"type":"boolean"}}}
data:{"eventType":"FINAL_RESULT","completed":true,"data":{"success":true,"outputText":"完整回复"}}
data:{"eventType":"HEART_BEAT"}
```

---

## 5. Per-user credentials (`userParams`)

**We store no shared key.** Every assistant user fills in credentials issued by your platform. Tell us:

| Need | Details |
|---|---|
| Which parameters each user fills | Key, label, required, secret, placeholder |
| Where credentials come from | Which console/page; whether your admin must pre-create them |
| Binding | Is a credential bound to an agent? Should users also supply an agent id? |
| Secret parameters | Anything token-like must be stored encrypted and reported only as "configured" |
| Scope | What a credential can reach (project/data-domain restrictions?) |
| Revocation and rotation | How to revoke; expected behavior afterwards (401 → user re-enters) |
| Expiry | Do they expire? What is returned when expired? |

### 5.1 Example

```json
[
  { "key": "agentId", "label": "agentId", "secret": false, "required": true, "placeholder": "24" },
  { "key": "apiKey",  "label": "API Key", "secret": true,  "required": true, "placeholder": "ak-…" }
]
```

### 5.2 Placeholder vocabulary (fixed on our side; you only need to know where they may appear)

| Placeholder | Allowed in | Value |
|---|---|---|
| `{{user.key}}` | Auth header value, request body, path, history query | User-supplied parameter |
| `{{conversationId}}` | Path, body, history query | Created conversation id |
| `{{message}}` | Chat body only | User text |
| `{{index}}` / `{{limit}}` | History query only | Pagination cursor / page size |

> Keys: start with a letter, letters/digits/underscores, at most 20 params.
> A whole-placeholder value that renders to a number is sent as a number (unquoted).

### 5.3 What we inject on your behalf

- **Page-context block**: we append a fenced ` ```apitest-page-context ` block **after** `{{message}}` (current page, project, endpoint, etc., ≤ 2KB), so the message always starts with the user's own text. Your agent can use it or ignore it.
- **Attachments array**: only when `attachments` is enabled and the user actually attached files.

---

## 6. Test materials to provide

| Item | Details |
|---|---|
| Test environment URL | Separate from production; direct-reachable base URL (gateway? allowlist?) |
| Test agent | Published, with model quota |
| Test credentials | agentId + API key (**hand over out-of-band; never in this document or a ticket**) |
| Limits | QPS / concurrency / daily quota, and the response when exceeded |
| Network | Egress IP allowlisting, mTLS |
| Observability | requestId lookup, per-conversation logs on your side |

---

## 7. What we check (so you can pre-empt failures)

Our "Test connection" does: **create conversation → send `ping` → echo normalized events**.

| Symptom | Meaning |
|---|---|
| `protocol.baseUrl must be an http(s) URL` | Bad address |
| `protocol.createConversation/chat must define a method and a path starting with "/"` | Missing endpoint |
| `protocol.createConversation.conversationId must be a response field path` | Conversation id location unspecified |
| `protocol.sse.eventField must be the upstream event-type field` | No event-type field |
| `protocol.sse must define at least a token or done mapping` | Stream has no recognizable text/completion |
| `assistant upstream did not return a conversation id` | Conversation id path resolves empty |
| `... returned "application/json" instead of an event stream` | Chat endpoint is not SSE |
| Text arrives but never finishes | Missing completion event or heartbeats (60s silence cap) |
| HTTP 429 + `Retry-After` | Rate limited; users see "try again later" |

---

## 8. Known boundaries (align up front)

1. **We are a dumb pipe**: no context storage, no model routing, no text rewriting.
2. **Your error text is shown verbatim** to users — make it human-readable.
3. **Timeouts**: create / stop / delete / history **15s**; the chat stream measures silence **between chunks**, **60s** cap. Long tasks need tool-status events or heartbeats.
4. **Conversations belong to the provider**: switching the default provider does not affect existing conversations.
5. **Deleting a provider cascades** to conversations and user credentials; irreversible.
6. **Confirmation forms currently resolve via our own REST**, not an upstream resume channel; enabling resume needs a separate evaluation.
7. **Unsupported**: stateless one-shot completion endpoints, polling-style replies, server-side auto-approval of dangerous tools.

---

## 9. Fill-in template

```json
{
  "vendor": "vendor / product",
  "env": { "test": "https://…", "prod": "https://…" },
  "auth": { "header": "Authorization", "value": "Bearer {{user.apiKey}}" },
  "successCode": { "field": "code", "value": "0000" },
  "createConversation": {
    "method": "POST", "path": "/…", "body": { "agentId": "{{user.agentId}}" }, "conversationId": "data"
  },
  "chat": {
    "method": "POST", "path": "/…/{{conversationId}}",
    "body": { "conversationId": "{{conversationId}}", "message": "{{message}}" }
  },
  "stop":   { "method": "POST", "path": "/…/{{conversationId}}/stop" },
  "delete": { "method": "POST", "path": "/…/{{conversationId}}/delete" },
  "history": {
    "method": "GET", "path": "/…/{{conversationId}}/messages",
    "query": { "index": "{{index}}", "limit": "{{limit}}" },
    "messages": "data",
    "fields": { "id": "id", "role": "role", "text": "text", "time": "time" }
  },
  "attachments": false,
  "sse": {
    "eventField": "eventType",
    "token": { "on": "…", "text": "data.text" },
    "tool":  { "on": "…", "name": "data.name", "status": "data.status", "nameFallback": "data.type", "input": "data.result.input" },
    "done":  { "on": "…", "text": "data.outputText", "success": "data.success" },
    "error": { "on": "…", "message": "data.error" },
    "ignore": ["…"]
  },
  "userParams": [
    { "key": "agentId", "label": "agentId", "secret": false, "required": true },
    { "key": "apiKey",  "label": "API Key", "secret": true,  "required": true }
  ],
  "limits": { "qps": "…", "concurrency": "…", "dailyQuota": "…" },
  "notes": "concurrency semantics / disconnect outcome / heartbeat interval / 429 behavior"
}
```

Attach:

- [ ] **curl examples** for create / chat (SSE) / stop / delete / history (credentials masked)
- [ ] A **raw SSE capture** (normal / tool call / completion / error / heartbeat)
- [ ] A **failure-response** sample including the business-code field
- [ ] Working test-environment credentials (out-of-band)
