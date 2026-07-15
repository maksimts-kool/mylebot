import { describe, expect, it } from "vitest";
import { DemoError } from "../domain/errors.js";
import { RANKS } from "../domain/ranks.js";
import { IdentityService } from "../services/identity.js";
import { RobloxOpenCloudService } from "../services/roblox-open-cloud.js";
import { StaffService, type Actor } from "../services/staff-service.js";
import { Store } from "../store/store.js";

async function newService(): Promise<{ store: Store; service: StaffService }> {
  const store = await Store.open(null);
  const identity = new IdentityService({ bloxlinkApiKey: null, bloxlinkBaseUrl: "https://x", guildId: null });
  const roblox = new RobloxOpenCloudService({ apiKey: null, groupId: "0", baseUrl: "https://x" });
  return { store, service: new StaffService(store, identity, roblox, 2) };
}

async function runQuestionnaire(store: Store, service: StaffService, applicationId: string, correct: boolean): Promise<void> {
  for (;;) {
    const app = store.getApplication(applicationId);
    if (!app) throw new Error("missing application");
    const answer = app.answers[app.currentIndex];
    if (!answer) break;
    const result = answer.kind === "TEXT"
      ? await service.submitTextAnswer(applicationId, "answer")
      : await service.submitChoiceAnswer(applicationId, answer.questionId, (answer.options ?? []).findIndex((o) => o.correct === correct));
    if (result.status === "SUBMITTED") break;
  }
}

const SM: Actor = { discordUserId: "sm", rank: RANKS.SM, managerOverride: false };
const SS: Actor = { discordUserId: "ss", rank: RANKS.SS, managerOverride: false };

describe("application flow", () => {
  it("runs apply -> answer -> submit -> accept -> hire, with rank-sync dry-run", async () => {
    const { store, service } = await newService();
    await store.setRankConfig("LS", { discordRoleId: "role-ls", groupRoleId: "111" });

    const prep = await service.prepareApplication("applicant", "SURFER");
    const app = await service.createApplication({ discordUserId: "applicant", identity: prep.identity, track: "SURFER", questions: prep.questions, threadId: "thread-1" });
    await runQuestionnaire(store, service, app.id, true);

    const submitted = store.getApplication(app.id)!;
    expect(submitted.state).toBe("SUBMITTED");
    expect(submitted.score?.correct).toBe(submitted.score?.total);

    const decision = await service.decide({ applicationId: app.id, actor: SS, accept: true });
    expect(decision.decision).toBe("ACCEPTED");
    expect(decision.discordRoleId).toBe("role-ls");
    expect(decision.rankSync?.dryRun).toBe(true);

    const member = store.getStaffByDiscord("applicant");
    expect(member?.rank).toBe("LS");
    expect(member?.probation).toBe(true);
  });

  it("blocks a second in-progress application and applications from existing staff", async () => {
    const { store, service } = await newService();
    const prep = await service.prepareApplication("applicant", "SURFER");
    await service.createApplication({ discordUserId: "applicant", identity: prep.identity, track: "SURFER", questions: prep.questions, threadId: null });
    await expect(service.prepareApplication("applicant", "SURFER")).rejects.toBeInstanceOf(DemoError);

    await store.upsertStaff({ discordUserId: "already", robloxUserId: "1", robloxUsername: "x", rank: "LE", probation: false, hiredAt: new Date().toISOString(), hiredBy: "sm" });
    await expect(service.prepareApplication("already", "ENGINEER")).rejects.toBeInstanceOf(DemoError);
  });

  it("enforces review governance: SS cannot review an Engineer application", async () => {
    const { store, service } = await newService();
    const prep = await service.prepareApplication("eng-applicant", "ENGINEER");
    const app = await service.createApplication({ discordUserId: "eng-applicant", identity: prep.identity, track: "ENGINEER", questions: prep.questions, threadId: null });
    await runQuestionnaire(store, service, app.id, true);
    await expect(service.decide({ applicationId: app.id, actor: SS, accept: true })).rejects.toBeInstanceOf(DemoError);
    await expect(service.decide({ applicationId: app.id, actor: SM, accept: true })).resolves.toMatchObject({ decision: "ACCEPTED" });
  });

  it("promotes and demotes with governance, recording audit direction", async () => {
    const { store, service } = await newService();
    await store.upsertStaff({ discordUserId: "u", robloxUserId: "1", robloxUsername: "U", rank: "LS", probation: false, hiredAt: new Date().toISOString(), hiredBy: "sm" });

    const promo = await service.setMemberRank({ actor: SM, targetDiscordId: "u", newRank: "SS" });
    expect(promo.action).toBe("STAFF_PROMOTE");
    expect(store.getStaffByDiscord("u")?.rank).toBe("SS");

    const demo = await service.setMemberRank({ actor: SM, targetDiscordId: "u", newRank: "LS" });
    expect(demo.action).toBe("STAFF_DEMOTE");

    // SS cannot promote someone into a peer/senior rank.
    await expect(service.setMemberRank({ actor: SS, targetDiscordId: "u", newRank: "SS" })).rejects.toBeInstanceOf(DemoError);
  });

  it("supports interactive question CRUD used by /staff questions", async () => {
    const { store, service } = await newService();
    const before = store.listQuestions().length;
    const q = await service.addChoiceQuestion({ track: "SURFER", prompt: "Which button?", imageUrl: null, options: [{ emoji: "🔼", label: "Up", correct: true }, { emoji: "🔽", label: "Down", correct: false }], required: true });
    expect(store.listQuestions().length).toBe(before + 1);
    await service.setQuestionActive(q.id, false);
    expect(store.getQuestion(q.id)?.active).toBe(false);
    await service.removeQuestion(q.id);
    expect(store.getQuestion(q.id)).toBeNull();

    await expect(service.addChoiceQuestion({ track: "SURFER", prompt: "bad", imageUrl: null, options: [{ emoji: "🔼", label: "Up", correct: false }], required: true })).rejects.toBeInstanceOf(DemoError);
  });
});
