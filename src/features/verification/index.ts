import { verificationConfigured } from "../../core/config.js";
import type { Feature, FeatureContext } from "../../core/feature.js";
import { VerificationCommandHandler, verificationCommandData } from "./discord/commands.js";
import { DiscordVerificationGateway } from "./discord/gateway.js";
import { VERIFICATION_CHECK_INTERVAL_MS } from "./domain/policy.js";
import { VerificationService } from "./service/verification-service.js";

/** Discord-only reminders and removal for members who remain Unverified. */
export function createVerificationFeature(ctx: FeatureContext): Feature | null {
  if (!verificationConfigured(ctx.config)) {
    ctx.log.info({ feature: "verification" }, "Verification reminders are not configured; skipping");
    return null;
  }

  const gateway = new DiscordVerificationGateway(ctx.client, ctx.config);
  const service = new VerificationService(ctx.db, ctx.config.DISCORD_GUILD_ID, gateway, ctx.log);
  new VerificationCommandHandler(ctx.client, ctx.db, ctx.config, service).register();

  return {
    name: "verification",
    commands: verificationCommandData,
    onReady: async () => { await service.run(); },
    jobs: [{
      name: "Discord verification reminder",
      // Check hourly so a restart cannot shift or stretch the persisted
      // three-day posting cadence.
      intervalMs: VERIFICATION_CHECK_INTERVAL_MS,
      run: async () => { await service.run(); },
    }],
  };
}
