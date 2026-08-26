---
name: server-contract
description: Backend engineering contract for apitest-server (Fastify + raw pg + SQL migrations). Use when adding or changing anything in apitest-server — routes, response envelopes, error codes, auth/RBAC, SQL queries, migrations, DB-to-API mapping, secret handling, pagination, or execution history. Also use when reviewing whether a backend change matches existing conventions, and before starting a backend feature with a different model or in a fresh session.
---

# apitest-server contract

The backend is deliberately thin: Fastify routes talk to Postgres through raw
parameterized SQL. There is no ORM, no service layer, and no validation
library. That is a choice, not an omission — do not introduce Drizzle, Prisma,
zod, or a `services/` layer to "improve" it. Consistency across sessions
matters more than any individual preference.

**Entry:** `src/index.ts` · **DB pool:** `src/db.ts` · **Envelope:**
`src/lib/response.ts` · **Row mappers:** `src/models/types.ts` ·
**Migrations:** `migrations/*.sql` (runner: `src/migrate.ts`)

## Stack (do not change without being asked)

Fastify 5 · `@fastify/jwt` · `@fastify/cors` · `pg` (`Pool`, raw SQL) ·
TypeScript `strict` · ESM (`"type": "module"`, `module: NodeNext`) · tsx for
dev · pnpm · Postgres 16 via `compose.yaml`.

**Relative imports must carry the `.js` extension** — `from "../db.js"`, not
`"../db"`. NodeNext ESM resolution fails at runtime without it, and `tsc`
will not catch it for you.

## The seven rules

1. **Every response goes through the envelope.** `success(data, meta?)` and
   `fail(reply, httpStatus, code, message)` from `src/lib/response.ts`. The
   shape is `{ code, message, data }`, `code: 0` on success. Never
   hand-build a response object; never return a bare payload. The one
   existing exception (`environments.ts:156`, which returns `data` alongside
   a non-zero code so the client can show the dependency list) is a
   deliberate variance — match it only when a client genuinely needs the
   payload of a failure.

2. **A route handler returns early on refusal, and the guard already replied.**
   `currentUser()` / `requireProjectAccess()` send the 401/403/404 themselves
   and return `undefined`. The caller's only job is `if (!context) return;`.
   Never send a second reply after a guard failed.

3. **Authorization is a guard call, not a check you write inline.** Anything
   under `/api/v1/projects/:id/**` calls
   `requireProjectAccess(request, reply, write)` and uses the returned
   `context.project.id` in SQL — never `request.params.id` directly. Pass
   `write = true` for POST/PUT/PATCH/DELETE, which is what excludes
   `viewer`. Non-project routes call `currentUser()`.

4. **All SQL is parameterized, and identifiers are never interpolated.**
   `$1` placeholders only. Build dynamic filters by pushing onto a `params`
   array and referencing `$${params.length}` (see
   `dashboard.ts:17-40` — that is the pattern to copy). Only fixed,
   code-authored fragments may be joined into a `WHERE` string; a value from
   the request never can.

5. **Validate a uuid before it reaches Postgres.** `isUuid()` from
   `src/lib/uuid.ts`. A malformed uuid hitting a `uuid` cast aborts the whole
   query, so a bad path param must become a clean 404 and a bad filter value
   must be dropped before the cast.

6. **The DB speaks `snake_case`; the API speaks `camelCase`.** The boundary is
   `src/models/types.ts`. Every row leaving a query passes through its
   `mapX()` function — `mapUser`, `mapProject`, `mapEnvironment`,
   `mapEndpoint`, `mapExecution`. A new table gets a new type plus a new
   mapper in that file. Never return `result.rows[0]` raw, and never let a
   `snake_case` key reach the client.

7. **Secret values never leave the server.** `mapEnvironment` exposes
   `secretKeys` (names only). Writes are a *patch*: `null` deletes a key, a
   string sets it, an absent key is left alone — because the client never
   held the plaintext and cannot send the full map back. Anything recorded
   into an execution snapshot goes through `sanitizeHeaders()` /
   `sanitizeValue()` first.

## Error codes

Canonical table (`API_AUTOMATION_SPEC.md:1146`):

| code | meaning | usual HTTP |
| --- | --- | --- |
| 0 | success | 200 / 201 |
| 1001 | 参数错误 — invalid or missing input | 400 |
| 1002 | 未认证 | 401 |
| 1003 | 无权限 | 403 |
| 2001 | 资源不存在 | 404 |
| 5001 | 内部错误 | 500 |

Also in use: `2002` request could not be prepared (400,
`endpoints.ts:358`), `2003` resource is referenced and cannot be deleted
(409, `environments.ts:156`).

**Known drift — do not copy it:** `environments.ts:102,122` return `1002`
(未认证) for a 409 duplicate-name conflict. New conflict responses should use
a resource-level code, not `1002`. Fix the existing two only if the task
covers them, since the frontend may switch on the current value.

