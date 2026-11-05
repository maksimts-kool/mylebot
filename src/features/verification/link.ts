import type { VerificationGateway, VerificationStatus } from "./service/verification-service.js";

/**
 * The contract between the two halves of verification. The server half keeps
 * each member's deadline and decides who is reminded, warned or removed; the
 * bot half lists who holds the Unverified role and does the posting and kicking.
 */

export const VERIFICATION_PORT = "verification";

/** What the server half asks of Discord: the gateway the verification cycle runs against. */
export type VerificationBotPort = VerificationGateway;

/** What `/verification status` and the `/config` page ask of the server half. */
export interface VerificationServerPort {
  status(): Promise<VerificationStatus>;
}
