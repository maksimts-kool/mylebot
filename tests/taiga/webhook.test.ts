import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  changedColumn, currentColumn, taigaWebhookSchema, verifyTaigaSignature, webhookFingerprint,
} from "../../src/features/taiga/domain/webhook.js";

const SECRET = "taiga-webhook-secret";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha1", secret).update(body, "utf8").digest("hex");
}

const changePayload = {
  action: "change",
  type: "userstory",
  by: { id: 7, username: "maksimts", full_name: "Maksim" },
  date: "2026-07-24T18:00:00.000Z",
  data: {
    id: 4321,
    ref: 12,
    subject: "Elevator doors close too fast",
    status: { id: 3, name: "In progress", is_closed: false },
    project: { id: 1, name: "My Lifts" },
  },
  change: { diff: { status: { from: "Planned", to: "In progress" } } },
};

describe("webhook signature", () => {
  it("accepts a body signed with the shared secret", () => {
    const body = JSON.stringify(changePayload);
    expect(verifyTaigaSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a signature from a different secret", () => {
    const body = JSON.stringify(changePayload);
    expect(verifyTaigaSignature(body, sign(body, "someone-else"), SECRET)).toBe(false);
  });

  it("rejects a body that was altered after signing", () => {
    const body = JSON.stringify(changePayload);
    const signature = sign(body);
    expect(verifyTaigaSignature(`${body} `, signature, SECRET)).toBe(false);
  });

  it("rejects a missing signature or an unconfigured secret", () => {
    const body = JSON.stringify(changePayload);
    expect(verifyTaigaSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyTaigaSignature(body, sign(body), "")).toBe(false);
  });

  it("ignores signature casing and padding", () => {
    const body = JSON.stringify(changePayload);
    expect(verifyTaigaSignature(body, ` ${sign(body).toUpperCase()} `, SECRET)).toBe(true);
  });
});

describe("delivery fingerprint", () => {
  it("is stable for a byte-identical retry", () => {
    const body = JSON.stringify(changePayload);
    expect(webhookFingerprint(body)).toBe(webhookFingerprint(body));
  });

  it("differs for two genuine events", () => {
    const later = JSON.stringify({ ...changePayload, date: "2026-07-24T18:05:00.000Z" });
    expect(webhookFingerprint(JSON.stringify(changePayload))).not.toBe(webhookFingerprint(later));
  });
});

describe("payload parsing", () => {
  it("parses a column change and reads the current column, not the diff", () => {
    const parsed = taigaWebhookSchema.parse(changePayload);
    expect(parsed.action).toBe("change");
    expect(currentColumn(parsed)).toBe("In progress");
    expect(changedColumn(parsed)).toBe(true);
  });

  it("reports no column change when something else was edited", () => {
    const parsed = taigaWebhookSchema.parse({
      ...changePayload,
      change: { diff: { subject: { from: "a", to: "b" } } },
    });
    expect(changedColumn(parsed)).toBe(false);
  });

  it("parses create, delete and test deliveries", () => {
    expect(taigaWebhookSchema.parse({ ...changePayload, action: "create", change: undefined }).action).toBe("create");
    expect(taigaWebhookSchema.parse({ ...changePayload, action: "delete", change: undefined }).action).toBe("delete");
    expect(taigaWebhookSchema.parse({ action: "test", type: "test", data: { id: 1 } }).action).toBe("test");
  });

  it("parses an epic payload and keeps its closed flag", () => {
    const parsed = taigaWebhookSchema.parse({
      action: "change",
      type: "epic",
      data: { id: 9, ref: 2, subject: "Version 1.4", status: { id: 5, name: "Closed", is_closed: true } },
    });
    expect(parsed.type).toBe("epic");
    expect(parsed.data.status?.is_closed).toBe(true);
  });

  it("keeps unknown fields instead of failing on them", () => {
    const parsed = taigaWebhookSchema.parse({ ...changePayload, future_field: "value" });
    expect(parsed).toMatchObject({ future_field: "value" });
  });

  it("rejects a payload with no object id or an unknown action", () => {
    expect(taigaWebhookSchema.safeParse({ action: "change", type: "userstory", data: {} }).success).toBe(false);
    expect(taigaWebhookSchema.safeParse({ action: "exploded", type: "userstory", data: { id: 1 } }).success).toBe(false);
  });

  it("has no column when the object carries no status", () => {
    const parsed = taigaWebhookSchema.parse({ action: "delete", type: "userstory", data: { id: 4321 } });
    expect(currentColumn(parsed)).toBeNull();
  });
});
