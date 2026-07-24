# Discord–Roblox Session Tracker

A Node.js service that records eligible Roblox group members' play sessions in PostgreSQL and publishes session information and reports to Discord. Roblox servers send authenticated presence events to an HTTP API; the service validates and processes those events, maintains session state, and exposes the resulting data through Discord messages and slash commands.

## Features

- Tracks active, inactive, reconnecting, and completed Roblox sessions across places in one universe.
- Accepts authenticated, batched Roblox events with payload validation, rate limiting, event-age checks, ordering, and idempotency.
- Persists identities, sessions, time segments, processed events, runtime settings, Discord message references, and audit records in PostgreSQL through Prisma.
- Publishes and periodically refreshes session-log messages in Discord.
- Provides session history, manual session administration, and timezone-aware leaderboards.
- Resolves Roblox and Discord identities through Bloxlink when an API key is configured.
- Mirrors the Discord bug-report and suggestion forums onto a Taiga kanban board, keeping post tags in step with the board and announcing every change.
- Includes Docker Compose definitions for local deployment and Portainer stacks.
- Includes server and client Lua components for each Roblox place.

## How it works

1. The Roblox package monitors player joins, activity, departures, and server shutdowns. It queues events and posts batches to `POST /v1/roblox/presence/batch` with a shared bearer secret.
2. The Fastify API authenticates the request and validates the universe, place, group rank, timestamps, and event payload.
3. The session service applies events in order and stores transitions in PostgreSQL. A departure or shutdown moves a session to `RECONNECTING`; a qualifying join during the grace period resumes it, otherwise the session ends.
4. The Discord publisher creates or updates the corresponding session-log message. Scheduled jobs sweep reconnecting or stale sessions, refresh live messages, and remove expired event-deduplication records.
5. Discord slash commands query the same persisted data for history and reports. Administrative changes are audited.

The code is organised as feature modules. Each feature owns its HTTP routes, slash commands, gateway listeners, and background jobs, and [`src/index.ts`](src/index.ts) only composes them:

- [`src/core/`](src/core/): configuration, database client, HTTP server, Discord client, job scheduler, and the `Feature` contract.
- [`src/shared/`](src/shared/): cross-feature services — Bloxlink, runtime settings, permission levels, reusable components.
- [`src/features/sessions/`](src/features/sessions/): Roblox session tracking — [ingestion route](src/features/sessions/api/routes.ts), [lifecycle service](src/features/sessions/service/session-service.ts), [Discord publisher](src/features/sessions/discord/publisher.ts), and [commands](src/features/sessions/discord/commands/).
- [`src/features/portal/`](src/features/portal/): the store-owners portal's internal endpoints.
- [`src/features/taiga/`](src/features/taiga/): the Taiga board integration.
- [`prisma/schema.prisma`](prisma/schema.prisma): PostgreSQL data model.
- [`roblox/`](roblox/): Roblox server and client sender package.

To add a feature, write a `createXFeature(ctx): Feature` factory and register it in [`src/index.ts`](src/index.ts); nothing else in the tree has to change.

## Prerequisites

For a native development setup:

- Node.js 24 or newer
- npm
- PostgreSQL
- A Discord application and bot added to the target guild
- A Roblox experience and group

For container deployment, Docker Engine with Docker Compose is sufficient; the supplied Compose files run PostgreSQL 17 alongside the application.

Roblox must be able to reach the ingestion endpoint over HTTPS. Do not expose a plain HTTP endpoint to production Roblox servers.

## Configuration

Copy [`.env.example`](.env.example) to `.env` and replace its placeholder values. In PowerShell:

```powershell
Copy-Item .env.example .env
```

Comma-separated ID settings must not contain surrounding quotes. Roblox IDs are decimal strings.

### Database

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Prisma PostgreSQL connection URL. The example uses the Compose service hostname `db`; use a host such as `127.0.0.1` for a natively installed database. |
| `POSTGRES_USER` | PostgreSQL user created by Compose. |
| `POSTGRES_PASSWORD` | PostgreSQL password. Replace `change-me`; Compose requires this value. |
| `POSTGRES_DB` | PostgreSQL database created by Compose. |

