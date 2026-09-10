import { describe, expect, it, vi } from "vitest";
import {
  ANNOUNCEMENT_RETENTION_MILLISECONDS, announcementRetentionCutoff, announcementRetentionElapsed,
  announcementSettledAt,
} from "../../src/features/sessions/domain/policy.js";
import { ANNOUNCEMENT_CLEANUP_BATCH, SessionService } from "../../src/features/sessions/service/session-service.js";

const now = new Date("2026-01-01T12:00:00Z");
const ago = (milliseconds: number) => new Date(now.getTime() - milliseconds);

describe("staff announcement retention", () => {
  it("treats a live shift as never settled", () => {
    expect(announcementSettledAt({ endedAt: null, deletedAt: null })).toBeNull();
    expect(announcementRetentionElapsed({ endedAt: null, deletedAt: null }, now)).toBe(false);
  });

  it("measures a finished shift from when it ended, not from when it was removed", () => {
    const endedAt = ago(ANNOUNCEMENT_RETENTION_MILLISECONDS * 2);
    expect(announcementSettledAt({ endedAt, deletedAt: now })).toBe(endedAt);
    // Removing an old shift must not put its announcement back in staff chat.
    expect(announcementRetentionElapsed({ endedAt, deletedAt: now }, now)).toBe(true);
  });

  it("measures a shift removed while it was still running from the removal", () => {
    expect(announcementRetentionElapsed({ endedAt: null, deletedAt: ago(60_000) }, now)).toBe(false);
    expect(announcementRetentionElapsed({ endedAt: null, deletedAt: ago(ANNOUNCEMENT_RETENTION_MILLISECONDS) }, now)).toBe(true);
  });

  it("keeps the announcement for the whole retention window and no longer", () => {
    expect(announcementRetentionElapsed({ endedAt: ago(ANNOUNCEMENT_RETENTION_MILLISECONDS - 1), deletedAt: null }, now)).toBe(false);
    expect(announcementRetentionElapsed({ endedAt: ago(ANNOUNCEMENT_RETENTION_MILLISECONDS), deletedAt: null }, now)).toBe(true);
    expect(announcementRetentionCutoff(now)).toEqual(ago(ANNOUNCEMENT_RETENTION_MILLISECONDS));
  });
});

describe("expired announcement cleanup", () => {
  function serviceWith(rows: Array<{ id: string; channelId: string; messageId: string }>) {
    const db = {
      sessionAnnouncement: {
        findMany: vi.fn().mockResolvedValue(rows),
        deleteMany: vi.fn().mockResolvedValue({ count: rows.length }),
      },
    };
    return { db, service: new SessionService(db as never, {} as never) };
  }

  it("selects one bounded batch of announcements whose shift settled before the cutoff", async () => {
    const { db, service } = serviceWith([]);

    await service.expiredAnnouncements(now);

    const cutoff = announcementRetentionCutoff(now);
    expect(db.sessionAnnouncement.findMany).toHaveBeenCalledWith({
      take: ANNOUNCEMENT_CLEANUP_BATCH,
      where: {
        session: {
          OR: [
            { endedAt: { lte: cutoff } },
            { endedAt: null, deletedAt: { lte: cutoff } },
          ],
        },
      },
      select: { id: true, channelId: true, messageId: true },
    });
  });

  it("forgets the rows whose messages have been taken down", async () => {
    const { db, service } = serviceWith([{ id: "a1", channelId: "staff", messageId: "m1" }]);

    expect(await service.forgetAnnouncements(["a1"])).toBe(1);
    expect(db.sessionAnnouncement.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["a1"] } } });
  });

  it("does not touch the database when nothing expired", async () => {
    const { db, service } = serviceWith([]);

    expect(await service.forgetAnnouncements([])).toBe(0);
    expect(db.sessionAnnouncement.deleteMany).not.toHaveBeenCalled();
  });
});
