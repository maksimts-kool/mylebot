import { verificationConfigured } from "../../core/config.js";
import type { BotContext, BotFeature } from "../../core/feature.js";
import { LinkUnavailableError } from "../../core/link.js";
import { VerificationCommandHandler, verificationCommandData, verificationHelp } from "./discord/commands.js";
import { verificationConfigSection } from "./discord/config-section.js";
import { DiscordVerificationGateway } from "./discord/gateway.js";
import { VERIFICATION_PORT, type VerificationBotPort, type VerificationServerPort } from "./link.js";

/** Verification's Discord surface: `/verification status`, its `/config` page, and the gateway the cycle runs against. */
export function createVerificationBot(ctx: BotContext): BotFeature | null {
  if (!verificationConfigured(ctx.config)) return null;
  const verification = ctx.server.port<VerificationServerPort>(VERIFICATION_PORT);
  const gateway = new DiscordVerificationGateway(ctx.client, ctx.config);
  new VerificationCommandHandler(ctx.client, ctx.config, ctx.shared, verification).register();

  /** The cycle is the server's; it can only run against a connected gateway. */
  const ready = <T>(work: () => Promise<T>): Promise<T> => {
    if (!ctx.client.isReady()) return Promise.reject(new LinkUnavailableError("Discord is not connected"));
    return work();
  };
  const port: VerificationBotPort = {
    listUnverifiedMembers: () => ready(() => gateway.listUnverifiedMembers()),
    postGeneralReminder: () => ready(() => gateway.postGeneralReminder()),
    postFinalWarning: (members) => ready(() => gateway.postFinalWarning(members)),
    postRemovedMembers: (members) => ready(() => gateway.postRemovedMembers(members)),
    kick: (member) => ready(() => gateway.kick(member)),
  };

  return {
    name: "verification",
    commands: verificationCommandData,
    help: verificationHelp,
    configSections: [verificationConfigSection(ctx.config, verification)],
    ports: { [VERIFICATION_PORT]: port },
  };
}