### Discord and Bloxlink

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Discord bot token. If empty, the service starts in API-only mode. |
| `DISCORD_APPLICATION_ID` | Discord application ID, required for command deployment. |
| `DISCORD_GUILD_ID` | Guild where commands are installed and Bloxlink mappings are resolved. |
| `BLOXLINK_API_KEY` | Optional Bloxlink API key. Without it, uncached Discord↔Roblox mappings cannot be resolved. |
| `BLOXLINK_BASE_URL` | Bloxlink API base URL; normally leave the default unchanged. |

The Discord server owner or another member with Discord's Administrator permission performs initial setup through `/config`. Select the session logs channel and assign staff, admin, and manager access to Discord roles there. These settings are stored in PostgreSQL; the logs channel and role assignments are not configured through environment variables.

### Roblox ingestion

| Variable | Purpose |
| --- | --- |
| `ROBLOX_INGESTION_SECRET` | Shared bearer secret used by the backend and Roblox package. The application requires at least 16 characters; use a randomly generated value of at least 32 characters. |
| `ROBLOX_UNIVERSE_ID` | Positive universe ID accepted by the API. |
| `ROBLOX_GROUP_ID` | Positive group ID used for rank validation. |
| `ROBLOX_ALLOWED_PLACE_IDS` | One or more positive, comma-separated place IDs accepted by the API. |
| `ROBLOX_MIN_RANK` | Lowest tracked group rank, from 0 to 255. |
| `ROBLOX_MAX_RANK` | Highest accepted group rank, from 0 to 255. Must not be lower than the minimum. |

A valid event with a rank below `ROBLOX_MIN_RANK` intentionally purges that player's stored identity, sessions, audit and processed-event records, and published Discord messages. A rank above `ROBLOX_MAX_RANK` is rejected without performing that purge.

### Store-owners portal integration

| Variable | Purpose |
| --- | --- |
| `SITE_NOTIFY_SECRET` | Shared bearer secret for the store-owners portal endpoints. Empty (the default) disables them. When set, it must be at least 16 characters and match the site's `BOT_NOTIFY_SECRET`. |

The companion [store-owners portal](../myle-storeowners) calls `POST /internal/notify` so it can send Discord DMs through this bot's existing gateway connection instead of logging in a second client. It also calls `GET /internal/verified-members` to populate its searchable store-owner picker. That endpoint lists every current guild member with Bloxlink's **Verified** role, independently of their session history. Both requests use `Authorization: Bearer <SITE_NOTIFY_SECRET>`.

The notification request carries a JSON body:

```json
{ "discordId": "123456789012345678", "title": "Upload received", "message": "…", "color": 3901635, "url": "https://…" }
```

The bot fetches the user and sends an embed DM. Responses: `200` sent, `401` bad secret, `503` endpoint disabled (no secret configured), `422` the recipient has DMs closed or shares no server with the bot, `502` any other send failure. Discord only permits DMs to users who share a guild with the bot and have DMs enabled.

### Taiga integration

| Variable | Purpose |
| --- | --- |
| `TAIGA_USERNAME` / `TAIGA_PASSWORD` | Taiga account the bot logs in as. Taiga issues no long-lived API keys, so the bot exchanges these for a short-lived token it refreshes itself. Both are held in memory only and never logged. |
| `TAIGA_PROJECT_SLUG` | Project slug from the board URL — for `https://tree.taiga.io/project/my-project/kanban`, that is `my-project`. |
| `TAIGA_WEBHOOK_SECRET` | Secret key of the Taiga webhook. Empty disables `POST /v1/taiga/webhook`. |
| `TAIGA_BASE_URL` / `TAIGA_WEB_URL` | API host and the host humans browse. Defaults suit taiga.io; change both for a self-hosted instance. |
| `TAIGA_RECONCILE_SECONDS` | How often the safety sweep re-reads the board. Defaults to 600. |

`TAIGA_USERNAME`, `TAIGA_PASSWORD`, and `TAIGA_PROJECT_SLUG` must be set together. Leaving them empty disables the feature completely: no `/taiga` command, no webhook route, no forum listener, and no privileged Discord intents requested.

**Discord setup.** The integration reads the first message of each forum post, which needs the privileged **Message Content** intent — enable it under *Bot → Privileged Gateway Intents* in the Discord Developer Portal, or every card is created with an empty description. The bot also needs **View Channel**, **Read Message History**, **Send Messages**, and **Manage Threads** in both forums; Manage Threads is what allows it to set tags and archive posts. Each forum needs tags named `New`, `Approved`, `In progress`, and `Declined` (matched case-insensitively). Those four are the only tags the bot touches: a forum's own `Bug`/`Suggestion` category tag, or anything staff add by hand, is preserved across column changes.

