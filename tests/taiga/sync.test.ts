import { describe, expect, it, vi } from "vitest";
import { LinkUnavailableError } from "../../src/core/link.js";
import { createLogger } from "../../src/core/logger.js";
import type { TaigaBotPort } from "../../src/features/taiga/link.js";
import { TaigaSyncService } from "../../src/features/taiga/service/taiga-sync.js";

const silent = createLogger({ service: "test", level: "silent" });

const card = {
  id: "card-1",
  taigaStoryId: 77,
  taigaRef: 12,
  guildId: "guild",
  channelId: "bug-forum",
  threadId: "thread-1",
  kind: "BUG",
  title: "The lift is stuck",
  statusName: "Suggested",
  authorDiscordId: "42",
  authorName: "wolfik",
  declinedAt: null,
  deleting: false,
};

function syncWith(discord: Partial<TaigaBotPort>) {
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...card, ...data }));
  const db = {
    taigaWebhookDelivery: { create: vi.fn().mockResolvedValue({}) },
    taigaCard: { findUnique: vi.fn().mockResolvedValue(card), update },
  };
  const settings = {
    get: vi.fn().mockResolvedValue({ enabled: true, notificationChannelId: "notify", bugForumChannelId: "bug-forum", suggestionForumChannelId: "s" }),
  };
  const taiga = { storyUrl: (ref: number) => `https://tree.taiga.io/us/${ref}`, epicUrl: () => "" };
  const port: TaigaBotPort = {
    readForumPost: vi.fn(),
    applyPostState: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    ...discord,
  };
  const sync = new TaigaSyncService(db as never, taiga as never, settings as never, port, silent);
  return { sync, db, update, port };
}

const moved = {
  action: "change" as const,
  type: "userstory",
  data: { id: 77, status: { name: "Planned" } },
};

describe("a board change Discord cannot be told about", () => {
  it("retags the post and announces the move when the bot is up", async () => {
    const { sync, update, port } = syncWith({});

    expect(await sync.handleWebhook(moved, "fingerprint-1")).toBe(true);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ where: { id: "card-1" }, data: { statusName: "Planned" } });
    expect(port.applyPostState).toHaveBeenCalledWith(
      { channelId: "bug-forum", threadId: "thread-1", taigaRef: 12 },
      expect.objectContaining({ archived: false }),
    );
    expect(port.notify).toHaveBeenCalledWith("notify", expect.objectContaining({ type: "cardMoved", from: "Suggested", to: "Planned" }));
  });

  it("keeps the old column, so the reconcile sweep moves the post once the bot is back", async () => {
    const { sync, update, port } = syncWith({
      applyPostState: vi.fn().mockRejectedValue(new LinkUnavailableError("Discord is not connected")),
    });

    await expect(sync.handleWebhook(moved, "fingerprint-2")).rejects.toThrow(LinkUnavailableError);

    expect(update).toHaveBeenLastCalledWith({ where: { id: "card-1" }, data: { statusName: "Suggested" } });
    expect(port.notify).not.toHaveBeenCalled();
  });

  it("does not mark a deleted card declined until its post says so", async () => {
    const { sync, update } = syncWith({
      applyPostState: vi.fn().mockRejectedValue(new LinkUnavailableError("Discord is not connected")),
    });

    await expect(sync.handleWebhook({ ...moved, action: "delete" }, "fingerprint-3")).rejects.toThrow(LinkUnavailableError);

    expect(update).toHaveBeenLastCalledWith({ where: { id: "card-1" }, data: { declinedAt: null } });
  });

  it("does not undo a card for Discord's own failures, which the bot already logged", async () => {
    const { sync, update } = syncWith({ applyPostState: vi.fn().mockRejectedValue(new Error("Missing Permissions")) });

    await sync.handleWebhook(moved, "fingerprint-4");

    expect(update).toHaveBeenCalledTimes(1);
  });
});
