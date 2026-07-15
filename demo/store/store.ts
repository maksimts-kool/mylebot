import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RankCode } from "../domain/ranks.js";
import { RANK_CODES } from "../domain/ranks.js";
import type { AnswerRecord, Question, Score } from "../domain/questions.js";
import { defaultQuestions } from "../domain/questions.js";

// ---- Record shapes (mirror the production Prisma models; see demo/README.md) ----
// robloxUserId is stored as a decimal string so the JSON store never touches BigInt.

export type ApplicationState = "IN_PROGRESS" | "SUBMITTED" | "ACCEPTED" | "REJECTED" | "CANCELLED";
export type Track = "SURFER" | "ENGINEER";

export interface Application {
  id: string;
  discordUserId: string;
  robloxUserId: string | null;
  robloxUsername: string | null;
  track: Track;
  targetRank: "LS" | "LE";
  state: ApplicationState;
  threadId: string | null;
  reviewMessageId: string | null;
  currentIndex: number;
  answers: AnswerRecord[];
  score: Score | null;
  reviewerId: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StaffMember {
  discordUserId: string;
  robloxUserId: string;
  robloxUsername: string;
  rank: RankCode;
  probation: boolean;
  hiredAt: string;
  hiredBy: string;
  updatedAt: string;
}

export interface RankConfig {
  discordRoleId: string | null;
  groupRoleId: string | null;
  groupRankNumber: number | null;
}

export interface Settings {
  applicationsChannelId: string | null;
  reviewChannelId: string | null;
}

export interface AuditRecord {
  id: string;
  actorId: string;
  action: string;
  note: string | null;
  before: unknown;
  after: unknown;
  at: string;
}

export interface StoreData {
  version: 1;
  settings: Settings;
  rankConfig: Record<RankCode, RankConfig>;
  questions: Question[];
  applications: Application[];
  staff: StaffMember[];
  audit: AuditRecord[];
}

function emptyRankConfig(): Record<RankCode, RankConfig> {
  const config = {} as Record<RankCode, RankConfig>;
  for (const code of RANK_CODES) config[code] = { discordRoleId: null, groupRoleId: null, groupRankNumber: null };
  return config;
}

function seedData(): StoreData {
  return {
    version: 1,
    settings: { applicationsChannelId: null, reviewChannelId: null },
    rankConfig: emptyRankConfig(),
    questions: defaultQuestions(),
    applications: [],
    staff: [],
    audit: [],
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * In-memory store with optional JSON-file persistence. When `path` is null the
 * store is pure in-memory (used by tests). Nothing here touches PostgreSQL or the
 * production Prisma client — this is the demo's isolated data layer.
 */
export class Store {
  private constructor(
    private data: StoreData,
    private readonly path: string | null,
  ) {}

  static async open(path: string | null): Promise<Store> {
    if (!path) return new Store(seedData(), null);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as StoreData;
      return new Store(migrate(parsed), path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const store = new Store(seedData(), path);
        await store.persist();
        return store;
      }
      throw error;
    }
  }

  private async persist(): Promise<void> {
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
  }

  snapshot(): StoreData {
    return structuredClone(this.data);
  }

  // ---- Settings ----
  getSettings(): Settings {
    return { ...this.data.settings };
  }

  async setApplicationsChannel(channelId: string): Promise<void> {
    this.data.settings.applicationsChannelId = channelId;
    await this.persist();
  }

  async setReviewChannel(channelId: string): Promise<void> {
    this.data.settings.reviewChannelId = channelId;
    await this.persist();
  }

  // ---- Rank config ----
  getRankConfig(code: RankCode): RankConfig {
    return { ...this.data.rankConfig[code] };
  }

  allRankConfig(): Record<RankCode, RankConfig> {
    return structuredClone(this.data.rankConfig);
  }

  async setRankConfig(code: RankCode, patch: Partial<RankConfig>): Promise<void> {
    this.data.rankConfig[code] = { ...this.data.rankConfig[code], ...patch };
    await this.persist();
  }

  // ---- Questions ----
  listQuestions(): Question[] {
    return structuredClone(this.data.questions).sort((a, b) => a.order - b.order);
  }

  getQuestion(id: string): Question | null {
    const found = this.data.questions.find((q) => q.id === id);
    return found ? structuredClone(found) : null;
  }

  async addQuestion(question: Omit<Question, "id" | "order">): Promise<Question> {
    const maxOrder = this.data.questions.reduce((max, q) => Math.max(max, q.order), 0);
    const created: Question = { ...question, id: randomUUID(), order: maxOrder + 1 };
    this.data.questions.push(created);
    await this.persist();
    return structuredClone(created);
  }

  async updateQuestion(id: string, patch: Partial<Omit<Question, "id">>): Promise<Question | null> {
    const question = this.data.questions.find((q) => q.id === id);
    if (!question) return null;
    Object.assign(question, patch);
    await this.persist();
    return structuredClone(question);
  }

  async removeQuestion(id: string): Promise<boolean> {
    const before = this.data.questions.length;
    this.data.questions = this.data.questions.filter((q) => q.id !== id);
    const removed = this.data.questions.length !== before;
    if (removed) await this.persist();
    return removed;
  }

  /** Move a question up or down within its display order. */
  async moveQuestion(id: string, direction: "up" | "down"): Promise<boolean> {
    const ordered = [...this.data.questions].sort((a, b) => a.order - b.order);
    const index = ordered.findIndex((q) => q.id === id);
    if (index === -1) return false;
    const swapWith = direction === "up" ? index - 1 : index + 1;
    const a = ordered[index];
    const b = ordered[swapWith];
    if (!a || !b) return false;
    const tmp = a.order;
    a.order = b.order;
    b.order = tmp;
    await this.persist();
    return true;
  }

  // ---- Applications ----
  getApplication(id: string): Application | null {
    const found = this.data.applications.find((a) => a.id === id);
    return found ? structuredClone(found) : null;
  }

  getApplicationByThread(threadId: string): Application | null {
    const found = this.data.applications.find((a) => a.threadId === threadId);
    return found ? structuredClone(found) : null;
  }

  getInProgressForUser(discordUserId: string): Application | null {
    const found = this.data.applications.find((a) => a.discordUserId === discordUserId && a.state === "IN_PROGRESS");
    return found ? structuredClone(found) : null;
  }

  async createApplication(input: {
    discordUserId: string;
    robloxUserId: string;
    robloxUsername: string;
    track: Track;
    targetRank: "LS" | "LE";
    threadId: string | null;
    answers: AnswerRecord[];
  }): Promise<Application> {
    const timestamp = nowIso();
    const application: Application = {
      id: randomUUID(),
      discordUserId: input.discordUserId,
      robloxUserId: input.robloxUserId,
      robloxUsername: input.robloxUsername,
      track: input.track,
      targetRank: input.targetRank,
      state: "IN_PROGRESS",
      threadId: input.threadId,
      reviewMessageId: null,
      currentIndex: 0,
      answers: input.answers,
      score: null,
      reviewerId: null,
      reason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.data.applications.push(application);
    await this.persist();
    return structuredClone(application);
  }

  async updateApplication(id: string, patch: Partial<Omit<Application, "id">>): Promise<Application | null> {
    const application = this.data.applications.find((a) => a.id === id);
    if (!application) return null;
    Object.assign(application, patch, { updatedAt: nowIso() });
    await this.persist();
    return structuredClone(application);
  }

  // ---- Staff ----
  listStaff(): StaffMember[] {
    return structuredClone(this.data.staff);
  }

  getStaffByDiscord(discordUserId: string): StaffMember | null {
    const found = this.data.staff.find((s) => s.discordUserId === discordUserId);
    return found ? structuredClone(found) : null;
  }

  async upsertStaff(member: Omit<StaffMember, "updatedAt">): Promise<StaffMember> {
    const existing = this.data.staff.find((s) => s.discordUserId === member.discordUserId);
    const updated: StaffMember = { ...member, updatedAt: nowIso() };
    if (existing) Object.assign(existing, updated);
    else this.data.staff.push(updated);
    await this.persist();
    return structuredClone(updated);
  }

  async removeStaff(discordUserId: string): Promise<boolean> {
    const before = this.data.staff.length;
    this.data.staff = this.data.staff.filter((s) => s.discordUserId !== discordUserId);
    const removed = this.data.staff.length !== before;
    if (removed) await this.persist();
    return removed;
  }

  // ---- Audit ----
  listAudit(): AuditRecord[] {
    return structuredClone(this.data.audit);
  }

  async audit(entry: Omit<AuditRecord, "id" | "at">): Promise<void> {
    this.data.audit.push({ ...entry, id: randomUUID(), at: nowIso() });
    await this.persist();
  }
}

function migrate(data: StoreData): StoreData {
  // Forward-compatible defaulting so an older store file still loads.
  const base = seedData();
  return {
    version: 1,
    settings: { ...base.settings, ...data.settings },
    rankConfig: { ...base.rankConfig, ...data.rankConfig },
    questions: Array.isArray(data.questions) && data.questions.length ? data.questions : base.questions,
    applications: Array.isArray(data.applications) ? data.applications : [],
    staff: Array.isArray(data.staff) ? data.staff : [],
    audit: Array.isArray(data.audit) ? data.audit : [],
  };
}
