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

Keep the Roblox ingestion secret only in `.env` and `ServerScriptService.SessionTracker.Config`.
