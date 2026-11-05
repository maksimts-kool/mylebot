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

This starts three containers from one image:

- `server` — owns PostgreSQL and every integration: the Roblox API, command logs, the Taiga webhook, the portal endpoints, Bloxlink, and every scheduled job. It runs the migrations and is the only container published, on `127.0.0.1:3000`. It has no Discord token.
- `bot` — holds the Discord gateway and nothing else. It has no database connection and no published port. It gets data from `server` and posts what `server` asks it to.
- `db` — PostgreSQL 17.

The two app containers call each other on port `3001` over the compose network, authenticated with `INTERNAL_SECRET`. That port is never published. Keep it out of your reverse proxy too: the proxy only needs port `3000`. If `bot` is down, `server` keeps recording sessions, command runs and Taiga changes, and Discord catches up when `bot` reconnects. If `server` is down, slash commands answer with an error.

For Portainer on a host that already runs a shared PostgreSQL, deploy [`compose.portainer.yml`](compose.portainer.yml) as a Git stack from this repository, so a pull-and-redeploy follows `main`. Put the `.env` values in the stack environment. It has no bundled database: `server` connects to `shared-postgres` on the external `shared-db` network (override with `SHARED_DB_HOST` and `SHARED_DB_NETWORK`), and only `server` joins that network.

Setting `APP_ROLE=all` instead runs both halves in one process, which is what `npm run dev` does.

Put an HTTPS reverse proxy in front of the API — Roblox must reach it over HTTPS.

## Configuration

Every variable is listed in [`.env.example`](.env.example). The important ones:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection, used by `server` only. Use host `db` inside Docker, `127.0.0.1` outside it. |
| `POSTGRES_PASSWORD` | Database password for Compose. Change it. |
| `DISCORD_TOKEN` | Bot token, used by `bot` only. With `APP_ROLE=all`, empty runs the API only. |
| `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID` | Your Discord application and server. |
| `BLOXLINK_API_KEY` | Maps Discord accounts to Roblox accounts. |
| `ROBLOX_INGESTION_SECRET` | Shared secret with the Roblox game. Use 32+ random characters. |
| `ROBLOX_UNIVERSE_ID`, `ROBLOX_GROUP_ID`, `ROBLOX_ALLOWED_PLACE_IDS` | Which game, group, and places are accepted. |
| `ROBLOX_MIN_RANK`, `ROBLOX_MAX_RANK` | Group ranks that are tracked. |
| `REPORT_TIMEZONE` | Timezone for reports and typed dates, e.g. `Europe/Tallinn`. |
| `INTERNAL_SECRET` | Shared secret `server` and `bot` use with each other. Use 32+ random characters. |

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
| `/leaderboard [period]` | Everyone | Staff ranked by time this week, month, or year. |
| `/profile [user]` | Everyone | A member's profile card: Roblox avatar and rank, shift stats for the past 12 months, and badges. |
| `/badges` | Everyone | Every badge, how to earn it, and your own progress. Only you see it. |
| `/session active [user]` | Staff | Who is on shift now, or one member's live session. |
| `/session view user` | Staff | A member's session history. Admins can add, edit, and remove sessions from it. |
| `/config` | Manager | The settings panel. |
| `/verification status` | Manager | Unverified members and their deadlines. |
| `/help` | Everyone | Every command and whether you can run it. |

Manager commands and `/badges` reply privately; the rest reply in the channel. Commands sync automatically when the bot starts; `npm run commands:deploy` does it by hand.

### Badges

Badges are earned automatically and each one is announced to the member by DM, several new badges arriving together in one message. Everything counts from the member's first tracked shift, including shifts from before badges existed.

| Badge | How it is earned |
| --- | --- |
| 10, 50, 150, 500, 1000 hours | Active time on shift (inactive time does not count). |
| Staff of the month | Finishing a calendar month #1 on `/leaderboard`. Repeatable. |
| Top 3 | Finishing a calendar month in the top 3. Repeatable. |
| Veteran | One year since the member was first tracked. |

A month is ranked an hour after it ends in `REPORT_TIMEZONE`, starting with the month of the first tracked shift. Badges and the hours behind them are kept when old sessions are deleted, but a member purged for dropping below `ROBLOX_MIN_RANK` loses them too. A member with closed DMs still gets the badge.

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | Run with live reload. |
| `npm test` | Run the tests. |
| `npm run typecheck` | Check types. |
| `npm run build` | Compile to `dist/`. |
| `npm run simulate` | Send a fake session to a running API. |
| `npm run prisma:deploy` | Apply migrations to a deployed database. |

Code layout and the rules for changing it are in [`AGENTS.md`](AGENTS.md).

### Releasing

1. Describe the changes under `## Unreleased` in [`CHANGELOG.md`](CHANGELOG.md) and push to `main`.
2. On GitHub, open **Actions → Release → Run workflow** and pick `patch`, `minor`, or `major`. Or from a terminal:

   ```powershell
   gh workflow run release.yml -f bump=patch
   ```

GitHub runs the tests, raises the version, moves the changelog entries under it, then commits, tags, and publishes the release.

## Troubleshooting

- **Won't start:** a required variable is missing or invalid — the error names it.
- **`/ready` returns 503:** on `server`, the database is unreachable or migrations have not run. On `bot`, the Discord gateway is not connected yet.
- **Commands answer "could not be completed":** `bot` cannot reach `server`. Check that `server` is healthy and both containers have the same `INTERNAL_SECRET`.
- **Roblox gets 401:** the game's secret and `ROBLOX_INGESTION_SECRET` differ.
- **No session messages:** pick a logs channel in `/config` and check the tracking page's health.
- **Commands missing:** check the token and IDs, then run `npm run commands:deploy`.

## Data and security

- Never commit `.env` or share the tokens and secrets in it.
- Keep PostgreSQL private and back up the `postgres_data` volume before upgrades.
- Sessions under one minute are dropped. Sessions are kept for a year; command records for `PROCESSED_EVENT_RETENTION_DAYS`. Badges and the active time behind them are kept after their sessions are gone.
