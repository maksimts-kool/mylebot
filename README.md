# MyLE Bot

A Discord bot for the MyLE Roblox group. It tracks staff play sessions, logs Adonis commands, and links Discord forums to a Taiga board.

## Features

- **Session tracking** — Roblox servers report who is playing; the bot records each shift in PostgreSQL and posts it to Discord.
- **Leaderboards and history** — time per staff member by week, month, or year.
- **Adonis command logs** — every staff command, grouped per Roblox server, with a button to take someone's command access away for 15 minutes.
- **Taiga sync** — bug-report and suggestion forum posts become Taiga cards, and moving a card retags the post.
- **Verification cleanup** — reminds unverified members and removes them after 30 days.
- **Portal endpoints** — lets the store-owners portal send DMs and list verified members.

## Quick start

You need Node.js 24+, PostgreSQL (or Docker), a Discord bot in your server, and a Roblox experience and group.

```powershell
Copy-Item .env.example .env   # then fill it in
npm ci
npm run prisma:generate
npm run prisma:migrate        # development database only
$env:NODE_OPTIONS = "--env-file=.env"
npm run dev
```

Check it is up at `http://127.0.0.1:3000/health` and `/ready` (`/ready` also checks the database).

### Docker

```powershell
docker compose up --build -d
```

This starts three containers from one image: `server` (HTTP API, runs migrations), `bot` (Discord), and `db` (PostgreSQL 17). Only `server` is published, on `127.0.0.1:3000`. For Portainer, use [`compose.portainer.yml`](compose.portainer.yml) and put the `.env` values in the stack environment.

Put an HTTPS reverse proxy in front of the API — Roblox must reach it over HTTPS.

## Configuration

Every variable is listed in [`.env.example`](.env.example). The important ones:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection. Use host `db` inside Docker, `127.0.0.1` outside it. |
| `POSTGRES_PASSWORD` | Database password for Compose. Change it. |
| `DISCORD_TOKEN` | Bot token. Empty runs the API only. |
| `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID` | Your Discord application and server. |
| `BLOXLINK_API_KEY` | Maps Discord accounts to Roblox accounts. |
| `ROBLOX_INGESTION_SECRET` | Shared secret with the Roblox game. Use 32+ random characters. |
| `ROBLOX_UNIVERSE_ID`, `ROBLOX_GROUP_ID`, `ROBLOX_ALLOWED_PLACE_IDS` | Which game, group, and places are accepted. |
| `ROBLOX_MIN_RANK`, `ROBLOX_MAX_RANK` | Group ranks that are tracked. |
| `REPORT_TIMEZONE` | Timezone for reports and typed dates, e.g. `Europe/Tallinn`. |

Optional features switch on when their variables are set:

- **Verification** — `VERIFICATION_CHANNEL_ID` and `VERIFICATION_UNVERIFIED_ROLE_ID`.
- **Taiga** — `TAIGA_USERNAME`, `TAIGA_PASSWORD`, `TAIGA_PROJECT_SLUG`, and `TAIGA_WEBHOOK_SECRET`.
- **Portal** — `SITE_NOTIFY_SECRET`, matching the site's `BOT_NOTIFY_SECRET`.

> **Warning:** a player reporting a rank *below* `ROBLOX_MIN_RANK` is permanently deleted — sessions, records, and Discord messages. A rank *above* `ROBLOX_MAX_RANK` is only rejected.

### In Discord

A server administrator sets everything else with `/config`: tracking on/off, the logs and staff chat channels, command logs, Taiga forums, and which roles get Staff, Admin, or Manager access. Each page shows a health check when something is wrong.

The bot needs **View Channel**, **Send Messages**, **Embed Links**, and **Read Message History** in the channels it posts to. Some features need more:

| Feature | Extra Discord setup |
| --- | --- |
| Verification | **Server Members Intent**, **Kick Members**, bot role above `Unverified`. |
| Taiga | **Message Content Intent**, **Manage Threads** in both forums, and forum tags `New`, `Approved`, `In progress`, `Declined`. |
| Command logs | **Create Public Threads**, **Send Messages in Threads**, **Manage Threads**. |

### Taiga

Add a webhook in Taiga (*Project settings → Integrations → Webhooks*) pointing at `https://<your-host>/v1/taiga/webhook`, with the same secret as `TAIGA_WEBHOOK_SECRET`. The board needs the columns `Suggested`, `Planned`, `In progress`, `Done`, and `In game`. Only posts created after you switch the integration on are synced.

## Roblox setup

In every allowed place:

1. Turn on **Game Settings → Security → Allow HTTP Requests**.
2. Install the package as described in [`roblox/README.md`](roblox/README.md).
3. Copy [`roblox/server/Config.example.lua`](roblox/server/Config.example.lua) to a server-only `Config` module and set the API URL, the same secret as `ROBLOX_INGESTION_SECRET`, and the group and ranks.
4. For command logs, add [`roblox/adonis/Server-CommandLogs.lua`](roblox/adonis/Server-CommandLogs.lua) to `Adonis_Loader → Config → Plugins` as `Server-CommandLogs`.
5. Publish.

Keep the secret in `ServerScriptService` — never in anything the client can see.

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/leaderboard [period]` | Everyone | Staff ranked by time this week, month, year, or all time. |
| `/session active [user]` | Staff | Who is on shift now, or one member's live session. |
| `/session view user` | Staff | A member's session history. Admins can add, edit, and remove sessions from it. |
| `/config` | Manager | The settings panel. |
| `/verification status` | Manager | Unverified members and their deadlines. |
| `/help` | Everyone | Every command and whether you can run it. |

Manager commands reply privately; the rest reply in the channel. Commands sync automatically when the bot starts; `npm run commands:deploy` does it by hand.

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | Run with live reload. |
| `npm test` | Run the tests. |
| `npm run typecheck` | Check types. |
| `npm run build` | Compile to `dist/`. |
| `npm run simulate` | Send a fake session to a running API. |
| `npm run prisma:deploy` | Apply migrations to a deployed database. |
| `npm run release -- <M\|R\|B>` | Cut a major, release, or bugfix version from `CHANGELOG.md`. Add `--dry-run` to preview. |

Code layout and the rules for changing it are in [`AGENTS.md`](AGENTS.md).

## Troubleshooting

- **Won't start:** a required variable is missing or invalid — the error names it.
- **`/ready` returns 503:** the database is unreachable or migrations have not run.
- **Roblox gets 401:** the game's secret and `ROBLOX_INGESTION_SECRET` differ.
- **No session messages:** pick a logs channel in `/config` and check the tracking page's health.
- **Commands missing:** check the token and IDs, then run `npm run commands:deploy`.

## Data and security

- Never commit `.env` or share the tokens and secrets in it.
- Keep PostgreSQL private and back up the `postgres_data` volume before upgrades.
- Sessions under one minute are dropped. Sessions are kept for a year; command records for `PROCESSED_EVENT_RETENTION_DAYS`.