**Taiga setup.** In *Project settings → Integrations → Webhooks*, add a webhook pointing at `https://<your-bot-host>/v1/taiga/webhook` with the same secret key as `TAIGA_WEBHOOK_SECRET`. The board needs columns named `Suggested`, `Planned`, `In progress`, `Done`, and `In game`.

Then run `/taiga` in Discord to pick the two forums and the notifications channel, and switch the integration on. `/taiga` also shows a health block that names any column or forum tag it cannot resolve.

**Behaviour.**

| Event | Result |
| --- | --- |
| New post in either forum | A user story is created in `Suggested`, tagged `bug` or `suggestion` in Taiga, with the post's first message as the description, a link back to the thread, and `Created by: @name (Discord ID …)`. The post is tagged `New`. |
| Card moved to `Planned` or `In progress` | Post is tagged `Approved` + `In progress`. |
| Card moved to `Done` or `In game` | Post is tagged `Approved` only. Reaching `In game` also archives the post. |
| Card deleted in any column except `In game` | Post is tagged `Declined` and archived. |
| Card deleted in `In game` | Nothing changes on the post; the bot just stops tracking it. |
| Forum post deleted | The Taiga card is deleted with it. |
| Epic created, changed, or closed | Announced in the notifications channel; closing one lists the posts it shipped. Epics are report-only — link cards to them yourself in Taiga. |

Enabling the integration stamps an activation time, and **posts older than that are never touched** — switching it on does not back-fill the existing forums.

Every change is announced in the notifications channel. Taiga webhooks drive updates in real time; a reconcile sweep re-reads the board every `TAIGA_RECONCILE_SECONDS` and repairs anything a missed delivery dropped, including while the bot was restarting. The sweep only treats a card as deleted when the whole board was read successfully, so a failed API call cannot mass-decline the forums.

### Server and timing

| Variable | Purpose |
| --- | --- |
| `API_HOST` / `API_PORT` | Address and port used by the Fastify server. Compose fixes the container listener to `0.0.0.0:3000`. |
| `APP_BIND_IP` / `APP_PORT` | Host-side bind address and port used by Compose. Defaults to `127.0.0.1:3000`. |
| `TRUST_PROXY` | `loopback` to trust local reverse proxies, or `false` to disable proxy trust. |
| `REPORT_TIMEZONE` | IANA timezone used for report boundaries and manual local date input. |
| `RECONNECT_GRACE_SECONDS` | Time allowed for a player to reconnect before a session ends. |
| `HEARTBEAT_STALE_SECONDS` | Time without a heartbeat before a live session is treated as disconnected. |
| `DISCORD_UPDATE_SECONDS` | Interval for refreshing live Discord messages. |
| `MAX_BATCH_SIZE` | Maximum accepted events per request. Keep this at least as large as the Roblox sender's batch size, currently 100. |
| `MAX_EVENT_AGE_SECONDS` | Maximum age accepted for incoming events. |
| `PROCESSED_EVENT_RETENTION_DAYS` | Retention period for event IDs used for deduplication. |

## Install and prepare the database

Install exactly the dependency versions in [`package-lock.json`](package-lock.json), then generate the Prisma client:

```powershell
npm ci
npm run prisma:generate
```

For a local development database, set `DATABASE_URL` to that database and create/apply a development migration:

```powershell
npm run prisma:migrate
```

For an existing deployment or production database, apply committed migrations without creating a new one:

```powershell
npm run prisma:deploy
```

The Docker image runs `prisma migrate deploy` automatically before starting the service. After changing [`prisma/schema.prisma`](prisma/schema.prisma), regenerate the client and create the appropriate migration. Do not rely only on the Prisma schema when recreating the database: committed migrations also contain the partial unique index that permits only one non-deleted live session per identity.

## Run locally

With PostgreSQL running and `.env` configured, start the TypeScript development server:

```powershell
$env:NODE_OPTIONS = "--env-file=.env"
npm run dev
```

The default API address is `http://127.0.0.1:3000`. Check it with:

```powershell
Invoke-WebRequest http://127.0.0.1:3000/health
Invoke-WebRequest http://127.0.0.1:3000/ready
```

`/health` is a process liveness check. `/ready` also runs a database query and returns HTTP 503 when PostgreSQL is unavailable.

To submit a complete test scenario to a running instance, load `.env` through Node and run the simulator:

