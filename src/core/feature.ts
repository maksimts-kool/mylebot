import type { Client, RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import type { FastifyPluginAsync } from "fastify";
import type { BloxlinkService } from "../shared/bloxlink.js";
import type { ConfigSection } from "../shared/discord/config-section.js";
import type { HelpSection } from "../shared/discord/help.js";
import type { RuntimeSettingsService } from "../shared/runtime-settings.js";
import type { SharedServerPort } from "../shared/server-port.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Peer } from "./link.js";
import type { Logger } from "./logger.js";
import type { ScheduledJob } from "./scheduler.js";

/**
 * The application runs as two halves, and every feature is written as two
 * halves to match. The *server* half owns the database and the integrations
 * (Roblox, Taiga, Bloxlink) and runs every scheduled job. The *bot* half owns
 * the Discord gateway and nothing else: it never holds a database client, and
 * reaches the server half's state only through the ports the server offers.
 *
 * A feature's `link.ts` is the contract between its halves: the ports each
 * side offers the other, and the shapes they exchange. `server.ts` and
 * `bot.ts` build the halves; `src/server.ts` and `src/bot.ts` compose them.
 */

/** Everything a feature's server half may assume exists before it is constructed. */
export interface ServerContext {
  config: Config;
  db: Db;
  log: Logger;
  settings: RuntimeSettingsService;
  bloxlink: BloxlinkService;
  /** The bot half: Discord, reached through the ports its features expose. */
  bot: Peer;
}

/** Everything a feature's bot half may assume exists before it is constructed. */
export interface BotContext {
  config: Config;
  client: Client;
  log: Logger;
  /** The server half: the database and the integrations, reached through its ports. */
  server: Peer;
  /** Ports every feature's Discord surface shares: permissions and Bloxlink. */
  shared: SharedServerPort;
  /** Which features the server half actually runs, from its own configuration. */
  capabilities: ServerCapabilities;
}

/** What the server half runs, as the bot half needs to know it. */
export type ServerCapabilities = {
  taiga: boolean;
};

/** A port one half offers the other: an object literal of async methods. */
export type ExposedPorts = Record<string, object>;

/**
 * A feature's server half. Routes, jobs and lifecycle hooks only ever run in
 * the process that holds the database.
 */
export interface ServerFeature {
  name: string;
  /** HTTP routes, registered in their own encapsulated Fastify scope. */
  routes?: FastifyPluginAsync;
  /** Ports this half offers the bot half, by name. */
  ports?: ExposedPorts;
  /** Runs before the HTTP server starts listening. Throwing aborts startup. */
  onStart?: () => Promise<void>;
  /**
   * Runs whenever the bot half reports its gateway ready — on its first start,
   * and on every start after a restart — so Discord catches up on whatever it
   * could not show. Failures are logged, not fatal.
   */
  onBotReady?: () => Promise<void>;
  jobs?: ScheduledJob[];
  onShutdown?: () => Promise<void>;
}

/**
 * A feature's bot half. Attach gateway listeners in the factory — every
 * listener must ignore interactions that are not its own.
 */
export interface BotFeature {
  name: string;
  /** Slash commands contributed to the guild command set. */
  commands?: RESTPostAPIApplicationCommandsJSONBody[];
  /** Ports this half offers the server half, by name. */
  ports?: ExposedPorts;
  /**
   * Settings pages this feature contributes to `/config`. `src/bot.ts`
   * collects them from every composed feature and hands them to the
   * configuration feature, so features stay independent of one another.
   */
  configSections?: ConfigSection[];
  /** What `/help` lists for this feature. */
  help?: HelpSection;
  /** Runs after the Discord client is ready. Failures are logged, not fatal. */
  onReady?: () => Promise<void>;
  onShutdown?: () => Promise<void>;
}
