import { demoError } from "../domain/errors.js";
import type { ChoiceOption, Question, TextStyle } from "../domain/questions.js";
import { questionsForTrack, scoreAnswers, snapshotQuestion } from "../domain/questions.js";
import type { RankCode, RankDef } from "../domain/ranks.js";
import { RANKS, canManageRank, canReviewApplication, canSetRank, entryRankForTrack } from "../domain/ranks.js";
import type { Application, Store, Track } from "../store/store.js";
import type { IdentityService, RobloxIdentity } from "./identity.js";
import type { RankSyncResult, RobloxOpenCloudService } from "./roblox-open-cloud.js";

export interface Actor {
  discordUserId: string;
  /** Resolved staff rank, or null if not staff. */
  rank: RankDef | null;
  /** Discord Administrator override — treated as Staff Manager for governance. */
  managerOverride: boolean;
}

export type AdvanceResult =
  | { status: "ASK"; index: number; total: number }
  | { status: "SUBMITTED"; application: Application };

export interface DecisionResult {
  decision: "ACCEPTED" | "REJECTED";
  application: Application;
  rankSync: RankSyncResult | null;
  discordRoleId: string | null;
}

export interface RankChangeResult {
  member: { discordUserId: string; robloxUsername: string; rank: RankCode };
  rankSync: RankSyncResult;
  addRoleId: string | null;
  removeRoleId: string | null;
  action: "STAFF_ASSIGN" | "STAFF_PROMOTE" | "STAFF_DEMOTE";
  created: boolean;
}

export class StaffService {
  constructor(
    private readonly store: Store,
    private readonly identity: IdentityService,
    private readonly roblox: RobloxOpenCloudService,
    private readonly passingScore: number,
  ) {}

  /** Resolve an actor's effective rank for governance (Administrator counts as SM). */
  effectiveRank(actor: Actor): RankDef | null {
    if (actor.managerOverride) return RANKS.SM;
    return actor.rank;
  }

  staffRank(discordUserId: string): RankDef | null {
    const member = this.store.getStaffByDiscord(discordUserId);
    return member ? RANKS[member.rank] : null;
  }

  // ---------------------------------------------------------------- Applications

  /** Validate eligibility and resolve identity + the question set, before any thread is created. */
  async prepareApplication(discordUserId: string, track: Track): Promise<{ identity: RobloxIdentity; targetRank: "LS" | "LE"; questions: Question[] }> {
    if (this.store.getStaffByDiscord(discordUserId)) demoError("You are already staff — applications are for non-staff only.");
    if (this.store.getInProgressForUser(discordUserId)) demoError("You already have an application in progress. Finish or cancel it first.");
    const identity = await this.identity.robloxForDiscord(discordUserId);
    if (!identity) demoError("Could not resolve your Roblox account. Link it with Bloxlink and try again.");
    const questions = questionsForTrack(this.store.listQuestions(), track);
    if (!questions.length) demoError("No application questions are configured for that track yet. Ask a manager to set them up.");
    return { identity, targetRank: entryRankForTrack(track), questions };
  }

  async createApplication(input: { discordUserId: string; identity: RobloxIdentity; track: Track; questions: Question[]; threadId: string | null }): Promise<Application> {
    const application = await this.store.createApplication({
      discordUserId: input.discordUserId,
      robloxUserId: input.identity.userId,
      robloxUsername: input.identity.username,
      track: input.track,
      targetRank: entryRankForTrack(input.track),
      threadId: input.threadId,
      answers: input.questions.map((q) => snapshotQuestion(q)),
    });
    await this.store.audit({ actorId: input.discordUserId, action: "APPLICATION_START", note: `${input.track} application started`, before: null, after: { applicationId: application.id } });
    return application;
  }

  /** The answer currently awaiting input, or null when the questionnaire is complete. */
  currentAnswer(application: Application): Application["answers"][number] | null {
    return application.answers[application.currentIndex] ?? null;
  }

  async submitTextAnswer(applicationId: string, text: string): Promise<AdvanceResult> {
    const application = this.requireInProgress(applicationId);
    const answer = application.answers[application.currentIndex];
    if (!answer) demoError("This application has no pending question.");
    if (answer.kind !== "TEXT") demoError("This question needs a button answer, not text.");
    const trimmed = text.trim();
    if (!trimmed) demoError("Please type an answer.");
    answer.text = trimmed;
    return this.advance(application);
  }

  async submitChoiceAnswer(applicationId: string, questionId: string, chosenIndex: number): Promise<AdvanceResult> {
    const application = this.requireInProgress(applicationId);
    const answer = application.answers[application.currentIndex];
    if (!answer) demoError("This application has no pending question.");
    if (answer.kind !== "CHOICE" || !answer.options) demoError("This question does not take a button answer.");
    if (answer.questionId !== questionId) demoError("That answer is for a different question.");
    const option = answer.options[chosenIndex];
    if (!option) demoError("Unknown option.");
    answer.chosenIndex = chosenIndex;
    answer.correct = option.correct;
    return this.advance(application);
  }

