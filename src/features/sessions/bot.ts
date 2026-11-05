import type { BotContext, BotFeature } from "../../core/feature.js";
import { sessionCommandData, sessionHelp } from "./discord/commands/definitions.js";
import { SessionCommandHandler } from "./discord/commands/handler.js";
import { trackingConfigSection } from "./discord/config-section.js";
import { SessionMessenger } from "./discord/messenger.js";
import { SESSIONS_PORT, type SessionsServerPort } from "./link.js";

/**
 * Session tracking's Discord surface: the slash commands, the tracking page in
 * `/config`, and the hands the server half posts session messages and badge
 * DMs with. Every row it shows comes from the server half.
 */
export function createSessionsBot(ctx: BotContext): BotFeature {
  const sessions = ctx.server.port<SessionsServerPort>(SESSIONS_PORT);
  const messenger = new SessionMessenger(ctx.client, ctx.config, ctx.log);
  new SessionCommandHandler(ctx.client, ctx.config, sessions, ctx.shared).register();

  return {
    name: "sessions",
    commands: sessionCommandData,
    help: sessionHelp,
    configSections: [trackingConfigSection(ctx.client, sessions)],
    ports: { [SESSIONS_PORT]: messenger.port() },
  };
}
