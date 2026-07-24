import type { FastifyPluginAsync } from "fastify";
import type { Config } from "../../../core/config.js";
import { errorType } from "../../../core/errors.js";
import { taigaWebhookSchema, verifyTaigaSignature, webhookFingerprint, type TaigaWebhookPayload } from "../domain/webhook.js";

export type TaigaDelivery = (payload: TaigaWebhookPayload, fingerprint: string) => Promise<boolean>;

export type TaigaRouteOptions = {
  config: Config;
  onDelivery: TaigaDelivery;
};

export function taigaRoutes({ config, onDelivery }: TaigaRouteOptions): FastifyPluginAsync {
  return async (app) => {
    // The signature covers the raw bytes, so this scope keeps the body as text.
    // Content type parsers are encapsulated, so other routes still get objects.
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
      done(null, body);
    });

    app.post("/v1/taiga/webhook", async (request, reply) => {
      if (!config.TAIGA_WEBHOOK_SECRET) return reply.code(503).send({ error: "taiga_webhook_disabled" });
      const rawBody = typeof request.body === "string" ? request.body : "";
      const signature = request.headers["x-taiga-webhook-signature"];
      if (!verifyTaigaSignature(rawBody, typeof signature === "string" ? signature : undefined, config.TAIGA_WEBHOOK_SECRET)) {
        return reply.code(401).send({ error: "invalid_signature" });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return reply.code(400).send({ error: "invalid_payload" });
      }
      const result = taigaWebhookSchema.safeParse(parsed);
      if (!result.success) return reply.code(400).send({ error: "invalid_payload" });

      try {
        const applied = await onDelivery(result.data, webhookFingerprint(rawBody));
        return reply.code(202).send({ status: applied ? "accepted" : "duplicate" });
      } catch (error) {
        // Answer 202 anyway: a retry carries the same body and is deduplicated,
        // so the reconcile sweep is what actually repairs a failed delivery.
        app.log.error({ feature: "taiga", action: result.data.action, type: result.data.type, errorType: errorType(error) }, "Taiga webhook processing failed");
        return reply.code(202).send({ status: "deferred" });
      }
    });
  };
}
