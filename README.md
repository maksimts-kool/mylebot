# Discord–Roblox Session Tracker

A TypeScript service that receives authenticated Roblox presence events, maintains staff sessions in PostgreSQL, and keeps one Discord embed updated for each session. It supports inactivity, cross-place reconnects, editable history, custom-period leaderboards, Docker development, and Portainer deployment behind an existing NPMplus proxy.

## Architecture

- Roblox server scripts validate group rank and send idempotent batches. A small client script reports input/movement; the shared secret exists only in `ServerScriptService`.
- Fastify validates authentication, IDs, timestamps, rank eligibility, replay attempts, ordering, batch size, and rate limits.
- PostgreSQL stores identities, sessions, exact state segments, Discord message references, processed event IDs, and audit entries. Deletion is soft deletion.
- Discord.js publishes live/final embeds and implements `/session` and `/leaderboard` with persistent buttons and modals.
- Bloxlink lookups are cached on identities. Existing cached links remain usable during an API outage.

All database timestamps are UTC. Report dates are complete calendar days in `REPORT_TIMEZONE` (Tallinn by default): the start is inclusive and the day after the selected end is exclusive. Leaderboards sort and filter on active plus inactive time; reconnecting gaps are excluded.

## Discord and Roblox setup

1. Create a Discord application and bot. Enable installation in one guild and grant it View Channel, Send Messages, Embed Links, Read Message History, and Use Application Commands in the session channel.
2. Copy `.env.example` to `.env`, fill all required Discord, Roblox, PostgreSQL, and secret values, then generate a long random `ROBLOX_INGESTION_SECRET` (at least 32 characters is recommended).
3. Install dependencies and deploy guild commands:

   ```powershell
   npm ci
   npm run commands:deploy
   ```

4. Open [`roblox/Install.lua`](roblox/Install.lua), paste the entire file into Roblox Studio's Command Bar, and run it. No Rojo installation is required. It automatically creates the configuration and server script in `ServerScriptService` and the client script in `StarterPlayerScripts`.
5. Configure `ServerScriptService.SessionTrackerConfig`, then repeat the installer in every place. See [`roblox/README.md`](roblox/README.md) for details. Never move the configuration into `ReplicatedStorage` or include its secret in the client script.

The commands are:

- `/session add user` opens a form to add a completed session for a Bloxlink-linked Discord user. `/session manage sessionid` shows a completed session with Edit and Remove buttons. Both are restricted to `DISCORD_ADMIN_ROLE_IDS` (or Discord administrators), and all changes produce audit entries.
- `/session view user` and `/leaderboard`: available to configured staff roles, administrators, and eligible Bloxlink-linked staff.
- Live sessions cannot be edited or removed through `/session manage`.
- Live session messages expose Join Server, View History, and Refresh controls. Ended messages remove Join Server and add calendar-year total and previous-session information.

Manual durations accept values such as `2h 15m 30s`; active plus inactive must exactly equal end minus start. ISO timestamps such as `2026-07-11T12:00:00+03:00` are accepted.

Automatic inactivity is set in the server-only Roblox `SessionTrackerConfig` module: `InactiveSeconds = 300` by default. After that much time without client input or verified character movement, the next `HeartbeatSeconds` check (30 seconds by default) records the player as inactive. The backend `.env` does not control this threshold.

## Local Docker workflow

```powershell
Copy-Item .env.example .env
# Edit .env before continuing.
docker compose up --build
docker compose logs -f app
Invoke-WebRequest http://127.0.0.1:3000/health
```

The API is published only on `127.0.0.1:3000` by default; PostgreSQL is not published. The app waits for PostgreSQL health and automatically runs `prisma migrate deploy` before startup. Data remains in the `postgres_data` volume. A normal `docker compose down` retains it; do not add `--volumes` unless permanent database deletion is intended.

Run the simulator from a shell whose environment contains the same Roblox settings and secret:

```powershell
$env:ROBLOX_INGESTION_SECRET = "..."
$env:ROBLOX_UNIVERSE_ID = "..."
$env:ROBLOX_ALLOWED_PLACE_IDS = "..."
npm run simulate
```

It submits join, activity, inactivity, cross-server reconnect, and shutdown events. The final message transitions to Ended after `RECONNECT_GRACE_SECONDS`.

For Studio or a published Roblox server, create an optional Cloudflare quick tunnel:

```powershell
cloudflared tunnel --url http://localhost:3000
```

Put the generated HTTPS origin (without a trailing slash) in `SessionTrackerConfig.IngestionBaseUrl`. Quick-tunnel URLs are temporary; use a named tunnel for repeatable testing.

## Portainer and NPMplus

Create a Portainer Git stack using `compose.portainer.yml`. Enter every secret as a stack environment variable; do not commit `.env`. Portainer builds only the app and PostgreSQL services. Leave `APP_BIND_IP=127.0.0.1`; PostgreSQL has no host port or external network.

In the separately managed, host-networked NPMplus stack, create one proxy host (for example `sessions.example.com`):

- Scheme: `http`
- Forward host/IP: `127.0.0.1`
- Forward port: `3000`
- Enable a public certificate, HTTPS redirect, and HTTP/2.
- Expose only NPMplus ports 80/443 publicly. Do not open port 3000 in the VPS firewall.

Set `TRUST_PROXY=loopback`. The app accepts forwarded headers only from loopback, while the public Roblox endpoint still requires its bearer secret and enforces replay, payload-size, timestamp, and request-rate controls. Configure Roblox with `https://sessions.example.com/v1/roblox/presence/batch` (the script appends the path to its base URL).

To update the stack:

1. Back up the `postgres_data` volume according to the VPS backup policy.
2. Pull/redeploy the Git stack in Portainer with image rebuilding enabled.
3. Watch the app logs for a successful `prisma migrate deploy` and Discord login.
4. Verify `https://sessions.example.com/health` through NPMplus.
5. Run the simulator against the public base URL and verify duplicate IDs are reported as duplicates rather than creating another session.

## Development and verification

```powershell
npm ci
npm run prisma:generate
npm test
npm run typecheck
npm run build
```

The focused unit tests cover state overlap, reconnect-excluded accounting, manual duration invariants, inclusive rank limits, configured IDs, stale timestamps, Tallinn DST day boundaries, minimum filtering, and total-time leaderboard ordering. Database/Discord integration tests require disposable PostgreSQL and Discord test credentials; use the simulator and deployment checklist for those external flows.

## Ingestion contract

`POST /v1/roblox/presence/batch` requires `Authorization: Bearer <ROBLOX_INGESTION_SECRET>` and JSON `{ "events": [...] }`. Each event contains a UUID `eventId`, `JOIN|HEARTBEAT|LEAVE|SHUTDOWN`, an offset-bearing ISO timestamp, universe/place/job IDs, and a player snapshot. Accepted event IDs are persisted; retries are safe. Events older than the configured age or older than the session's latest event are not applied.

Sessions enter Reconnecting after leave, shutdown, or heartbeat loss. Rejoining any configured place before the two-minute default deadline reuses the same session and message and updates the join target; the reconnecting gap is not counted as active or inactive time. On restart, the service sweeps stale sessions and restores unfinished Discord messages using the same rules.
