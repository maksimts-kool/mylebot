import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { BloxlinkService } from "../../src/shared/bloxlink.js";

const config = loadConfig({
  DATABASE_URL: "postgresql://example.invalid/db",
  BLOXLINK_API_KEY: "test-bloxlink-key",
  DISCORD_GUILD_ID: "123456789012345678",
  ROBLOX_INGESTION_SECRET: "12345678901234567890123456789012",
  ROBLOX_UNIVERSE_ID: "100",
  ROBLOX_GROUP_ID: "200",
  ROBLOX_ALLOWED_PLACE_IDS: "300",
});

afterEach(() => vi.unstubAllGlobals());

describe("BloxlinkService", () => {
  it("resolves a Roblox username when Bloxlink returns only the Roblox ID", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ robloxID: "5369686203" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 5369686203, name: "PixelRoyalAscent" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const db = { identity: { findFirst: vi.fn().mockResolvedValue(null) } } as never;
    const service = new BloxlinkService(db, config);

    await expect(service.robloxForDiscord("700413620319813684")).resolves.toEqual({
      userId: 5369686203n,
      username: "PixelRoyalAscent",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://users.roblox.com/v1/users/5369686203");
  });

  it("shares and caches an uncached Bloxlink lookup for the same Discord user", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      robloxID: "5369686203",
      resolved: { roblox: { name: "PixelRoyalAscent" } },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const db = { identity: { findFirst: vi.fn().mockResolvedValue(null) } } as never;
    const service = new BloxlinkService(db, config);

    const [first, second] = await Promise.all([
      service.robloxForDiscord("700413620319813684"),
      service.robloxForDiscord("700413620319813684"),
    ]);
    await expect(service.robloxForDiscord("700413620319813684")).resolves.toEqual(first);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
