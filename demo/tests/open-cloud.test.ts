import { afterEach, describe, expect, it, vi } from "vitest";
import { RobloxOpenCloudService } from "../services/roblox-open-cloud.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const BASE = "https://apis.roblox.com/cloud/v2";

afterEach(() => vi.unstubAllGlobals());

describe("RobloxOpenCloudService", () => {
  it("dry-runs when no API key is configured", async () => {
    const service = new RobloxOpenCloudService({ apiKey: null, groupId: "0", baseUrl: BASE });
    const result = await service.setRank("999", "42");
    expect(result).toMatchObject({ ok: true, dryRun: true });
  });

  it("resolves membership then PATCHes the role", async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, method: init?.method ?? "GET" });
      if (target.includes("/memberships?")) return jsonResponse({ groupMemberships: [{ path: "groups/123/memberships/MEMBER1", user: "users/999", role: "groups/123/roles/1" }] });
      if (init?.method === "PATCH") return jsonResponse({ path: "groups/123/memberships/MEMBER1", role: "groups/123/roles/42" });
      return jsonResponse({}, 404);
    }));

    const service = new RobloxOpenCloudService({ apiKey: "key", groupId: "123", baseUrl: BASE });
    const result = await service.setRank("999", "42");

    expect(result).toMatchObject({ ok: true, dryRun: false });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain("/groups/123/memberships/MEMBER1");
  });

  it("reports a clear 403 when the bot cannot rank the target", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/memberships?")) return jsonResponse({ groupMemberships: [{ path: "groups/123/memberships/M1" }] });
      if (init?.method === "PATCH") return jsonResponse({ message: "forbidden" }, 403);
      return jsonResponse({}, 404);
    }));
    const service = new RobloxOpenCloudService({ apiKey: "key", groupId: "123", baseUrl: BASE });
    const result = await service.setRank("999", "42");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("403");
  });

  it("returns a friendly error when the user is not in the group", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ groupMemberships: [] })));
    const service = new RobloxOpenCloudService({ apiKey: "key", groupId: "123", baseUrl: BASE });
    const result = await service.setRank("999", "42");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a member");
  });

  it("lists group roles", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ groupRoles: [{ id: "1", displayName: "Guest", rank: 0 }, { id: "2", displayName: "Lift Surfer", rank: 5 }] })));
    const service = new RobloxOpenCloudService({ apiKey: "key", groupId: "123", baseUrl: BASE });
    const roles = await service.listRoles();
    expect(roles).toHaveLength(2);
    expect(roles[1]).toMatchObject({ id: "2", name: "Lift Surfer", rank: 5 });
  });
});
