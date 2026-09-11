import type { Client, RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import type { FastifyPluginAsync } from "fastify";
import type { BloxlinkService } from "../shared/bloxlink.js";
import type { ConfigSection } from "../shared/discord/config-section.js";
import type { HelpSection } from "../shared/discord/help.js";
import type { RuntimeSettingsService } from "../shared/runtime-settings.js";
import type { BotLink } from "./bot-link.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./logger.js";
import type { ScheduledJob } from "./scheduler.js";

/** Everything a feature is allowed to assume exists before it is constructed. */
export interface FeatureContext {
  config: Config;
  db: Db;
  client: Client;
  log: Logger;
  settings: RuntimeSettingsService;
  bloxlink: BloxlinkService;
  /**
   * A handle on the other container when this process is the API half and
   * Discord lives elsewhere. `null` means the gateway is right here, so a
   * feature should do the work itself rather than ask for it.
   */
  bot: BotLink | null;
}

/**
 * A self-contained slice of the bot. A feature owns its HTTP routes, its slash
 * commands, its gateway listeners and its background jobs; `src/index.ts` only
 * composes them. Attach gateway listeners in the feature's factory — every
 * listener must ignore interactions that are not its own.
 */
export interface Feature {
  name: string;
  /** Slash commands contributed to the guild command set. */
  commands?: RESTPostAPIApplicationCommandsJSONBody[];
  /**
   * Routes that need nothing but the database, registered in their own
   * encapsulated Fastify scope. These run wherever the API runs.
   */
  routes?: FastifyPluginAsync;
  /**
   * Routes that can only be answered where the Discord gateway is connected.
   * They run in the process that holds it; when the API is a separate
   * container, it forwards `patterns` there instead of answering them.
   */
  gatewayRoutes?: { plugin: FastifyPluginAsync; patterns: string[] };
  /**
   * Work this feature does on behalf of the API half when the two run as
   * separate containers. Registered only in the `bot` role, and never reachable
   * from outside the container network.
   */
  internalRoutes?: FastifyPluginAsync;
  /**
   * Settings pages this feature contributes to `/config`. `src/index.ts`
   * collects them from every composed feature and hands them to the
   * configuration feature, so features stay independent of one another.
   */
  configSections?: ConfigSection[];
  /** What `/help` lists for this feature. */
  help?: HelpSection;
  /** Runs before the HTTP server starts listening. Throwing aborts startup. */
  onStart?: () => Promise<void>;
  /** Runs after the Discord client is ready. Failures are logged, not fatal. */
  onReady?: () => Promise<void>;
  jobs?: ScheduledJob[];
  onShutdown?: () => Promise<void>;
}
