import { verificationConfigured } from "../../core/config.js";
import type { Feature, FeatureContext } from "../../core/feature.js";
import { VerificationCommandHandler, verificationCommandData, verificationHelp } from "./discord/commands.js";
import { verificationConfigSection } from "./discord/config-section.js";
import { DiscordVerificationGateway } from "./discord/gateway.js";
import { VERIFICATION_CHECK_INTERVAL_MS } from "./domain/policy.js";
import { VerificationService } from "./service/verification-service.js";

/** Discord-only reminders and removal for members who remain Unverified. */
export function createVerificationFeature(ctx: FeatureContext): Feature | null {
  if (!verificationConfigured(ctx.config)) {
    ctx.log.info({ category: "verify" }, "Not configured; skipping");
    return null;
  }

  const gateway = new DiscordVerificationGateway(ctx.client, ctx.config);
  const service = new VerificationService(ctx.db, ctx.config.DISCORD_GUILD_ID, gateway, ctx.log);
  new VerificationCommandHandler(ctx.client, ctx.db, ctx.config, service).register();

  return {
    name: "verification",
    commands: verificationCommandData,
    help: verificationHelp,
    configSections: [verificationConfigSection(ctx.config, service)],
    onReady: async () => { await service.run(); },
    jobs: [{
      name: "verification reminder",
      // Check hourly so a restart cannot shift or stretch the persisted
      // three-day posting cadence.
      intervalMs: VERIFICATION_CHECK_INTERVAL_MS,
      run: async () => { await service.run(); },
    }],
  };
}
