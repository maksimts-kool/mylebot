# Discord-Roblox Session Tracker

Tracks eligible Roblox staff sessions in PostgreSQL and shows them in Discord.

## Setup

1. Copy `.env.example` to `.env` and fill in the Discord, Roblox, database, and secret values.
2. Install dependencies and deploy the Discord commands:

   ```powershell
   npm ci
   npm run commands:deploy
   ```

3. Add the Roblox scripts to every place. See [`roblox/README.md`](roblox/README.md).

## Discord permissions and configuration

Permission levels are fixed by feature: anyone can use `/leaderboard`, staff (level 2) can view session history, admins (level 3) can add, edit, and remove sessions, and managers (level 4) can run `/config`.

Set at least one bootstrap manager role in `DISCORD_MANAGER_ROLE_IDS` before starting the bot. Server administrators also have manager access. Managers can then use these commands in Discord:

- `/config logs` to set the channel where session log embeds are posted.
- `/config tracking` to pause or resume Roblox event tracking.
- `/config permission-set` and `/config permission-remove` to assign Discord roles staff, admin, or manager access.

The existing `DISCORD_STAFF_ROLE_IDS` and `DISCORD_ADMIN_ROLE_IDS` settings remain supported as initial role assignments. After changing slash commands, run `npm run commands:deploy`.

Manual session forms accept local dates such as `11/07/2026 14:30` in `REPORT_TIMEZONE`; ISO timestamps continue to work.

When a valid Roblox event reports a rank below `ROBLOX_MIN_RANK`, the bot permanently deletes that player's stored identity, sessions, related audit and processed-event records, and published session-log messages.

## Run locally

```powershell
docker compose up --build
Invoke-WebRequest http://127.0.0.1:3000/health
```

The app runs on `127.0.0.1:3000`; PostgreSQL is not exposed to the host.

## Development

```powershell
npm run prisma:generate
npm test
npm run typecheck
npm run build
```

## Releases

Use semantic versions: `v1.0.0` for stable releases and `v1.1.0-beta.1` for beta releases. Update `CHANGELOG.md`, run `npm version <version>`, then push the commit and tag:

```powershell
git push origin main --follow-tags
```

Pushing a matching `v<package-version>` tag runs checks and creates the GitHub release automatically. Prerelease tags, including beta versions, are marked as prereleases.

Keep the Roblox ingestion secret only in `.env` and `ServerScriptService.SessionTracker.Config`.
