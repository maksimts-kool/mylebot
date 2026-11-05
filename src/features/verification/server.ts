import { verificationConfigured } from "../../core/config.js";
import type { ServerContext, ServerFeature } from "../../core/feature.js";
import { VERIFICATION_CHECK_INTERVAL_MS } from "./domain/policy.js";
import { VERIFICATION_PORT, type VerificationBotPort, type VerificationServerPort } from "./link.js";
import { VerificationService } from "./service/verification-service.js";

/**
 * Reminders and removal for members who remain Unverified, the half that keeps
 * the deadlines. Every member it acts on is listed, posted to and kicked by
 * the bot half.
 */
export function createVerificationServer(ctx: ServerContext): ServerFeature | null {
  if (!verificationConfigured(ctx.config)) {
    ctx.log.info({ category: "verify" }, "Not configured; skipping");
    return null;
  }
  const service = new VerificationService(
    ctx.db, ctx.config.DISCORD_GUILD_ID, ctx.bot.port<VerificationBotPort>(VERIFICATION_PORT), ctx.log,
  );
  const port: VerificationServerPort = { status: () => service.status() };

  return {
    name: "verification",
    ports: { [VERIFICATION_PORT]: port },
    onBotReady: async () => { await service.run(); },
    jobs: [{
      name: "verification reminder",
      // Check hourly so a restart cannot shift or stretch the persisted
      // three-day posting cadence.
      intervalMs: VERIFICATION_CHECK_INTERVAL_MS,
      run: async () => { await service.run(); },
    }],
  };
}