```powershell
$env:NODE_OPTIONS = "--env-file=.env"
npm run simulate
```

The simulator sends join, activity, inactivity, reconnection, and shutdown events. Optional overrides are `SIMULATOR_BASE_URL`, `SIMULATOR_RANK`, `SIMULATOR_USER_ID`, and `SIMULATOR_USERNAME`.

## Docker deployment

### Docker Compose

After creating `.env`, build and start the application and database:

```powershell
docker compose up --build -d
docker compose ps
Invoke-WebRequest http://127.0.0.1:3000/ready
```

The default [`compose.yml`](compose.yml) configuration:

- binds the application only to `127.0.0.1:3000` unless `APP_BIND_IP` or `APP_PORT` is changed;
- does not publish PostgreSQL to the host;
- stores PostgreSQL data in the `postgres_data` named volume;
- waits for PostgreSQL readiness and runs Prisma deployment migrations during application startup.

Place a TLS-terminating reverse proxy in front of the application for Roblox traffic. If the proxy runs on the same host, the default loopback binding and `TRUST_PROXY=loopback` are appropriate. Deliberately set `APP_BIND_IP=0.0.0.0` only when external host access is required and protected by network controls.

### Portainer

[`compose.portainer.yml`](compose.portainer.yml) is intended for a Portainer stack. It reads values from Portainer's stack environment rather than an `env_file` and marks the core Discord, Roblox, and PostgreSQL values as required. Add the variables from [`.env.example`](.env.example) to the stack environment, then deploy the stack from the repository.

### Operational logs

The application writes structured JSON logs to standard output. Startup, initial session sweeping, Discord bootstrap, and scheduled-job registration, completion, and failure are logged with phase, job, duration, or aggregate-count fields as applicable. Successful authenticated ingestion batches log only aggregate event outcomes and changed-session/message counts.

Fastify request logging redacts authorization, cookie, API-key, and response-cookie values. Batch payloads, player identifiers, and credentials are not included in the application completion logs. View container logs with `docker compose logs --follow app`. If the app health check cannot reach `/ready`, Docker records a concise `readiness check failed` diagnostic in the container health-check output; the check continues to depend only on API readiness and PostgreSQL, not Discord.

## Roblox setup

Install the package in **every place** listed in `ROBLOX_ALLOWED_PLACE_IDS`:

1. In Roblox Studio, enable **Game Settings → Security → Allow HTTP Requests**.
2. Follow the instance hierarchy in [`roblox/README.md`](roblox/README.md).
3. Copy [`roblox/server/Config.example.lua`](roblox/server/Config.example.lua) into a server-only `Config` ModuleScript.
4. Set `IngestionBaseUrl` to the public HTTPS origin of this service, without the API path.
5. Set `IngestionSecret` to exactly the same value as `ROBLOX_INGESTION_SECRET`.
6. Set `GroupId`, `MinimumRank`, and `MaximumRank` consistently with the backend.
7. Publish each place.

Keep the configuration and secret under `ServerScriptService`; never place them in a LocalScript, ReplicatedStorage, source control, or client-visible object. The included LocalScript reports activity only and does not contain credentials.

## Discord commands

The service synchronizes guild commands when the bot becomes ready and `DISCORD_GUILD_ID` is configured. To deploy command definitions separately, run:

```powershell
npm run commands:deploy
```

This command requires `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_GUILD_ID`. It removes legacy global commands and replaces the target guild's command definitions. Run it after changing command shapes when deployment is performed separately.

Available commands and permissions:

| Command | Access | Purpose |
| --- | --- | --- |
| `/leaderboard [period]` | Everyone | Shows the staff leaderboard for this week, month, year, or all time. Its public controls are limited to the caller and expire after 15 minutes of inactivity. |
| `/session active [user:<member>]` | Staff | Shows a live session. Staff see their own; viewing another member's requires Admin. |
| `/session view user:<member>` | Staff | Shows a member's paginated session history. |
| `/session add user:<member>` | Admin | Adds an audited completed session for a Bloxlink-mapped member. |
| `/session manage sessionid:<id>` | Admin | Opens controls to edit or soft-delete a completed session. Live sessions cannot be managed manually. |
| `/config` | Manager | Opens an ephemeral panel for the logs channel, tracking state, and role permission assignments. |
| `/taiga` | Manager | Opens an ephemeral panel for the Taiga integration: the two forums, the notifications channel, the on/off switch, a configuration health check, and a manual reconcile. Only deployed when Taiga credentials are configured. |

