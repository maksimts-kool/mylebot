import type { FastifyInstance } from "fastify";
import { loadConfig, runsBot, runsServer } from "./core/config.js";
import { buildHttpServer } from "./core/http.js";
import { httpPeer, linkRoutes, localPeer, PortRegistry, type Peer } from "./core/link.js";
import { createAppLogger, setAppLogger } from "./core/logger.js";
import { APP_VERSION } from "./core/version.js";
import type { BotHalf } from "./bot.js";
import type { ServerHalf } from "./server.js";

const config = loadConfig();
const log = createAppLogger(config);
// Discord builds its interaction handlers far from here, so they reach for the
// logger rather than being handed one.
setAppLogger(log);
const startup = log.child({ category: "startup" });

startup.info({ version: APP_VERSION, role: config.APP_ROLE, env: config.NODE_ENV }, "MyLE Bot starting");

/**
 * `server` owns PostgreSQL, Roblox, Taiga and Bloxlink, and runs every job.
 * `bot` holds the Discord gateway and never opens a database connection.
 * `all` runs both in this one process, calling each other directly instead of
 * across the container network.
 *
 * Each half is loaded only where it runs, so a `bot` container never even
 * imports the database client.
 */
let server: ServerHalf | null = null;
let bot: BotHalf | null = null;

const app = await buildHttpServer(config, async () => {
  // A process is ready when the half it runs is: the database for the server,
  // the gateway for a bot running on its own.
  if (server) await server.readiness();
  else if (bot) await bot.readiness();
  else throw new Error("Still starting");
}, log);

const serverPorts = new PortRegistry(log);
const botPorts = new PortRegistry(log);

// The ports each half offers the other, and how it reaches the other's.
let toBot: Peer;
let toServer: Peer;
let linkApp: FastifyInstance | null = null;
if (config.APP_ROLE === "all") {
  toBot = localPeer(botPorts);
  toServer = localPeer(serverPorts);
} else {
  toBot = httpPeer({ baseUrl: config.BOT_INTERNAL_URL, secret: config.INTERNAL_SECRET });
  toServer = httpPeer({ baseUrl: config.SERVER_INTERNAL_URL, secret: config.INTERNAL_SECRET });
  // The link has a port of its own, which the compose files never publish:
  // the API port is exposed to the internet, and the portal's `/internal/*`
  // routes are proxied to it. The shared secret is checked all the same.
  linkApp = await buildHttpServer(config, async () => undefined, log);
  await linkApp.register(linkRoutes({ registry: config.APP_ROLE === "server" ? serverPorts : botPorts, secret: config.INTERNAL_SECRET }));
}

if (runsServer(config)) {
  const { startServerHalf } = await import("./server.js");
  server = await startServerHalf({ config, log, app, registry: serverPorts, bot: toBot });
}
if (runsBot(config)) {
  const { startBotHalf } = await import("./bot.js");
  bot = await startBotHalf({ config, log, registry: botPorts, server: toServer });
}

await app.listen({ host: config.API_HOST, port: config.API_PORT });
log.info({ category: "http" }, `Listening on ${config.API_HOST}:${config.API_PORT}`);
if (linkApp) {
  await linkApp.listen({ host: config.API_HOST, port: config.LINK_PORT });
  log.info({ category: "http" }, `Link to the other half listening on ${config.API_HOST}:${config.LINK_PORT}`);
}

if (server) {
  // Jobs run once per deployment, in the half that owns the data they act on.
  server.startJobs();
  // A bot running beside this process says when it is ready; a bot in its own
  // container may have been up all along.
  if (config.APP_ROLE === "server") {
    void server.catchUpWithBot().catch((error: unknown) => {
      startup.error({ err: error }, "Could not ask the bot whether Discord needs catching up");
    });
  }
}
if (bot) await bot.login();

async function shutdown(signal: string) {
  startup.info({ signal }, "Shutting down");
  await app.close();
  if (linkApp) await linkApp.close();
  if (bot) await bot.shutdown();
  if (server) await server.shutdown();
  startup.info("Stopped");
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