  private async advance(application: Application): Promise<AdvanceResult> {
    const nextIndex = application.currentIndex + 1;
    if (nextIndex < application.answers.length) {
      const updated = await this.store.updateApplication(application.id, { currentIndex: nextIndex, answers: application.answers });
      return { status: "ASK", index: nextIndex, total: (updated ?? application).answers.length };
    }
    const score = scoreAnswers(application.answers);
    const updated = await this.store.updateApplication(application.id, { currentIndex: nextIndex, answers: application.answers, state: "SUBMITTED", score });
    const submitted = updated ?? application;
    await this.store.audit({ actorId: application.discordUserId, action: "APPLICATION_SUBMIT", note: `Practical ${score.correct}/${score.total}`, before: null, after: { applicationId: application.id, score } });
    return { status: "SUBMITTED", application: submitted };
  }

  private requireInProgress(applicationId: string): Application {
    const application = this.store.getApplication(applicationId);
    if (!application) demoError("Application not found.");
    if (application.state !== "IN_PROGRESS") demoError("This application is no longer in progress.");
    return application;
  }

  getPassingScore(): number {
    return this.passingScore;
  }

  // ---------------------------------------------------------------- Review / hire

  async decide(input: { applicationId: string; actor: Actor; accept: boolean; reason?: string }): Promise<DecisionResult> {
    const application = this.store.getApplication(input.applicationId);
    if (!application) demoError("Application not found.");
    if (application.state !== "SUBMITTED") demoError("Only submitted applications can be reviewed.");
    const actorRank = this.effectiveRank(input.actor);
    if (!actorRank || !canReviewApplication(actorRank, application.targetRank)) {
      demoError(`You cannot review ${RANKS[application.targetRank].label} applications.`);
    }

    if (!input.accept) {
      const updated = await this.store.updateApplication(application.id, { state: "REJECTED", reviewerId: input.actor.discordUserId, reason: input.reason ?? null });
      await this.store.audit({ actorId: input.actor.discordUserId, action: "APPLICATION_REJECT", note: input.reason ?? null, before: { state: "SUBMITTED" }, after: { state: "REJECTED" } });
      return { decision: "REJECTED", application: updated ?? application, rankSync: null, discordRoleId: null };
    }

    const rankConfig = this.store.getRankConfig(application.targetRank);
    const rankSync = await this.roblox.setRank(application.robloxUserId ?? "", rankConfig.groupRoleId ?? "");
    await this.store.upsertStaff({
      discordUserId: application.discordUserId,
      robloxUserId: application.robloxUserId ?? "",
      robloxUsername: application.robloxUsername ?? "",
      rank: application.targetRank,
      probation: true,
      hiredAt: new Date().toISOString(),
      hiredBy: input.actor.discordUserId,
    });
    const updated = await this.store.updateApplication(application.id, { state: "ACCEPTED", reviewerId: input.actor.discordUserId });
    await this.store.audit({ actorId: input.actor.discordUserId, action: "STAFF_HIRE", note: `${application.targetRank} · rank-sync ${rankSync.ok ? (rankSync.dryRun ? "dry-run" : "ok") : "FAILED"}`, before: null, after: { discordUserId: application.discordUserId, rank: application.targetRank } });
    return { decision: "ACCEPTED", application: updated ?? application, rankSync, discordRoleId: rankConfig.discordRoleId };
  }

  // ---------------------------------------------------------------- Promote / demote

  async setMemberRank(input: { actor: Actor; targetDiscordId: string; newRank: RankCode }): Promise<RankChangeResult> {
    const member = this.store.getStaffByDiscord(input.targetDiscordId);
    if (!member) demoError("That user is not a staff member.");
    const current = RANKS[member.rank];
    const next = RANKS[input.newRank];
    if (current.code === next.code) demoError(`They are already ${next.label}.`);
    const actorRank = this.effectiveRank(input.actor);
    if (!actorRank || !canSetRank(actorRank, current, next)) {
      demoError(`You cannot change ${member.robloxUsername} from ${current.short} to ${next.short}.`);
    }

    const nextConfig = this.store.getRankConfig(next.code);
    const currentConfig = this.store.getRankConfig(current.code);
    const rankSync = await this.roblox.setRank(member.robloxUserId, nextConfig.groupRoleId ?? "");
    await this.store.upsertStaff({ ...member, rank: next.code });
    const action = next.order > current.order ? "STAFF_PROMOTE" : "STAFF_DEMOTE";
    await this.store.audit({ actorId: input.actor.discordUserId, action, note: `${current.short} → ${next.short}`, before: { rank: current.code }, after: { rank: next.code } });
    return {
      member: { discordUserId: member.discordUserId, robloxUsername: member.robloxUsername, rank: next.code },
      rankSync,
      addRoleId: nextConfig.discordRoleId,
      removeRoleId: currentConfig.discordRoleId,
      action,
      created: false,
    };
  }