Permission levels are cumulative: manager includes admin and staff access, and admin includes staff access. Manual session forms accept local values such as `11/07/2026 14:30` in `REPORT_TIMEZONE`; ISO timestamps are also accepted. Manual totals must equal the session's wall-clock duration.

## Scripts and tests

| Command | Description |
| --- | --- |
| `npm run dev` | Runs the service with `tsx` in watch mode. |
| `npm run build` | Compiles TypeScript into `dist/`. |
| `npm run typecheck` | Checks TypeScript without emitting files. |
| `npm test` | Runs the Vitest suite once. |
| `npm run test:watch` | Runs Vitest in watch mode. |
| `npm run simulate` | Sends a representative presence lifecycle to a running API. |
| `npm run release -- <M\|R\|B>` | Increments the major, release, or beta version, creates a commit and tag, and pushes both to GitHub. |
| `npm run commands:deploy` | Replaces Discord guild command definitions. |
| `npm run prisma:generate` | Generates the Prisma client. |
| `npm run prisma:migrate` | Runs Prisma's development migration workflow. |
| `npm run prisma:deploy` | Applies committed migrations. |

Run one test file or one named test with:

```powershell
npx vitest run tests/sessions/api.test.ts
npx vitest run tests/sessions/api.test.ts -t "accepts an authenticated event"
```

Tests mirror the source layout: `tests/sessions/`, `tests/portal/`, `tests/taiga/`, and `tests/shared/`.

The usual validation sequence is:

```powershell
npm test
npm run typecheck
npm run build
```

### Create a release

Run the release helper from a clean Git working tree. `M` increments the first version number (`1.2.3` → `2.0.0`), `R` increments the second (`1.2.3` → `1.3.0`), and `B` increments the third (`1.2.3` → `1.2.4`):

```powershell
npm run release -- B
```

The helper updates [`package.json`](package.json) and [`package-lock.json`](package-lock.json), creates a `chore(release): vX.Y.Z` commit and matching `vX.Y.Z` Git tag, then pushes the current branch and tag to the GitHub `origin` remote. The push is not attempted if the worktree is dirty or `origin` is not hosted on GitHub.

## Troubleshooting

- **Configuration fails at startup:** ensure the universe and group IDs are positive, at least one positive place ID is configured, the ingestion secret has at least 16 characters, the rank range is valid, and `REPORT_TIMEZONE` is a valid IANA timezone.
- **`/ready` returns 503:** verify `DATABASE_URL`, PostgreSQL health, DNS/hostname selection, and that migrations have been applied. The hostname `db` works inside Compose but normally not from a native host process.
- **Roblox requests return 401:** the Roblox `IngestionSecret` and backend `ROBLOX_INGESTION_SECRET` differ, or an intermediary removed the `Authorization: Bearer …` header.
- **Events are rejected:** confirm the sender uses the configured universe and an allowed place, its clock is accurate, and its group rank is within the configured maximum. Also keep the sender's batch size compatible with `MAX_BATCH_SIZE`.
- **Discord commands are absent or stale:** confirm the token, application ID, and guild ID, then run `npm run commands:deploy`. The bot also synchronizes commands after a successful Discord login.
- **A Discord user cannot be mapped:** configure `BLOXLINK_API_KEY`, confirm the Bloxlink link exists in `DISCORD_GUILD_ID`, and check API warnings. Successful and empty mappings are cached for 24 hours after lookup.
- **No session messages appear:** have the Discord server owner or an administrator select a logs channel through `/config`, and ensure the bot can view the channel and send messages and embeds there.

## Security and operational notes

- Treat `.env`, the Discord token, Bloxlink API key, database password, and Roblox ingestion secret as credentials. Do not commit or log them.
- Use a strong, unique ingestion secret and expose ingestion only through HTTPS.
- Keep PostgreSQL private. The supplied Compose files do not publish its port.
- The API limits requests to 120 per minute and request bodies to 256 KiB, but these controls do not replace reverse-proxy and network-level protections.
- Set `TRUST_PROXY` only for the documented deployment topology; accepting untrusted forwarded addresses can undermine IP-based rate limiting.
- Back up the `postgres_data` volume before upgrades or destructive maintenance.
- Session removal through Discord is a soft deletion with an audit entry. The below-minimum-rank purge is intentionally permanent and broader.
