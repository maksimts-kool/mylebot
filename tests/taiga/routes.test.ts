import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/core/config.js";
import { buildHttpServer } from "../../src/core/http.js";
import { portalRoutes } from "../../src/features/portal/api/routes.js";
import { taigaRoutes, type TaigaDelivery } from "../../src/features/taiga/api/routes.js";

const config = loadConfig({
  DATABASE_URL: "postgresql://example.invalid/db",
  ROBLOX_INGESTION_SECRET: "12345678901234567890123456789012",
  ROBLOX_UNIVERSE_ID: "100",
  ROBLOX_GROUP_ID: "200",
  ROBLOX_ALLOWED_PLACE_IDS: "300",
  SITE_NOTIFY_SECRET: "site-notify-secret-abcdefgh",
  TAIGA_USERNAME: "bot",
  TAIGA_PASSWORD: "secret",
  TAIGA_PROJECT_SLUG: "my-lifts",
  TAIGA_WEBHOOK_SECRET: "taiga-webhook-secret",
});

const payload = {
  action: "change",
  type: "userstory",
  date: "2026-07-24T18:00:00.000Z",
  data: { id: 4321, ref: 12, subject: "Doors", status: { id: 3, name: "In progress" } },
  change: { diff: { status: { from: "Planned", to: "In progress" } } },
};

function sign(body: string, secret = config.TAIGA_WEBHOOK_SECRET): string {
  return createHmac("sha1", secret).update(body, "utf8").digest("hex");
}

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function buildApp(onDelivery: TaigaDelivery, routeConfig = config): Promise<FastifyInstance> {
  const app = await buildHttpServer(routeConfig);
  await app.register(taigaRoutes({ config: routeConfig, onDelivery }));
  apps.push(app);
  return app;
}

async function post(app: FastifyInstance, body: string, signature: string | undefined) {
  return app.inject({
    method: "POST",
    url: "/v1/taiga/webhook",
    headers: {
      "content-type": "application/json",
      ...(signature === undefined ? {} : { "x-taiga-webhook-signature": signature }),
    },
    payload: body,
  });
}

describe("Taiga webhook endpoint", () => {
  it("applies a correctly signed delivery", async () => {
    const onDelivery = vi.fn().mockResolvedValue(true);
    const app = await buildApp(onDelivery);
    const body = JSON.stringify(payload);

    const response = await post(app, body, sign(body));

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: "accepted" });
    expect(onDelivery).toHaveBeenCalledOnce();
    const [delivered, fingerprint] = onDelivery.mock.calls[0]!;
    expect(delivered).toMatchObject({ action: "change", type: "userstory", data: { id: 4321 } });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a wrong or missing signature before doing any work", async () => {
    const onDelivery = vi.fn();
    const app = await buildApp(onDelivery);
    const body = JSON.stringify(payload);

    expect((await post(app, body, sign(body, "wrong-secret"))).statusCode).toBe(401);
    expect((await post(app, body, undefined)).statusCode).toBe(401);
    expect(onDelivery).not.toHaveBeenCalled();
  });

  it("rejects a body that was tampered with after signing", async () => {
    const onDelivery = vi.fn();
    const app = await buildApp(onDelivery);
    const signature = sign(JSON.stringify(payload));
    const tampered = JSON.stringify({ ...payload, data: { ...payload.data, id: 9999 } });

    expect((await post(app, tampered, signature)).statusCode).toBe(401);
    expect(onDelivery).not.toHaveBeenCalled();
  });

  it("reports a replayed delivery as a duplicate", async () => {
    const onDelivery = vi.fn().mockResolvedValue(false);
    const app = await buildApp(onDelivery);
    const body = JSON.stringify(payload);

    const response = await post(app, body, sign(body));
    expect(response.json()).toMatchObject({ status: "duplicate" });
  });

  it("accepts Taiga's test delivery", async () => {
    const onDelivery = vi.fn().mockResolvedValue(true);
    const app = await buildApp(onDelivery);
    const body = JSON.stringify({ action: "test", type: "test", data: { id: 1 } });

    expect((await post(app, body, sign(body))).statusCode).toBe(202);
  });

  it("refuses malformed JSON and unknown payload shapes", async () => {
    const onDelivery = vi.fn();
    const app = await buildApp(onDelivery);

    expect((await post(app, "{not json", sign("{not json"))).statusCode).toBe(400);
    const bad = JSON.stringify({ action: "change", type: "userstory", data: {} });
    expect((await post(app, bad, sign(bad))).statusCode).toBe(400);
    expect(onDelivery).not.toHaveBeenCalled();
  });

  it("does not retry-storm when processing fails; the sweep repairs instead", async () => {
    const onDelivery = vi.fn().mockRejectedValue(new Error("Discord unavailable"));
    const app = await buildApp(onDelivery);
    const body = JSON.stringify(payload);

    const response = await post(app, body, sign(body));
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: "deferred" });
  });

  it("is disabled without a webhook secret", async () => {
    const disabled = loadConfig({
      DATABASE_URL: "postgresql://example.invalid/db",
      ROBLOX_INGESTION_SECRET: "12345678901234567890123456789012",
      ROBLOX_UNIVERSE_ID: "100",
      ROBLOX_GROUP_ID: "200",
      ROBLOX_ALLOWED_PLACE_IDS: "300",
    });
    const onDelivery = vi.fn();
    const app = await buildApp(onDelivery, disabled);
    const body = JSON.stringify(payload);

    expect((await post(app, body, sign(body))).statusCode).toBe(503);
    expect(onDelivery).not.toHaveBeenCalled();
  });

  it("keeps its raw-body parser to itself", async () => {
    // The webhook scope reads the body as text to check the signature. Other
    // features registered on the same server must still get parsed objects.
    const onDelivery = vi.fn().mockResolvedValue(true);
    const sendDirectMessage = vi.fn().mockResolvedValue({ ok: true });
    const app = await buildHttpServer(config);
    await app.register(taigaRoutes({ config, onDelivery }));
    await app.register(portalRoutes({ config, sendDirectMessage }));
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/internal/notify",
      headers: { authorization: `Bearer ${config.SITE_NOTIFY_SECRET}` },
      payload: { discordId: "123456789012345678", title: "Hello", message: "A message" },
    });

    expect(response.statusCode).toBe(200);
    expect(sendDirectMessage).toHaveBeenCalledWith(expect.objectContaining({ title: "Hello" }));
  });
});
