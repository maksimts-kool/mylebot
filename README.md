# Discord–Roblox Session Tracker

A Node.js service that records eligible Roblox group members' play sessions in PostgreSQL and publishes session information and reports to Discord. Roblox servers send authenticated presence events to an HTTP API; the service validates and processes those events, maintains session state, and exposes the resulting data through Discord messages and slash commands.

## Features

- Tracks active, inactive, reconnecting, and completed Roblox sessions across places in one universe.
- Accepts authenticated, batched Roblox events with payload validation, rate limiting, event-age checks, ordering, and idempotency.
- Persists identities, sessions, time segments, processed events, runtime settings, Discord message references, and audit records in PostgreSQL through Prisma.
- Publishes and periodically refreshes session-log messages in Discord.
- Provides session history, manual session administration, and timezone-aware leaderboards.
- Resolves Roblox and Discord identities through Bloxlink when an API key is configured.
- Includes Docker Compose definitions for local deployment and Portainer stacks.
- Includes server and client Lua components for each Roblox place.

## How it works

1. The Roblox package monitors player joins, activity, departures, and server shutdowns. It queues events and posts batches to `POST /v1/roblox/presence/batch` with a shared bearer secret.
2. The Fastify API authenticates the request and validates the universe, place, group rank, timestamps, and event payload.
3. The session service applies events in order and stores transitions in PostgreSQL. A departure or shutdown moves a session to `RECONNECTING`; a qualifying join during the grace period resumes it, otherwise the session ends.
4. The Discord publisher creates or updates the corresponding session-log message. Scheduled jobs sweep reconnecting or stale sessions, refresh live messages, and remove expired event-deduplication records.
5. Discord slash commands query the same persisted data for history and reports. Administrative changes are audited.

The main components are:

- [`src/api.ts`](src/api.ts): authenticated ingestion and health endpoints.
- [`src/services/session-service.ts`](src/services/session-service.ts): session state transitions and persistence.
- [`src/discord/publisher.ts`](src/discord/publisher.ts): Discord session-log projection.
- [`src/discord/commands.ts`](src/discord/commands.ts): slash commands and permission handling.
- [`prisma/schema.prisma`](prisma/schema.prisma): PostgreSQL data model.
- [`roblox/`](roblox/): Roblox server and client sender package.

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
| `/leaderboard [period]` | Everyone | Shows the staff leaderboard for this week, month, year, or all time. |
| `/session active [user:<member>]` | Staff | Shows a live session. Staff see their own; viewing another member's requires Admin. |
| `/session view user:<member>` | Staff | Shows a member's paginated session history. |
| `/session add user:<member>` | Admin | Adds an audited completed session for a Bloxlink-mapped member. |
| `/session manage sessionid:<id>` | Admin | Opens controls to edit or soft-delete a completed session. Live sessions cannot be managed manually. |
| `/config` | Manager | Opens an ephemeral panel for the logs channel, tracking state, and role permission assignments. |

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
npx vitest run tests/api.test.ts
npx vitest run tests/api.test.ts -t "accepts an authenticated event"
```

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
