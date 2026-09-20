# Changelog

All notable changes are recorded here.

## Unreleased

- Added Adonis command logging. Every command staff run is posted to Discord as its own embed, in a thread named after the Roblox server it ran in, carrying the command, who ran it, their rank and Adonis level, the risk, the server type and population, the job ID, and whoever it was run on. Risk is read from the permission level the command demands rather than from a list somebody has to maintain. Each embed offers a link straight into that server and a **Disable access 15m** button that takes the runner's command access away everywhere for fifteen minutes; pressing it needs one staff tier above the run, resolved through Bloxlink and the group rank. Private and reserved servers are never read, Studio playtests are logged while the switch on the new **Command logs** page of `/config` is on, and lookup-only commands such as `:cmds` are dropped. Install [`roblox/adonis/Server-CommandLogs.lua`](roblox/adonis/Server-CommandLogs.lua) into `Adonis_Loader → Config → Plugins` in every place.

## 0.14.3 - 2026-09-11

- Fixed a session being announced twice. Three things refresh a session's Discord messages independently — the stale-session sweep, the periodic refresh, and the presence endpoint — and two of them arriving together both saw "this shift has no message yet" and both posted one. Only one of the two was ever edited again, so the other stayed in the channel frozen as **Active** next to the same shift showing as **Ended**. Refreshes for one session now queue behind each other, and a message that loses the race is deleted instead of left behind.
- Rebuilt the logs. Every line is now date and time, level, category, who it is about, then a plain sentence: `2026-09-11 16:50:31  INFO   session   wolfik11111111    Session ended  total=19m19s  active=19m19s`. Shifts starting, ending, and going idle are logged by name, as are the commands staff run.
- Stopped the logs drowning in noise. The `/health` and `/ready` probes Docker polls every 15 seconds are no longer logged unless they fail or go slow, heartbeat batches that changed nothing are silent, and a scheduled job only says something when it actually did something. `LOG_LEVEL=debug` brings all of it back, and `LOG_FORMAT=json` switches to one object per line for a log shipper.
- Split the deployment into three containers — `server`, `bot`, and `db`. `server` stays the only published port and keeps every external URL the same: it answers the Roblox ingestion API itself and passes the endpoints that need Discord through to `bot`, which holds the gateway and runs the scheduled jobs. Migrations run in `server` alone, so the two can never race each other. Set `INTERNAL_SECRET` before deploying; a single-container deployment still works with `APP_ROLE=all`.

## 0.14.2 - 2026-09-10

- Made the staff chat shift announcement temporary: five minutes after a shift ends, or after a running shift is removed, the bot deletes its announcement so the channel does not fill up with finished shifts. The full record in the session logs channel is untouched. Announcements already sitting in the staff chat from earlier shifts are cleared on the first run after this update.
- Gave every `/config` page one shared set of presets for its embed, fields, buttons, and dropdowns, so pages contributed by different features look and behave the same. Each page now takes its title from its own menu entry, words an unconfigured setting the same way, and uses the same on/off switch, refresh button, and channel picker.

## 0.14.1 - 2026-09-10

- Restored the session-log message to its full record after v0.14.0 shortened it, and moved the shift announcement to its own message in a separately configured staff chat channel. The announcement mentions the member outside the embed, carries the `More info` button, and is edited in place when the shift ends.
- Added the staff chat channel to the session tracking page of `/config`. Leaving it unset switches announcements off without affecting the session logs.

## 0.14.0 - 2026-09-10

- Moved clickable verification member names from embed field titles into field values, where Discord renders Markdown links instead of showing their bracket syntax literally.
- Merged every server setting into one `/config` panel with a page per feature, and removed the separate `/taiga` command. Features now contribute settings pages through the `Feature.configSections` contract.
- Added a full role permission editor to `/config`: roles listed by the level they grant, with granting, changing, and revoking per role.
- Added `/help`, built from the features actually composed, marking which commands the caller's roles allow.
- Made `/session active` list every session running right now when no member is named; naming a member still shows that session in full.
- Rebuilt the published session message: the member is mentioned outside the embed, the embed announces the shift compactly, and a `More info` button replies privately with the full breakdown. The same message is still edited in place until the shift ends.
- Renamed the completed session message's `Last time played` field to `Previous session`.
- Replaced the grey embed colour on leaderboards, histories, and finished sessions with the server's main colour.
- Removed the reconnect grace period. A departure, shutdown, or stale heartbeat now ends the session at that instant, and a later join starts a new one. `RECONNECT_GRACE_SECONDS` is gone; sessions an older build left reconnecting are closed by the sweep.
- Made the release helper verify the branch, remote, tag, and changelog before cutting a release, run the test suite first, promote the `Unreleased` changelog section into the new version, and print recovery commands when a step fails after the version bump. Added `--dry-run`, `--skip-checks`, and `--allow-empty-changelog`.

