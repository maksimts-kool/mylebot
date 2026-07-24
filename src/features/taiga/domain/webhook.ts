import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Taiga signs the raw POST body with HMAC-SHA1 under the webhook's secret key
 * and sends the hex digest in X-TAIGA-WEBHOOK-SIGNATURE.
 */
export function verifyTaigaSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac("sha1", secret).update(rawBody, "utf8").digest("hex");
  const supplied = Buffer.from(signature.trim().toLowerCase());
  const expectedBuffer = Buffer.from(expected);
  return supplied.length === expectedBuffer.length && timingSafeEqual(supplied, expectedBuffer);
}

/**
 * Taiga retries deliveries and has no delivery ID, so the body itself is the
 * idempotency key: a retry repeats it byte for byte, while two genuine events
 * always differ in at least their `date`.
 */
export function webhookFingerprint(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

const taigaUser = z.object({
  id: z.number().optional(),
  username: z.string().optional(),
  full_name: z.string().optional(),
}).loose();

const taigaStatus = z.object({
  id: z.number().optional(),
  name: z.string().optional(),
  is_closed: z.boolean().optional(),
}).loose();

const taigaObject = z.object({
  id: z.number(),
  ref: z.number().optional(),
  subject: z.string().optional(),
  status: taigaStatus.optional(),
  is_closed: z.boolean().optional(),
  permalink: z.string().optional(),
  project: z.object({ id: z.number().optional(), name: z.string().optional() }).loose().optional(),
}).loose();

export const taigaWebhookSchema = z.object({
  action: z.enum(["create", "change", "delete", "test"]),
  type: z.string(),
  by: taigaUser.optional(),
  date: z.string().optional(),
  data: taigaObject,
  change: z.object({
    diff: z.record(z.string(), z.unknown()).optional(),
    comment: z.string().optional(),
  }).loose().optional(),
}).loose();

export type TaigaWebhookPayload = z.infer<typeof taigaWebhookSchema>;

/**
 * The column the object is in *now*. The `change.diff` is only a description of
 * what moved; `data.status` is the authoritative current state, which also makes
 * a replayed delivery converge on the right answer.
 */
export function currentColumn(payload: TaigaWebhookPayload): string | null {
  const name = payload.data.status?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** Whether a change payload actually touched the kanban column. */
export function changedColumn(payload: TaigaWebhookPayload): boolean {
  return Boolean(payload.change?.diff && "status" in payload.change.diff);
}
