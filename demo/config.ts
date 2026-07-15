import { z } from "zod";

// All demo configuration is namespaced under DEMO_* so it can never collide with
// the production bot's environment. Everything has a safe default so the offline
// simulation and unit tests run with no environment at all.
const schema = z.object({
  DEMO_DISCORD_TOKEN: z.string().default(""),
  DEMO_APPLICATION_ID: z.string().default(""),
  DEMO_GUILD_ID: z.string().default(""),

  DEMO_ROBLOX_GROUP_ID: z.string().default("0"),
  DEMO_ROBLOX_OPEN_CLOUD_API_KEY: z.string().default(""),
  DEMO_OPEN_CLOUD_BASE_URL: z.string().url().default("https://apis.roblox.com/cloud/v2"),

  DEMO_BLOXLINK_API_KEY: z.string().default(""),
  DEMO_BLOXLINK_BASE_URL: z.string().url().default("https://api.blox.link/v4/public"),

  // Where the JSON store lives. Set to "" for a pure in-memory store (tests).
  DEMO_STORE_PATH: z.string().default("demo/.data/store.json"),

  // Minimum correct practical answers to be flagged as "passed"; 0 disables the flag.
  DEMO_PASSING_SCORE: z.coerce.number().int().min(0).default(0),
});

export type DemoConfig = z.infer<typeof schema>;

export function loadDemoConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  return schema.parse(env);
}
