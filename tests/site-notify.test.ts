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

  it("uses the uploader's Roblox username in a site notification", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const resolveRobloxUsername = vi.fn().mockResolvedValue("MallBuilder");
    const app = await buildApi(config, sessions, noop, undefined, send, resolveRobloxUsername);
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/internal/notify",
      headers: { authorization: `Bearer ${baseEnv.SITE_NOTIFY_SECRET}` },
      payload: {
        ...validBody,
        message: "{{uploader}} uploaded A1.001.260718",
        uploaderDiscordId: "700413620319813684",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(resolveRobloxUsername).toHaveBeenCalledWith("700413620319813684");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ message: "MallBuilder uploaded A1.001.260718" }));
  });

  it("returns the Roblox username for the authenticated portal", async () => {
    const resolveRobloxUsername = vi.fn().mockResolvedValue("MallBuilder");
    const app = await buildApi(config, sessions, noop, undefined, vi.fn(), resolveRobloxUsername);
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/internal/roblox-username/700413620319813684",
      headers: { authorization: `Bearer ${baseEnv.SITE_NOTIFY_SECRET}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ username: "MallBuilder" });
    expect(resolveRobloxUsername).toHaveBeenCalledWith("700413620319813684");
  });

  it("returns verified members in the bot's guild for the authenticated portal", async () => {
    const listVerifiedGuildMembers = vi.fn().mockResolvedValue([
      { discordId: "700413620319813684", discordName: "Mall Builder", robloxUsername: "MallBuilder" },
    ]);
    const app = await buildApi(config, sessions, noop, undefined, vi.fn(), undefined, listVerifiedGuildMembers);
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/internal/verified-members",
      headers: { authorization: `Bearer ${baseEnv.SITE_NOTIFY_SECRET}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ members: [{
      discordId: "700413620319813684", discordName: "Mall Builder", robloxUsername: "MallBuilder",
    }] });
    expect(listVerifiedGuildMembers).toHaveBeenCalledOnce();
  });

  it("does not list verified members without the portal secret", async () => {
    const listVerifiedGuildMembers = vi.fn();
    const app = await buildApi(config, sessions, noop, undefined, vi.fn(), undefined, listVerifiedGuildMembers);
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/internal/verified-members" });
    expect(response.statusCode).toBe(401);
    expect(listVerifiedGuildMembers).not.toHaveBeenCalled();
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
