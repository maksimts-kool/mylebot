import { z } from "zod";

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const csv = z.string().default("").transform((value) => value.split(",").map((v) => v.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * Which half of the application this process runs. `all` is one container
   * doing both, which is how a single-container deployment stays working;
   * `server` answers HTTP, `bot` talks to Discord and runs the scheduled jobs.
   */
  APP_ROLE: z.enum(["all", "server", "bot"]).default("all"),
  /**
   * Where the `server` role reaches the `bot` role, on the private container
   * network — `http://bot:3000`. Unused when one process runs both halves.
   */
  BOT_INTERNAL_URL: z.string().url().or(z.literal("")).default(""),
  /** Shared secret for the endpoints only the two containers talk to. */
  INTERNAL_SECRET: z
    .string()
    .default("")
    .refine((value) => value === "" || value.length >= 16, "INTERNAL_SECRET must be at least 16 characters when set"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  /** `json` for a log shipper; `pretty` for a human reading `docker logs`. */
  LOG_FORMAT: z.enum(["pretty", "json"]).default("pretty"),
  /** Containers have no TTY, so `auto` drops colour there; `always` keeps it. */
  LOG_COLOR: z.enum(["auto", "always", "never"]).default("auto"),
  DATABASE_URL: z.string().min(1),
  DISCORD_TOKEN: z.string().default(""),
  DISCORD_APPLICATION_ID: z.string().default(""),
  DISCORD_GUILD_ID: z.string().default(""),
  // Leaving either verification ID empty disables the Discord-only reminder
  // and removal feature.
  VERIFICATION_CHANNEL_ID: z.string().default(""),
  VERIFICATION_UNVERIFIED_ROLE_ID: z.string().default(""),
  BLOXLINK_API_KEY: z.string().default(""),
  BLOXLINK_BASE_URL: z.string().url().default("https://api.blox.link/v4/public"),
  ROBLOX_INGESTION_SECRET: z.string().min(16),
  // Shared secret for the store-owners site's DM notification endpoint.
  // Empty disables POST /internal/notify entirely.
  SITE_NOTIFY_SECRET: z
    .string()
    .default("")
    .refine((value) => value === "" || value.length >= 16, "SITE_NOTIFY_SECRET must be at least 16 characters when set"),
  ROBLOX_UNIVERSE_ID: z.coerce.bigint().refine((value) => value > 0n, "ROBLOX_UNIVERSE_ID must be positive"),
  ROBLOX_GROUP_ID: z.coerce.bigint().refine((value) => value > 0n, "ROBLOX_GROUP_ID must be positive"),
  ROBLOX_ALLOWED_PLACE_IDS: csv.transform((ids, context) => ids.map((id) => {
    try {
      const value = BigInt(id);
      if (value <= 0n) throw new Error();
      return value;
    } catch {
      context.addIssue({ code: "custom", message: `Invalid Roblox place ID: ${id}` });
      return 0n;
    }
  })),
  ROBLOX_MIN_RANK: z.coerce.number().int().min(0).max(255).default(1),
  ROBLOX_MAX_RANK: z.coerce.number().int().min(0).max(255).default(255),
  // Taiga board integration. Leaving the credentials empty disables the whole
  // feature, including the privileged Discord message intents it needs.
  TAIGA_BASE_URL: z.string().url().default("https://api.taiga.io"),
  // Where humans read the board, used to build links in Discord embeds.
  TAIGA_WEB_URL: z.string().url().default("https://tree.taiga.io"),
  TAIGA_USERNAME: z.string().default(""),
  TAIGA_PASSWORD: z.string().default(""),
  TAIGA_PROJECT_SLUG: z.string().default(""),
  TAIGA_WEBHOOK_SECRET: z.string().default(""),
  TAIGA_RECONCILE_SECONDS: positiveInt(600),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  TRUST_PROXY: z.enum(["false", "loopback"]).default("loopback"),
  REPORT_TIMEZONE: z.string().default("Europe/Tallinn"),
  HEARTBEAT_STALE_SECONDS: positiveInt(75),
  DISCORD_UPDATE_SECONDS: positiveInt(60),
  MAX_BATCH_SIZE: positiveInt(100),
  MAX_EVENT_AGE_SECONDS: positiveInt(300),
  PROCESSED_EVENT_RETENTION_DAYS: positiveInt(30),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  if (parsed.ROBLOX_MIN_RANK > parsed.ROBLOX_MAX_RANK) {
    throw new Error("ROBLOX_MIN_RANK cannot exceed ROBLOX_MAX_RANK");
  }
  if (parsed.ROBLOX_ALLOWED_PLACE_IDS.length === 0) {
    throw new Error("ROBLOX_ALLOWED_PLACE_IDS must contain at least one place ID");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: parsed.REPORT_TIMEZONE }).format();
  } catch {
    throw new Error(`Invalid REPORT_TIMEZONE: ${parsed.REPORT_TIMEZONE}`);
  }
  // A split deployment only works if each half knows how to reach the other.
  if (parsed.APP_ROLE !== "all" && !parsed.INTERNAL_SECRET) {
    throw new Error("INTERNAL_SECRET must be set when APP_ROLE is 'server' or 'bot'");
  }
  if (parsed.APP_ROLE === "server" && !parsed.BOT_INTERNAL_URL) {
    throw new Error("BOT_INTERNAL_URL must point at the bot container when APP_ROLE is 'server'");
  }
  const taigaFields = [parsed.TAIGA_USERNAME, parsed.TAIGA_PASSWORD, parsed.TAIGA_PROJECT_SLUG];
  if (taigaFields.some(Boolean) && !taigaFields.every(Boolean)) {
    throw new Error("TAIGA_USERNAME, TAIGA_PASSWORD, and TAIGA_PROJECT_SLUG must be set together");
  }
  return parsed;
}

/** True when the Taiga integration has enough configuration to run at all. */
export function taigaConfigured(config: Config): boolean {
  return Boolean(config.TAIGA_USERNAME && config.TAIGA_PASSWORD && config.TAIGA_PROJECT_SLUG);
}

/** True when the verification feature has a guild, channel, and role to use. */
export function verificationConfigured(config: Config): boolean {
  return Boolean(
    config.DISCORD_GUILD_ID
    && config.VERIFICATION_CHANNEL_ID
    && config.VERIFICATION_UNVERIFIED_ROLE_ID,
  );
}