  /**
   * Directly place a user at a rank, creating the staff record if they are not staff yet.
   * Used by /staff assign to seed staff (e.g. the first supervisors) outside the apply flow.
   */
  async assignRank(input: { actor: Actor; targetDiscordId: string; newRank: RankCode }): Promise<RankChangeResult> {
    const next = RANKS[input.newRank];
    const actorRank = this.effectiveRank(input.actor);
    if (!actorRank) demoError("You do not have permission to assign ranks.");
    const existing = this.store.getStaffByDiscord(input.targetDiscordId);
    const current = existing ? RANKS[existing.rank] : null;
    if (current && current.code === next.code) demoError(`They are already ${next.label}.`);
    const allowed = current ? canSetRank(actorRank, current, next) : canManageRank(actorRank, next);
    if (!allowed) demoError(`You cannot assign ${next.label}.`);

    let robloxUserId = existing?.robloxUserId ?? null;
    let robloxUsername = existing?.robloxUsername ?? null;
    if (!existing) {
      const identity = await this.identity.robloxForDiscord(input.targetDiscordId);
      if (!identity) demoError("Could not resolve that user's Roblox account. Link it with Bloxlink and try again.");
      robloxUserId = identity.userId;
      robloxUsername = identity.username;
    }

    const nextConfig = this.store.getRankConfig(next.code);
    const rankSync = await this.roblox.setRank(robloxUserId ?? "", nextConfig.groupRoleId ?? "");
    await this.store.upsertStaff({
      discordUserId: input.targetDiscordId,
      robloxUserId: robloxUserId ?? "",
      robloxUsername: robloxUsername ?? "",
      rank: next.code,
      probation: existing?.probation ?? false,
      hiredAt: existing?.hiredAt ?? new Date().toISOString(),
      hiredBy: existing?.hiredBy ?? input.actor.discordUserId,
    });
    const action = !current ? "STAFF_ASSIGN" : next.order > current.order ? "STAFF_PROMOTE" : "STAFF_DEMOTE";
    await this.store.audit({ actorId: input.actor.discordUserId, action, note: current ? `${current.short} → ${next.short}` : `assigned ${next.short}`, before: current ? { rank: current.code } : null, after: { rank: next.code } });
    return {
      member: { discordUserId: input.targetDiscordId, robloxUsername: robloxUsername ?? "", rank: next.code },
      rankSync,
      addRoleId: nextConfig.discordRoleId,
      removeRoleId: current ? this.store.getRankConfig(current.code).discordRoleId : null,
      action,
      created: !existing,
    };
  }

  // ---------------------------------------------------------------- Question editing

  async addTextQuestion(input: { track: Question["track"]; prompt: string; style: TextStyle; required: boolean }): Promise<Question> {
    if (!input.prompt.trim()) demoError("A question needs a prompt.");
    return this.store.addQuestion({ track: input.track, kind: "TEXT", prompt: input.prompt.trim(), required: input.required, active: true, style: input.style, imageUrl: null, options: null });
  }

  async addChoiceQuestion(input: { track: Question["track"]; prompt: string; imageUrl: string | null; options: ChoiceOption[]; required: boolean }): Promise<Question> {
    if (!input.prompt.trim()) demoError("A question needs a prompt.");
    if (input.options.length < 2) demoError("A practical question needs at least 2 options.");
    if (!input.options.some((o) => o.correct)) demoError("Mark exactly one option as correct.");
    return this.store.addQuestion({ track: input.track, kind: "CHOICE", prompt: input.prompt.trim(), required: input.required, active: true, style: null, imageUrl: input.imageUrl, options: input.options });
  }

  async setQuestionActive(id: string, active: boolean): Promise<void> {
    const updated = await this.store.updateQuestion(id, { active });
    if (!updated) demoError("Question not found.");
  }

  async moveQuestion(id: string, direction: "up" | "down"): Promise<void> {
    const ok = await this.store.moveQuestion(id, direction);
    if (!ok) demoError("Could not move that question.");
  }

  async removeQuestion(id: string): Promise<void> {
    const ok = await this.store.removeQuestion(id);
    if (!ok) demoError("Question not found.");
  }
}

/** Parse the `emoji | label | correct` lines used by the /staff questions option editor. */
export function parseChoiceOptions(raw: string): ChoiceOption[] {
  const options: ChoiceOption[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("|").map((p) => p.trim());
    const emoji = parts[0] ?? "";
    const label = parts[1] ?? "";
    const correct = /^(correct|true|yes|x|\*)$/i.test(parts[2] ?? "");
    if (!emoji || !label) continue;
    options.push({ emoji, label, correct });
  }
  return options;
}
