import type { Config } from "../../core/config.js";

export class TaigaApiError extends Error {
  constructor(readonly status: number, readonly endpoint: string, readonly detail?: string) {
    super(`Taiga request ${endpoint} failed with status ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "TaigaApiError";
  }
}

export type TaigaStatus = { id: number; name: string };
export type TaigaStory = {
  id: number;
  ref: number;
  subject: string;
  statusId: number | null;
  statusName: string | null;
  tags: string[];
};
export type TaigaEpic = {
  id: number;
  ref: number;
  subject: string;
  statusName: string | null;
  isClosed: boolean;
};

export type CreateUserStoryInput = {
  subject: string;
  description: string;
  statusId?: number;
  tags?: string[];
};

const REQUEST_TIMEOUT_MS = 10_000;
const STATUS_CACHE_MS = 10 * 60 * 1000;

function tagNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  // Taiga returns tags as [name, colour] pairs but accepts plain strings.
  return raw.flatMap((tag) => {
    if (typeof tag === "string") return [tag];
    if (Array.isArray(tag) && typeof tag[0] === "string") return [tag[0]];
    return [];
  });
}

/**
 * Minimal Taiga REST client.
 *
 * Taiga has no long-lived API keys: you log in for a short-lived bearer token
 * plus a refresh token. Both live in memory only, refreshed on demand and
 * re-acquired from scratch if the refresh itself has expired. Nothing here ever
 * logs the credentials or either token.
 */
export class TaigaClient {
  private authToken: string | null = null;
  private refreshToken: string | null = null;
  private authInFlight: Promise<string> | null = null;
  private projectIdCache: number | null = null;
  private statusCache: { expiresAt: number; statuses: TaigaStatus[] } | null = null;

  constructor(private readonly config: Config) {}

  private url(path: string): string {
    return `${this.config.TAIGA_BASE_URL.replace(/\/+$/, "")}/api/v1${path}`;
  }

  private async send(path: string, init: RequestInit, token: string | null): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(this.url(path), { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  private async readError(response: Response): Promise<string | undefined> {
    try {
      const body = await response.text();
      return body.slice(0, 200);
    } catch {
      return undefined;
    }
  }

  /** Logs in (or refreshes), collapsing concurrent callers onto one request. */
  private async token(): Promise<string> {
    if (this.authToken) return this.authToken;
    if (this.authInFlight) return this.authInFlight;
    this.authInFlight = this.acquireToken();
    try {
      return await this.authInFlight;
    } finally {
      this.authInFlight = null;
    }
  }

  private async acquireToken(): Promise<string> {
    if (this.refreshToken) {
      const refreshed = await this.tryRefresh(this.refreshToken);
      if (refreshed) return refreshed;
      // The refresh token expired too; fall through to a full login.
      this.refreshToken = null;
    }
    const response = await this.send("/auth", {
      method: "POST",
      body: JSON.stringify({ type: "normal", username: this.config.TAIGA_USERNAME, password: this.config.TAIGA_PASSWORD }),
    }, null);
    if (!response.ok) throw new TaigaApiError(response.status, "POST /auth", await this.readError(response));
    const body = await response.json() as { auth_token?: string; refresh?: string };
    if (!body.auth_token) throw new TaigaApiError(response.status, "POST /auth", "response contained no auth_token");
    this.authToken = body.auth_token;
    this.refreshToken = body.refresh ?? null;
    return this.authToken;
  }

  private async tryRefresh(refresh: string): Promise<string | null> {
    try {
      const response = await this.send("/auth/refresh", { method: "POST", body: JSON.stringify({ refresh }) }, null);
      if (!response.ok) return null;
      const body = await response.json() as { auth_token?: string; refresh?: string };
      if (!body.auth_token) return null;
      this.authToken = body.auth_token;
      this.refreshToken = body.refresh ?? refresh;
      return this.authToken;
    } catch {
      return null;
    }
  }

  /** Authenticated request that re-authenticates once if the token went stale. */
  private async request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const endpoint = `${method} ${path.split("?")[0]}`;
    const init: RequestInit = { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(extraHeaders ? { headers: extraHeaders } : {}) };
    let response = await this.send(path, init, await this.token());
    if (response.status === 401) {
      this.authToken = null;
      response = await this.send(path, init, await this.token());
    }
    if (!response.ok) throw new TaigaApiError(response.status, endpoint, await this.readError(response));
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private async list<T>(path: string): Promise<T[]> {
    // Ask Taiga for the whole collection instead of walking pages, so a partial
    // read can never look like "these cards were deleted".
    const result = await this.request<T[]>("GET", path, undefined, { "x-disable-pagination": "True" });
    if (!Array.isArray(result)) throw new TaigaApiError(200, `GET ${path.split("?")[0]}`, "expected a list response");
    return result;
  }

  async projectId(): Promise<number> {
    if (this.projectIdCache !== null) return this.projectIdCache;
    const project = await this.request<{ id?: number }>("GET", `/projects/by_slug?slug=${encodeURIComponent(this.config.TAIGA_PROJECT_SLUG)}`);
    if (typeof project?.id !== "number") throw new TaigaApiError(200, "GET /projects/by_slug", "response contained no project id");
    this.projectIdCache = project.id;
    return project.id;
  }

  async statuses(forceRefresh = false): Promise<TaigaStatus[]> {
    if (!forceRefresh && this.statusCache && this.statusCache.expiresAt > Date.now()) return this.statusCache.statuses;
    const project = await this.projectId();
    const raw = await this.list<{ id: number; name: string }>(`/userstory-statuses?project=${project}`);
    const statuses = raw.map(({ id, name }) => ({ id, name }));
    this.statusCache = { statuses, expiresAt: Date.now() + STATUS_CACHE_MS };
    return statuses;
  }

  async createUserStory(input: CreateUserStoryInput): Promise<TaigaStory> {
    const project = await this.projectId();
    const created = await this.request<Record<string, unknown>>("POST", "/userstories", {
      project,
      subject: input.subject,
      description: input.description,
      ...(input.statusId === undefined ? {} : { status: input.statusId }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
    });
    return this.toStory(created);
  }

  async deleteUserStory(storyId: number): Promise<void> {
    await this.request<void>("DELETE", `/userstories/${storyId}`);
  }

  async listUserStories(): Promise<TaigaStory[]> {
    const project = await this.projectId();
    const raw = await this.list<Record<string, unknown>>(`/userstories?project=${project}`);
    return raw.map((story) => this.toStory(story));
  }

  async listEpics(): Promise<TaigaEpic[]> {
    const project = await this.projectId();
    const raw = await this.list<Record<string, unknown>>(`/epics?project=${project}`);
    return raw.map((epic) => this.toEpic(epic));
  }

  async epicUserStories(epicId: number): Promise<TaigaStory[]> {
    const raw = await this.list<Record<string, unknown>>(`/epics/${epicId}/related_userstories`);
    // Related-story rows nest the story under `user_story` in some Taiga
    // versions and inline it in others.
    return raw.map((row) => this.toStory((row["user_story"] as Record<string, unknown>) ?? row));
  }

  private toStory(raw: Record<string, unknown>): TaigaStory {
    const extra = raw["status_extra_info"] as { name?: unknown } | undefined;
    const statusName = typeof extra?.name === "string" ? extra.name : null;
    const status = raw["status"];
    return {
      id: Number(raw["id"]),
      ref: Number(raw["ref"] ?? 0),
      subject: typeof raw["subject"] === "string" ? raw["subject"] : "",
      statusId: typeof status === "number" ? status : null,
      statusName,
      tags: tagNames(raw["tags"]),
    };
  }

  private toEpic(raw: Record<string, unknown>): TaigaEpic {
    const extra = raw["status_extra_info"] as { name?: unknown; is_closed?: unknown } | undefined;
    return {
      id: Number(raw["id"]),
      ref: Number(raw["ref"] ?? 0),
      subject: typeof raw["subject"] === "string" ? raw["subject"] : "",
      statusName: typeof extra?.name === "string" ? extra.name : null,
      isClosed: extra?.is_closed === true || raw["is_closed"] === true,
    };
  }

  /** Web URL for a card, for links in Discord embeds. */
  storyUrl(ref: number): string {
    return `${this.webBase()}/project/${this.config.TAIGA_PROJECT_SLUG}/us/${ref}`;
  }

  epicUrl(ref: number): string {
    return `${this.webBase()}/project/${this.config.TAIGA_PROJECT_SLUG}/epic/${ref}`;
  }

  private webBase(): string {
    return this.config.TAIGA_WEB_URL.replace(/\/+$/, "");
  }
}
