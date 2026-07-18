import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../src/api.js";
import { loadConfig } from "../src/config.js";

const baseEnv = {
  DATABASE_URL: "postgresql://example.invalid/db",
  ROBLOX_INGESTION_SECRET: "12345678901234567890123456789012",
  ROBLOX_UNIVERSE_ID: "100",
  ROBLOX_GROUP_ID: "200",
  ROBLOX_ALLOWED_PLACE_IDS: "300",
  SITE_NOTIFY_SECRET: "site-notify-secret-abcdefgh",
};
const config = loadConfig(baseEnv);
const sessions = { process: vi.fn() } as never;
const noop = async () => {};
const validBody = { discordId: "123456789012345678", title: "Hello", message: "A message" };

const apps: Array<Awaited<ReturnType<typeof buildApi>>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.clearAllMocks();
});

describe("site notify endpoint", () => {
  it("rejects a missing or wrong secret before sending", async () => {
    const send = vi.fn();
    const app = await buildApi(config, sessions, noop, undefined, send);
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/internal/notify",
      headers: { authorization: "Bearer wrong" },
      payload: validBody,
    });
    expect(response.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("is disabled when no secret is configured", async () => {
    const disabled = loadConfig({ ...baseEnv, SITE_NOTIFY_SECRET: "" });
    const app = await buildApi(disabled, sessions, noop, undefined, vi.fn());
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/internal/notify",
      headers: { authorization: "Bearer anything" },
      payload: validBody,
    });
    expect(response.statusCode).toBe(503);
  });

  it("validates the payload", async () => {
    const send = vi.fn();
    const app = await buildApi(config, sessions, noop, undefined, send);
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/internal/notify",
      headers: { authorization: `Bearer ${baseEnv.SITE_NOTIFY_SECRET}` },
      payload: { discordId: "not-a-snowflake", title: "", message: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends a DM for an authenticated, valid request", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const app = await buildApi(config, sessions, noop, undefined, send);
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/internal/notify",
      headers: { authorization: `Bearer ${baseEnv.SITE_NOTIFY_SECRET}` },
      payload: validBody,
    });
    expect(response.statusCode).toBe(200);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ discordId: validBody.discordId, title: "Hello" }));
  });

  it("surfaces a closed-DM failure from the sender", async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, status: 422, error: "dms_closed" });
    const app = await buildApi(config, sessions, noop, undefined, send);
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/internal/notify",
      headers: { authorization: `Bearer ${baseEnv.SITE_NOTIFY_SECRET}` },
      payload: validBody,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: "dms_closed" });
  });
});
