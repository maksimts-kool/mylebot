import { z } from "zod";

const int = (fallback: number) => z.coerce.number().int().default(fallback);
const csv = z.string().default("").transform((value) => value.split(",").map((v) => v.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  DISCORD_TOKEN: z.string().default(""),
  DISCORD_APPLICATION_ID: z.string().default(""),
  DISCORD_GUILD_ID: z.string().default(""),
  DISCORD_SESSION_CHANNEL_ID: z.string().default(""),
  DISCORD_STAFF_ROLE_IDS: csv,
  DISCORD_ADMIN_ROLE_IDS: csv,
  BLOXLINK_API_KEY: z.string().default(""),
  BLOXLINK_BASE_URL: z.string().url().default("https://api.blox.link/v4/public"),
  ROBLOX_INGESTION_SECRET: z.string().min(16),
  ROBLOX_UNIVERSE_ID: z.coerce.bigint(),
  ROBLOX_GROUP_ID: z.coerce.bigint(),
  ROBLOX_ALLOWED_PLACE_IDS: csv.transform((ids) => ids.map(BigInt)),
  ROBLOX_MIN_RANK: int(1),
  ROBLOX_MAX_RANK: int(255),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: int(3000),
  TRUST_PROXY: z.enum(["false", "loopback"]).default("loopback"),
  REPORT_TIMEZONE: z.string().default("Europe/Tallinn"),
  INACTIVITY_SECONDS: int(300),
  RECONNECT_GRACE_SECONDS: int(120),
  HEARTBEAT_STALE_SECONDS: int(75),
  DISCORD_UPDATE_SECONDS: int(60),
  MAX_BATCH_SIZE: int(100),
  MAX_EVENT_AGE_SECONDS: int(300),
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
  return parsed;
}

