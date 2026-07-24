import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { TaigaApiError, TaigaClient } from "../../src/features/taiga/client.js";

const config = loadConfig({
  DATABASE_URL: "postgresql://example.invalid/db",
  ROBLOX_INGESTION_SECRET: "12345678901234567890123456789012",
  ROBLOX_UNIVERSE_ID: "100",
  ROBLOX_GROUP_ID: "200",
  ROBLOX_ALLOWED_PLACE_IDS: "300",
  TAIGA_BASE_URL: "https://api.taiga.invalid",
  TAIGA_WEB_URL: "https://tree.taiga.invalid",
  TAIGA_USERNAME: "bot",
  TAIGA_PASSWORD: "super-secret-password",
  TAIGA_PROJECT_SLUG: "my-lifts",
});

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let handlers: Record<string, Handler>;
let calls: Array<{ url: string; token: string | null }>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  handlers = {};
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const authorization = headers.get("Authorization");
    calls.push({ url, token: authorization ? authorization.replace("Bearer ", "") : null });
    const key = Object.keys(handlers).find((path) => url.includes(path));
    if (!key) throw new Error(`Unexpected request: ${url}`);
    return handlers[key]!(url, init);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Taiga authentication", () => {
  it("logs in once and reuses the token across requests", async () => {
    let logins = 0;
    handlers["/auth"] = () => { logins += 1; return json({ auth_token: "token-1", refresh: "refresh-1" }); };
    handlers["/projects/by_slug"] = () => json({ id: 42 });
    handlers["/userstory-statuses"] = () => json([{ id: 1, name: "Suggested" }]);

    const client = new TaigaClient(config);
    await client.statuses();
    await client.projectId();

    expect(logins).toBe(1);
    expect(calls.filter((call) => call.url.includes("/projects/by_slug"))).toHaveLength(1);
    expect(calls.find((call) => call.url.includes("/userstory-statuses"))?.token).toBe("token-1");
  });

  it("refreshes and retries once when the token has expired", async () => {
    handlers["/auth/refresh"] = () => json({ auth_token: "token-2", refresh: "refresh-2" });
    handlers["/auth"] = () => json({ auth_token: "token-1", refresh: "refresh-1" });
    let projectCalls = 0;
    handlers["/projects/by_slug"] = () => {
      projectCalls += 1;
      return projectCalls === 1 ? json({ error: "expired" }, 401) : json({ id: 42 });
    };

    const client = new TaigaClient(config);
    expect(await client.projectId()).toBe(42);
    expect(projectCalls).toBe(2);
    const projectRequests = calls.filter((call) => call.url.includes("/projects/by_slug"));
    expect(projectRequests.map((call) => call.token)).toEqual(["token-1", "token-2"]);
  });

  it("falls back to a full login when the refresh token is dead too", async () => {
    handlers["/auth/refresh"] = () => json({ error: "invalid" }, 401);
    let logins = 0;
    handlers["/auth"] = () => { logins += 1; return json({ auth_token: `token-${logins}`, refresh: "refresh" }); };
    let statusCalls = 0;
    handlers["/userstory-statuses"] = () => {
      statusCalls += 1;
      return statusCalls === 1 ? json({ error: "expired" }, 401) : json([{ id: 1, name: "Suggested" }]);
    };
    handlers["/projects/by_slug"] = () => json({ id: 42 });

    const client = new TaigaClient(config);
    expect(await client.statuses()).toEqual([{ id: 1, name: "Suggested" }]);
    expect(logins).toBe(2);
  });

  it("collapses concurrent callers onto a single login", async () => {
    let logins = 0;
    handlers["/auth"] = async () => {
      logins += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return json({ auth_token: "token-1", refresh: "refresh-1" });
    };
    handlers["/projects/by_slug"] = () => json({ id: 42 });

    const client = new TaigaClient(config);
    await Promise.all([client.projectId(), client.projectId(), client.projectId()]);
    expect(logins).toBe(1);
  });
});

describe("Taiga requests", () => {
  beforeEach(() => {
    handlers["/auth"] = () => json({ auth_token: "token-1", refresh: "refresh-1" });
    handlers["/projects/by_slug"] = () => json({ id: 42 });
  });

  it("creates a user story in the requested column with its tags", async () => {
    let body: Record<string, unknown> = {};
    handlers["/userstories"] = (_url, init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return json({ id: 555, ref: 12, subject: "Doors", status: 1, status_extra_info: { name: "Suggested" }, tags: [["bug", "#fff"]] });
    };

    const client = new TaigaClient(config);
    const story = await client.createUserStory({ subject: "Doors", description: "text", statusId: 1, tags: ["bug"] });

    expect(body).toMatchObject({ project: 42, subject: "Doors", description: "text", status: 1, tags: ["bug"] });
    expect(story).toMatchObject({ id: 555, ref: 12, statusName: "Suggested", tags: ["bug"] });
  });

  it("asks for the whole board rather than one page", async () => {
    let paginationHeader: string | null = null;
    handlers["/userstories?project"] = (_url, init) => {
      paginationHeader = new Headers(init.headers).get("x-disable-pagination");
      return json([{ id: 1, ref: 2, subject: "a", status: 3, status_extra_info: { name: "Planned" }, tags: [] }]);
    };

    const client = new TaigaClient(config);
    const stories = await client.listUserStories();
    expect(paginationHeader).toBe("True");
    expect(stories).toEqual([{ id: 1, ref: 2, subject: "a", statusId: 3, statusName: "Planned", tags: [] }]);
  });

  it("reports a failure without ever echoing the credentials", async () => {
    handlers["/userstories"] = () => json({ detail: "permission denied" }, 403);
    const client = new TaigaClient(config);
    const error = await client.createUserStory({ subject: "x", description: "y" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaigaApiError);
    expect((error as TaigaApiError).status).toBe(403);
    expect(String(error)).not.toContain(config.TAIGA_PASSWORD);
    expect(String(error)).not.toContain(config.TAIGA_USERNAME);
  });

  it("builds board links from the web URL, not the API URL", () => {
    const client = new TaigaClient(config);
    expect(client.storyUrl(12)).toBe("https://tree.taiga.invalid/project/my-lifts/us/12");
    expect(client.epicUrl(3)).toBe("https://tree.taiga.invalid/project/my-lifts/epic/3");
  });
});