## 0.13.3 - 2026-08-22

- Made every member display name in `/verification status` a clickable link that opens their Discord profile while keeping raw mention syntax hidden.
- Added regression coverage for clickable profile URLs across every paginated verification-status member card.

## 0.13.2 - 2026-08-22

- Fixed `/verification status` showing raw `<@user-id>` text in embed field titles by rendering each member's current server display name instead.
- Added regression coverage proving Discord IDs do not leak into the rendered dashboard while internal tracking continues to use stable IDs.

## 0.13.1 - 2026-08-21

- Redesigned `/verification status` as an emoji-rich private embed dashboard with summary metrics, reminder health, removal safeguards, a status legend, and paginated member cards for warning and kick deadlines.
- Kept status mentions non-notifying while making due removals, sent warnings, due warnings, waiting members, and newly untracked members visually distinct.

## 0.13.0 - 2026-08-21

- Added the private manager-only `/verification status` command, with a live Unverified-role member list, persisted final-warning delivery state, warning and removal deadlines, and the last and next general reminder times.
- Split large verification status lists safely across private Discord messages without pinging the listed members.
- Removed the standalone staffing demo, including its npm scripts, configuration, tests, local environment, and data-store surface.

## 0.12.0 - 2026-08-11

- Added a Discord-only Unverified-member verification feature for the configured server. It posts an `@Unverified` reminder every three days, gives members a 30-day period, sends a final individual warning on day 27, and removes members who still have the role three days later.
- Persisted verification deadlines and the reminder schedule in PostgreSQL, so restarts do not reset members' deadlines or shift the three-day cadence.
- Added the conditional Server Members gateway intent, configuration for the verification channel and Unverified role, Portainer wiring, and regression coverage for deadlines, restart cadence, warning batching, and removal safety.

## 0.11.0 - 2026-08-11

- Added rolling one-year retention for completed session and identity data, including related audit records, processed events, and published Discord message references.
- Made one minute of active plus inactive time the minimum completed session: shorter records are removed and excluded from history, yearly totals, and leaderboards.
- Made the bot's Discord custom status show `Running on vX.Y.Z` and update automatically during the release version bump.

## 0.10.0 - 2026-07-25

- Restructured the codebase into feature modules: `src/core/` (configuration, database, HTTP server, Discord client, scheduler, feature contract), `src/shared/`, and `src/features/{sessions,portal,taiga}/`. A feature now declares its own routes, commands, listeners, and jobs, and `src/index.ts` only composes them.
- Added the Taiga board integration. New posts in the bug-report and suggestion forums become cards in the `Suggested` column; moving a card retags its post (`New` → `Approved` + `In progress` → `Approved`), reaching `In game` archives it, and deleting a card in any other column marks the post `Declined` and archives it. Deleting a forum post deletes its card. Every change, plus epic activity, is announced in a notifications channel. Configure it with the new `/taiga` panel; enabling it never back-fills existing posts.
- Taiga updates arrive over a signature-verified webhook at `POST /v1/taiga/webhook`, with a periodic reconcile sweep that repairs anything a missed delivery dropped. The sweep only treats cards as deleted when the whole board was read, so a failed API call cannot decline every post at once.
- The Taiga sync owns only the four board-state forum tags; a forum's own `Bug`/`Suggestion` category tag and any tag staff add by hand survive a column change.
- Discord message intents are privileged, so they are requested only when Taiga is configured. Without Taiga credentials the feature registers nothing at all.
- Fixed a malformed presence payload answering `500` instead of `400`: a non-numeric Roblox ID threw inside the Zod transform rather than failing validation.
- Fixed `npm start`, which pointed at `dist/index.js` instead of the emitted `dist/src/index.js`.

## 0.9.11 - 2026-07-19

- Limited a public command's controls to the member who ran it, and disabled them after 15 minutes of inactivity.

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
