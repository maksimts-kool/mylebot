import type { Client, RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import type { BloxlinkService } from "../shared/bloxlink.js";
import type { RuntimeSettingsService } from "../shared/runtime-settings.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { ScheduledJob } from "./scheduler.js";

/** Everything a feature is allowed to assume exists before it is constructed. */
export interface FeatureContext {
  config: Config;
  db: Db;
  client: Client;
  log: FastifyBaseLogger;
  settings: RuntimeSettingsService;
  bloxlink: BloxlinkService;
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
  /** Routes, registered in their own encapsulated Fastify scope. */
  routes?: FastifyPluginAsync;
  /** Runs before the HTTP server starts listening. Throwing aborts startup. */
  onStart?: () => Promise<void>;
  /** Runs after the Discord client is ready. Failures are logged, not fatal. */
  onReady?: () => Promise<void>;
  jobs?: ScheduledJob[];
  onShutdown?: () => Promise<void>;
}
