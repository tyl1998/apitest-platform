# Project Collaboration Rules

## Validation Ownership

1. Do not run tests, browser automation, automated acceptance checks, or self-directed functional verification unless the user explicitly asks for testing.
2. Type checks and production builds also require an explicit user request when their purpose is validation. Commands strictly required to start the application may still be run.

## Change Handoff

1. After a frontend or backend code change, do not start or restart services automatically; leave service restarts to the user (e.g., `./start.sh --restart api worker`). Report the available local URLs and any startup blocker. Do not claim that behavior is verified unless the user asked for testing and the requested verification was performed.
2. Wait for the user to describe observed problems, then fix those problems in the next change.
3. Do not substitute agent-driven browser testing for the user's manual acceptance process.

## Large Edit Splitting

Large edits risk connection timeouts mid-stream. When an edit spans many functions, a large file, or multiple files, split the work into smaller, sequential steps instead of one giant change:

1. Plan the edit as an ordered list of steps; do not bundle unrelated changes.
2. Prefer **one function per edit** when the target file is large or heavily nested.
3. Prefer **one file at a time** when changes touch multiple files.
4. Finish, report, and (if safe) proceed step by step; between steps wait for the previous result rather than firing every change at once.

## Plan Tracking

1. After the user confirms a feature scope, update the corresponding phase in `DEVELOPMENT_PLAN.md` to reflect the confirmed scope, boundary decisions, and implementation status.
2. When a feature from the plan is implemented in code, check off or mark the item (e.g., `[x]` or **已实现**) so the plan stays current.
3. `DEVELOPMENT_PLAN.md` records **development content only**: features, scope, boundaries, decisions, and implementation status. It does **not** record bug fixes. Actual defects go to `issue_fix/` (see the index `issue_fix/README.md`); each record includes 现象 / 根因 / 修法 / 状态. When a fix arrives, keep the bug detail in `issue_fix/` and only reflect any resulting scope/decision change in the plan.

## Data Compatibility

The project is in active development and has never shipped. Do not write code to migrate, preserve, or remain compatible with historical data, old rows, or legacy formats — there is none to protect. When a clean schema or API shape conflicts with backward compatibility, prefer the clean one. Forward-only migrations still apply (never edit an already-applied migration file; add a new one instead), and a local dev database may be freely reset or recreated.

## Repository Hygiene — no company identifiers, no real credentials

These repos are **public on GitHub** — this one and every sibling (`apitest-server`, `apitest-web`, `apitest-runner`, `apitrack-sdk-python`, `apitest-e2e-python`). Nothing that identifies the company or grants access may leave the machine through a commit. That covers **everything that ships with the repo**: code, defaults, comments, docs, issue records, test data, fixtures, examples, and commit messages.

1. Never commit company-identifying material: the brand/company name in any casing, internal hostnames or domains, internal IPs, real business identifiers (`agentId`, store numbers, `fohNos`, tenant ids), or real credentials (API keys, tokens, passwords, MCP tokens).
2. Do not write the company name **in this file either** — describe it by shape when you must ("the brand name", "the internal domain"). To find occurrences, grep case-insensitively for the name exactly as it appears in the environment you were handed, and treat that string as a search key, never as text to add.
3. Anything committed uses placeholders: `***` for the name and host (`stgstplatform.***.net`), `ak-xxx` / `xxxx` for credentials, `example.com` for hosts in examples.
4. Real values live only in gitignored files (`apitest-server/.env`, `apitest-e2e-python/env.local.sh`, `.dev-certs/`). Code reads them from the environment; comments say **which variable to export**, not what the value is. If a value needs to be runnable, that is what the variable is for.
5. When a literal is functional rather than descriptive (a certificate path, a keychain filter name, a base-URL default), parameterize it through an environment variable instead of hardcoding the company value, so the repo keeps working without the name.
6. Before every commit or push, self-check what you staged: `git grep -ilI "<name>"` plus a credential-shape scan (`ak-[0-9a-f]{16,}`, `sk-…`, `Bearer <long>`, `eyJ…`), and do the same over the untracked-but-destined files. Never `git add -A` while a real credential sits in the working tree — confirm it is ignored first (`git check-ignore -v <file>`).
7. Redacting the working tree does **not** clean history. If the material already reached GitHub, say so plainly and let the user decide (history rewrite, private repo, key rotation); never rewrite published history or force-push on your own.

## Start / Stop Services

Repo-root convenience scripts manage the four app processes (backend API, execution worker, scheduler, frontend). **Postgres and Redis are external** (OrbStack / manually started docker), the scripts do not touch them.

- `./start.sh` — run migrations, then start API (3000) + worker + scheduler + web (5173). Add `--skip-migrate` to skip the migration step when the schema has not changed.
- `./start.sh --restart [api|worker|scheduler|web ...]` — stop the listed services (or all of them when none are named) and start them again. Useful after a backend change: `./start.sh --restart api worker` recycles only the two server-side processes while the frontend keeps running.
- `./stop.sh` — stop the four app processes (kills the whole `pnpm → tsx → node` process tree). Postgres/Redis stay running.

**Windows** (same semantics, PowerShell; `*.cmd` wrappers next to each script run with `-ExecutionPolicy Bypass` for double-click/cmd use):

- `.\start.ps1` / `.\start.ps1 -Restart api worker` / `.\start.ps1 -SkipMigrate` — behind `start.cmd`.
- `.\stop.ps1 [api worker ...]` — behind `stop.cmd`.
- `apitest-runner` has its own pair: `.\start.ps1 [start|fg|stop|restart|status] [cli|api]` and `.\stop.ps1 [-Force]`.
- Windows has no POSIX signals/`nohup`/`lsof`: background services run from a generated `.dev-logs\<name>.run.cmd` (`Start-Process`, hidden window, survives the terminal) and stop via `taskkill /T` on the pnpm→node tree; ports are probed with `TcpClient`.

Implementation details:

- Started processes write logs to `.dev-logs/{api,worker,scheduler,web}.log`; their PIDs are recorded in `.dev-pids` (`name=pid` lines). `stop.sh` kills from the pidfile first, then pattern-matches any leftovers.
- The execution queue is **never inlined into the API process**: runs stay `queued` until a worker is running. The worker is a separate process; `tsx watch` restarts only itself.
- The scheduler is the third backend process (cron tick / missed-run detection / alert dispatch); it is multi-instance safe but single instance is recommended.
- To stop the database containers too (data persists in volumes): `docker compose -f apitest-server/compose.yaml down`.

## Frontend Design System

Frontend UI work in `apitest-web` follows the **Quiet Console** visual contract (locked; do not reintroduce the rejected neon/glow direction). Before adding or changing any UI, load the `quiet-console` skill for the full contract; its rules take precedence over any summary in this file. The single source of truth is `src/design-system.css` (tokens), `src/ui.tsx` (primitives), and `src/theme.ts` (palette + antd bridge).

## Backend Engineering Contract

Backend work in `apitest-server` follows the **server-contract** (locked; the stack is deliberately thin — Fastify + raw parameterized `pg` SQL, no ORM, no validation library, no service layer). Before adding or changing any route, response, error code, SQL query, migration, or DB-to-API mapping, load the `server-contract` skill for the full contract; its rules take precedence over any summary in this file. The single source of truth is `src/lib/response.ts` (envelope), `src/models/types.ts` (row → API mapping), `src/lib/rbac.ts` (authorization), and `migrations/*.sql` (schema, forward-only).

Do not restructure the backend or swap its stack to match a different model's preferences. When a convention looks wrong, follow it and say so, rather than introducing a second pattern alongside it.