## Routes

One file per resource in `src/routes/`, exporting one
`export async function xRoutes(app: FastifyInstance)`, registered in
`buildApp()` in `src/index.ts`. Adding a route file means adding its
`app.register(...)` there — nothing auto-discovers it.

Paths are `/api/v1/...`, project-scoped as
`/api/v1/projects/:id/<resource>`, where `:id` is always the project. A
nested resource uses its own named param (`:environmentId`, `:endpointId`).
`/health` is the only unprefixed route.

Type the generics on every handler — `app.get<{ Params: …; Querystring: …;
Body: … }>(…)`. That typed generic *is* the request contract; there is no
schema object.

Validation is hand-written and returns a message string, not a thrown error
(see `validate()` in `endpoints.ts:58`). Trim strings, uppercase methods,
check enum membership against a module-level `const` array. A PATCH
validates only the keys present — `validate(input, partial = true)`.

`201` for a create, via `reply.code(201).send(success(...))`. Everything else
returns `success(...)` directly.

## Persistence

- IDs are `randomUUID()` from `node:crypto`, generated in the handler and
  passed explicitly — the DB has no default.
- `jsonb` columns are cast at the call site (`$4::jsonb`) and written with
  `JSON.stringify`.
- `COUNT(*)` is always `COUNT(*)::int AS total`, then read through `Number()`
  — `pg` hands back `bigint` as a string otherwise.
- Multi-statement writes use `pool.connect()` with explicit
  `BEGIN` / `COMMIT` / `ROLLBACK` in `try` / `catch`, and
  `client.release()` in `finally` (`projects.ts:25-31`).
- Partial updates use `SET col = COALESCE($1, col)` with `null` meaning
  "unchanged".
- Aggregate per-entity counts as separate grouped sub-selects joined onto the
  parent. Joining sibling tables together multiplies rows and inflates every
  count (`dashboard.ts:41-59`).

## Migrations

Sequential, zero-padded, descriptive: `007_<snake_case_topic>.sql`. Applied
in filename order, each in a transaction, recorded in `schema_migrations`.

**Forward-only.** Never edit a migration that has been applied — a
`schema_migrations` row means it will never run again, so the change would
silently reach no existing database. Correct it with a new file.

Every statement is idempotent: `CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Enumerations are
`TEXT NOT NULL CHECK (col IN (...))`, not Postgres enums. Timestamps are
`TIMESTAMPTZ NOT NULL DEFAULT now()`. Foreign keys state their delete
behaviour explicitly (`ON DELETE CASCADE` for owned rows,
`ON DELETE SET NULL` where history must outlive the parent). Index the
columns you filter and sort on, named `<table>_<columns>_idx`.

Adding a column that the API returns means updating the mapper in
`src/models/types.ts` in the same change.

## History outlives its references

`executions` keeps `endpoint_name` and `environment_name` snapshots so a run
still reads correctly after the endpoint or environment is renamed or
deleted. When deleting a parent, backfill the snapshot *before* the FK nulls
the id (`environments.ts:160`). Extending execution history means extending
the snapshot, not adding a join.

## Delete semantics

A resource that others reference is not silently hard-deletable. Scan usage
first, return `409` with the dependency list as `data`, and only proceed when
the client re-submits with `?force=true` after the user has seen what breaks.
`scanUsage()` in `environments.ts:48` is the reference implementation, and
its `GET .../usage` twin exists so the UI can show consequences before the
confirm dialog.

## Pagination and filtering

`page` / `pageSize` query strings, clamped —
`Math.max(1, Number(page ?? 1))` and
`Math.min(100, Math.max(1, Number(pageSize ?? 20)))`. Return the rows as
`data` and `{ page, pageSize, total }` as `meta`. Filtering and keyword
search happen in SQL (`ILIKE '%kw%'`) so a match covers the whole result set
rather than the page already loaded.

## Style

Dense but explanatory. Short handlers may collapse onto one line, but every
non-obvious decision carries a comment saying **why** — the CORS `methods`
list, the uuid pre-check, the secret patch semantics, the sub-select
aggregation. Preserve those comments; they encode bugs already paid for.
Cite the spec (`Spec 4.6`) when a rule comes from it.

## Config and running

Env only, read inline with a fallback: `process.env.PORT ?? 3000`. New
variables go in `.env.example`. Logging is Fastify's built-in logger,
disabled when `NODE_ENV === "test"`; there is no logging util.

```bash
docker compose up -d      # postgres + redis
pnpm migrate              # apply pending migrations
pnpm dev                  # tsx watch, port 3000
pnpm check                # tsc --noEmit
```

There is **no backend test suite** and no test runner configured. Do not
invent one, and do not claim a change is verified because it compiles. Per
`AGENTS.md`, do not restart the service after a change; let the user restart
and test manually. Run `pnpm check` or `pnpm build` for validation only when
the user asks.
