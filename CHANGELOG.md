# Changelog

All notable changes are recorded here.

## Unreleased

- Updated dependencies: Fastify rate-limit 11, Zod 4, TypeScript 7, Vitest 4, and `@types/node` 26. Prisma stays on 6.x pending the driver-adapter migration required by Prisma 7.
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
