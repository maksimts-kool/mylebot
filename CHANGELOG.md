# Changelog

All notable changes are recorded here.

## Unreleased

## 0.9.10 - 2026-07-19

- Cached and coalesced uncached Discord-to-Roblox Bloxlink lookups, preventing repeated concurrent calls for the same Discord member.

## 0.9.9 - 2026-07-19

- Resolved the Roblox username from Roblox's user API when Bloxlink returns only a numeric Roblox ID, so portal owner labels no longer fall back to `Roblox <id>`.

## 0.9.8 - 2026-07-19

- Added `POST /internal/notify`, an authenticated internal endpoint that lets the companion store-owners portal send Discord DMs through the bot's existing gateway connection. Gated by the new `SITE_NOTIFY_SECRET`; disabled when unset.
- Added a Bloxlink-verified member lookup for the portal's searchable store-owner picker, independent of game-session history.
- Portal notification messages can resolve an uploader's Roblox username through the bot's existing Bloxlink integration.

## 0.9.7 - 2026-07-13

- Updated dependencies: Fastify rate-limit 11, Zod 4, TypeScript 7, Vitest 4, and `@types/node` 26.
- Migrated to Prisma 7: the connection URL now lives in `prisma.config.ts`, the client connects through the `@prisma/adapter-pg` driver adapter, and `DATABASE_URL` is loaded from `.env` at runtime for local development.
- Bumped the release workflow to `actions/checkout@v5` and `actions/setup-node@v5` to clear the Node 20 deprecation warning.

## 0.9.6 - 2026-07-13

- Added `/session active [user]` so staff can see their own live session; viewing another member's still requires Admin.
- Kept a shift running when a player hops to another server, updating the tracked server id instead of ending the session on the old server's leave/shutdown.
- Stopped tracking Studio playtests and private (VIP or reserved) servers entirely.
- Deferred slow commands (`/session active`, `/session view`, `/leaderboard`) so Bloxlink and reporting lookups no longer blow past Discord's reply window, and hardened the interaction error handler so a failed error reply can't crash the bot.
- Clarified the `/session active` messaging so a Bloxlink-verified member who simply has no tracked session no longer sees a misleading "no linked Roblox identity" error.

## 0.9.5 - 2026-07-13

- Fixed the weekly leaderboard being labeled with the full month name (for example "July 2026") instead of the actual date range.

## 0.9.4 - 2026-07-12

- Fixed "Error: Invalid permission level"

## 0.9.3 - 2026-07-12

- Removed environment-based Discord session-channel and permission-role configuration.
- Made Discord server administrators responsible for initial logs-channel and role setup through `/config`, with settings stored in PostgreSQL.

## 0.9.2 - 2026-07-11

- Replaced the Discord configuration subcommands with a single interactive `/config` interface that applies updates automatically.
- Synchronized guild commands at startup and during command deployment, including removal of stale global commands.
- Hardened session lifecycle concurrency, health/readiness handling, processed-event retention, and Roblox event delivery behavior.
- Added coverage for the updated commands and runtime safeguards, plus repository-wide and mode-specific agent guidance.

## 0.9.1 - 2026-07-11

- Added configurable permission levels, tracking controls, and a runtime session-log channel.
- Made session history replies private and added close controls for private session views.
- Permanently remove a player's tracked data and session-log messages when they fall below the configured minimum rank.

## 0.9.0 - 2026-07-11

- Initial pre-1.0 release.
- Added automated GitHub releases for stable and beta tags.
