import { RANKS } from "./domain/ranks.js";
import { IdentityService } from "./services/identity.js";
import { RobloxOpenCloudService } from "./services/roblox-open-cloud.js";
import { DemoError } from "./domain/errors.js";
import { parseChoiceOptions, StaffService, type Actor } from "./services/staff-service.js";
import { Store } from "./store/store.js";

// End-to-end demo with NO Discord and NO database (in-memory store). Exercises:
// apply -> guided questionnaire (text + emoji-button practical) -> auto-grade ->
// supervisor review/accept -> Roblox rank sync (dry-run) -> promote/demote + governance.

function heading(title: string): void {
  console.log(`\n\x1b[1m\x1b[36m=== ${title} ===\x1b[0m`);
}

async function main(): Promise<void> {
  const store = await Store.open(null); // pure in-memory
  const identity = new IdentityService({ bloxlinkApiKey: null, bloxlinkBaseUrl: "https://api.blox.link/v4/public", guildId: null });
  const roblox = new RobloxOpenCloudService({ apiKey: null, groupId: "0", baseUrl: "https://apis.roblox.com/cloud/v2" }); // dry-run
  const service = new StaffService(store, identity, roblox, 3);

  const APPLICANT = "discord-applicant-1";
  const MANAGER: Actor = { discordUserId: "discord-sm-1", rank: RANKS.SM, managerOverride: false };
  const SURFER_SUP: Actor = { discordUserId: "discord-ss-1", rank: RANKS.SS, managerOverride: false };

  heading("Manager configures rank -> role/group mappings (like /staff config)");
  await store.setRankConfig("LS", { discordRoleId: "role-ls", groupRoleId: "88811100" });
  await store.setRankConfig("SS", { discordRoleId: "role-ss", groupRoleId: "88811200" });
  await store.setApplicationsChannel("chan-apps");
  await store.setReviewChannel("chan-review");
  console.log("LS ->", store.getRankConfig("LS"));

  heading("Manager adds a new practical question interactively (like /staff questions)");
  const options = parseChoiceOptions("🚪 | Open the doors at the floor | correct\n⚡ | Send it express\n🛑 | Kill all power");
  const added = await service.addChoiceQuestion({ track: "SURFER", prompt: "A rider missed their floor. What do you do?", imageUrl: null, options, required: true });
  console.log(`Added ${added.kind} question to ${added.track}: "${added.prompt}" with ${added.options?.length} emoji options`);

  heading("Player runs /apply track:Surfer");
  const prep = await service.prepareApplication(APPLICANT, "SURFER");
  console.log(`Resolved Roblox identity: ${prep.identity.username} (${prep.identity.userId})`);
  console.log(`Questionnaire has ${prep.questions.length} active questions for the Surfer track`);
  let application = await service.createApplication({ discordUserId: APPLICANT, identity: prep.identity, track: "SURFER", questions: prep.questions, threadId: null });

  heading("Applicant answers the guided thread questionnaire");
  for (;;) {
    const current = store.getApplication(application.id);
    if (!current) break;
    const answer = current.answers[current.currentIndex];
    if (!answer) break;
    if (answer.kind === "TEXT") {
      const reply = "Sample answer for the demo.";
      console.log(`Q${current.currentIndex + 1} [text] ${answer.prompt}\n   ✍️  "${reply}"`);
      const result = await service.submitTextAnswer(application.id, reply);
      if (result.status === "SUBMITTED") { application = result.application; break; }
    } else {
      const correctIndex = (answer.options ?? []).findIndex((o) => o.correct);
      const chosen = answer.options?.[correctIndex];
      console.log(`Q${current.currentIndex + 1} [practical] ${answer.prompt}\n   👉 pressed ${chosen?.emoji} ${chosen?.label}`);
      const result = await service.submitChoiceAnswer(application.id, answer.questionId, correctIndex);
      if (result.status === "SUBMITTED") { application = result.application; break; }
    }
  }
  console.log(`\nApplication state: ${application.state} · practical score: ${application.score?.correct}/${application.score?.total}`);

  heading("Surfers Supervisor accepts the application (governance-checked)");
  const decision = await service.decide({ applicationId: application.id, actor: SURFER_SUP, accept: true });
  console.log(`Decision: ${decision.decision}`);
  console.log(`Roblox rank sync: ${decision.rankSync?.message}`);
  console.log(`Discord role to assign: ${decision.discordRoleId}`);
  console.log("Roster:", store.listStaff().map((m) => `${m.robloxUsername}=${m.rank}${m.probation ? "(probation)" : ""}`));

  heading("Manager promotes the new Surfer to Surfers Supervisor");
  const promo = await service.setMemberRank({ actor: MANAGER, targetDiscordId: APPLICANT, newRank: "SS" });
  console.log(`${promo.action}: now ${RANKS[promo.member.rank].label} · rank sync: ${promo.rankSync.message}`);

  heading("Governance guardrail: a Surfers Supervisor may NOT create a peer");
  try {
    await service.setMemberRank({ actor: SURFER_SUP, targetDiscordId: APPLICANT, newRank: "SM" });
    console.log("Unexpectedly allowed!");
  } catch (error) {
    console.log(`Blocked as expected: ${error instanceof DemoError ? error.message : String(error)}`);
  }

  heading("Audit trail");
  for (const entry of store.listAudit()) console.log(`• ${entry.action} by ${entry.actorId}${entry.note ? ` — ${entry.note}` : ""}`);

  console.log("\n\x1b[32mDemo flow complete. No Discord, no database, production project untouched.\x1b[0m");
}

main().catch((error) => { console.error(error); process.exit(1); });
