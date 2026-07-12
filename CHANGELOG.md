# Changelog

All notable changes are recorded here.

## Unreleased

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
