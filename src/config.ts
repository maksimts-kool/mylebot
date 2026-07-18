import { z } from "zod";

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const csv = z.string().default("").transform((value) => value.split(",").map((v) => v.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  DISCORD_TOKEN: z.string().default(""),
  DISCORD_APPLICATION_ID: z.string().default(""),
  DISCORD_GUILD_ID: z.string().default(""),
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
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  TRUST_PROXY: z.enum(["false", "loopback"]).default("loopback"),
  REPORT_TIMEZONE: z.string().default("Europe/Tallinn"),
  RECONNECT_GRACE_SECONDS: positiveInt(120),
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
  return parsed;
}
