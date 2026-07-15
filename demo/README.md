# Staff Hiring & Rank Management — Demo

A **self-contained demo** of hiring and rank management for the lift game, living entirely
in Discord and driven by **Roblox group rank**. It is fully isolated from the production
`mylebot` service — see [Isolation](#isolation).

## What it does

Players **`/apply`** as a **Surfer** (→ Lift Surfer) or **Engineer** (→ Lift Engineer). The bot
opens a **private thread** and runs a guided questionnaire mixing:

- **Text questions** answered by typing in the thread, and
- **Practical questions** — an image (e.g. a cabinet control panel) plus **emoji buttons**
  ("which button do you press?") that are **auto-graded**.

On submit, a review card is posted to a review channel with the applicant's answers and a
**practical score**. A **track-matched supervisor** (or manager) accepts/rejects. On accept the bot:

1. sets the applicant's **Roblox group rank via Open Cloud** (so the game, Adonis, and the
   session tracker all pick it up — no in-game system), and
2. assigns the matching **Discord role**, records the hire, and notifies the applicant.

Managers can **`/staff promote`**, **`/staff demote`**, **`/staff view`**, **`/staff roster`**,
configure everything with **`/staff config`**, and edit the questionnaire interactively with
**`/staff questions`** (add/edit/reorder/remove text *and* practical questions).

### Ranks

| Rank | Track | Hirable | In-game (group rank) | Bot level |
|------|-------|---------|----------------------|-----------|
| LS Lift Surfer | Surfer | apply | cartop only | Staff |
| LE Lift Engineer | Engineer | apply | cabinet + cartop + Adonis | Staff |
| SS Surfers Supervisor | Surfer | promotion | oversees LS | Admin |
| ES Engineers Supervisor | Engineer | promotion | oversees LE | Admin |
| SM Staff Manager | Management | assigned | full control | Manager |

Governance: SS reviews/manages LS, ES reviews/manages LE, SM manages everyone below SM;
nobody can set a rank at or above their own. Discord Administrators count as SM.

## Run it

Offline, no Discord or database needed:

```powershell
npx tsx demo/simulate.ts        # or: npm run demo:simulate
npx vitest run --config demo/vitest.config.ts   # or: npm run demo:test
npx tsc -p demo/tsconfig.json --noEmit          # or: npm run demo:typecheck
```

Live Discord bot (the `demo` script loads `demo/.env` itself — do NOT set `NODE_OPTIONS`):

```powershell
Copy-Item demo/.env.example demo/.env   # then edit demo/.env: set DEMO_DISCORD_TOKEN + DEMO_GUILD_ID
npm run demo
```

Then in Discord: `/staff config` (set channels + rank→role/group-role) → `/staff questions`
(optional edits) → `/apply`.

### Prerequisites for the live bot

- **MessageContent** privileged intent — only for text questions (thread replies). A purely
  practical questionnaire needs no privileged intent.
- **Open Cloud API key** with group role-management scope, and the bot's group account must
  **outrank** LS/LE/SS/ES. Leave `DEMO_ROBLOX_OPEN_CLOUD_API_KEY` empty to run rank-sync in
  **dry-run** (logs the intended change) — the whole flow still works.
- Bot needs **Manage Roles** (its top role above LS/LE/SS/ES) and **Create Private Threads** /
  **Send Messages in Threads**.

## Isolation

Nothing here affects the production `mylebot` service:

- All code is under `demo/`, which the root `tsconfig.json` and `vitest.config.ts` **exclude** —
  `npm run build`, `npm run typecheck`, `npm test` are unchanged.
- No database: an in-memory store with optional JSON persistence at `DEMO_STORE_PATH`
  (`demo/.data/store.json`). No Prisma schema or migration changes.
- Its own entry point and its own Discord command set (`/apply`, `/staff …`). The production
  bot is never imported or modified.
- All environment variables are namespaced `DEMO_*`.

## Porting to production later

The demo store shapes in `demo/store/store.ts` map 1:1 to Prisma models
(`Application`, `StaffMember`, `StaffRankConfig`, `ApplicationQuestion`, plus `AuditEntry` and
`RuntimeSettings` fields). The pure logic in `demo/domain/` and the Open Cloud client in
`demo/services/roblox-open-cloud.ts` port unchanged; only the store/service wiring swaps to Prisma.
