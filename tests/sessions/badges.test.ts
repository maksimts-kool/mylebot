import { describe, expect, it, vi } from "vitest";
import {
  BADGES, heldBadges, hoursBadgesEarned, monthlyAwards, monthRange, monthsToAward, nextHoursBadge, veteranDue,
} from "../../src/features/sessions/domain/badges.js";
import { profileStats } from "../../src/features/sessions/domain/profile.js";
import { CARD_HEIGHT, CARD_WIDTH, renderBadgeIcon, renderProfileCard } from "../../src/features/sessions/discord/profile-card.js";
import { awardSentence, badgeGuide, profileCardModel, progressBar } from "../../src/features/sessions/discord/profile-view.js";
import { robloxHeadshot } from "../../src/features/sessions/discord/roblox-avatar.js";
import { BadgeService } from "../../src/features/sessions/service/badge-service.js";

const HOUR = 3_600_000;
const TZ = "Europe/Tallinn";
const firstShiftAt = new Date("2026-07-11T10:00:00Z");

describe("badge rules", () => {
  it("awards hours badges at their thresholds, inclusively", () => {
    expect(hoursBadgesEarned(10 * HOUR - 1)).toEqual([]);
    expect(hoursBadgesEarned(10 * HOUR)).toEqual(["hours-10"]);
    expect(hoursBadgesEarned(150 * HOUR)).toEqual(["hours-10", "hours-50", "hours-150"]);
    expect(nextHoursBadge(72 * HOUR)?.key).toBe("hours-150");
    expect(nextHoursBadge(1000 * HOUR)).toBeNull();
  });

  it("gives first place both leaderboard badges and second and third only Top 3", () => {
    expect(monthlyAwards(["a", "b", "c", "d"])).toEqual([
      { member: "a", badge: "monthly-first" },
      { member: "a", badge: "monthly-top3" },
      { member: "b", badge: "monthly-top3" },
      { member: "c", badge: "monthly-top3" },
    ]);
    expect(monthlyAwards([])).toEqual([]);
  });

  it("ranks every month back to the first shift, once each has ended and settled", () => {
    // The first shift was part-way through July: July still counts, on what the tracker saw.
    expect(monthsToAward(firstShiftAt, null, new Date("2026-11-05T12:00:00Z"), TZ)).toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
    // October ends at 22:00 UTC (midnight in Tallinn, back on winter time) and settles an hour later.
    expect(monthsToAward(firstShiftAt, "2026-09", new Date("2026-10-31T22:30:00Z"), TZ)).toEqual([]);
    expect(monthsToAward(firstShiftAt, "2026-09", new Date("2026-10-31T22:30:00Z"), TZ, 30 * 60_000)).toEqual(["2026-10"]);
    expect(monthsToAward(firstShiftAt, "2026-08", new Date("2026-11-05T12:00:00Z"), TZ)).toEqual(["2026-09", "2026-10"]);
  });

  it("ranks nothing before anybody has been tracked", () => {
    expect(monthsToAward(null, null, new Date("2026-11-05T12:00:00Z"), TZ)).toEqual([]);
  });

  it("never ranks a month that session retention has started deleting", () => {
    // Fourteen months after the first shift, retention has removed everything
    // before 2026-09-05; September is only partly held, so October comes first.
    const now = new Date("2027-09-05T12:00:00Z");
    expect(monthsToAward(firstShiftAt, null, now, TZ)[0]).toBe("2026-10");
    // A cutoff exactly at a month's start keeps that month whole.
    const atMonthStart = monthRange("2026-10", TZ).start;
    expect(monthsToAward(firstShiftAt, null, new Date(atMonthStart.getTime() + 365 * 86_400_000), TZ)[0]).toBe("2026-10");
  });

  it("makes Veteran due one year after first tracked", () => {
    const first = new Date("2025-11-05T12:00:00Z");
    expect(veteranDue(first, new Date("2026-11-05T11:59:59Z"))).toBe(false);
    expect(veteranDue(first, new Date("2026-11-05T12:00:00Z"))).toBe(true);
  });

  it("folds repeated monthly awards into one badge with a count", () => {
    const held = heldBadges([
      { badge: "monthly-top3", period: "2026-12", awardedAt: new Date("2027-01-01") },
      { badge: "monthly-top3", period: "2027-02", awardedAt: new Date("2027-03-01") },
      { badge: "hours-10", period: "", awardedAt: new Date("2026-11-20") },
    ]);
    expect(held.get("monthly-top3")).toMatchObject({ count: 2, lastPeriod: "2027-02" });
    expect(held.get("hours-10")?.count).toBe(1);
  });
});

describe("profile stats", () => {
  const now = new Date("2027-01-20T12:00:00Z");
  const shift = (start: string, hours: number, deletedAt: Date | null = null) => {
    const startedAt = new Date(start);
    const endedAt = new Date(startedAt.getTime() + hours * HOUR);
    return { startedAt, endedAt, deletedAt, segments: [{ state: "ACTIVE" as const, startedAt, endedAt }] };
  };

  it("leaves out removed shifts and says nothing for someone with none", () => {
    expect(profileStats([], now, TZ)).toBeNull();
    expect(profileStats([shift("2027-01-10T10:00:00Z", 2, now)], now, TZ)).toBeNull();
  });

  it("totals the past year and this month", () => {
    const stats = profileStats([
      shift("2027-01-19T10:00:00Z", 2),
      shift("2026-12-01T10:00:00Z", 3),
      shift("2027-01-15T10:00:00Z", 1, now),
    ], now, TZ)!;
    expect(stats.yearMs).toBe(5 * HOUR);
    expect(stats.monthMs).toBe(2 * HOUR);
    expect(stats.shifts).toBe(2);
    expect(stats.onShift).toBe(false);
  });
});

describe("badge guide", () => {
  const now = new Date("2027-01-20T12:00:00Z");

  it("shows only the rules to someone never tracked, never a row of zeros", () => {
    const guide = badgeGuide({ standing: null, now, timezone: TZ });
    expect(guide.description).toContain("first tracked shift");
    const text = guide.fields.map((field) => field.value).join("\n");
    expect(text).toContain("Spend 10 hours of active time on shift.");
    expect(text).not.toContain("0h /");
    expect(text).not.toContain("✅");
    expect(guide.fields.map((field) => field.name)).toEqual(["⏱️ Hours on shift", "🏆 Leaderboard", "✨ Special"]);
  });

  it("shows earned badges, a bar toward the next hours badge, and Veteran's countdown", () => {
    const guide = badgeGuide({
      standing: {
        activeMs: 72 * HOUR,
        firstTrackedAt: new Date("2026-02-01T12:00:00Z"),
        awards: [
          { badge: "hours-10", period: "", awardedAt: new Date("2026-11-12T12:00:00Z") },
          { badge: "hours-50", period: "", awardedAt: new Date("2027-01-03T12:00:00Z") },
          { badge: "monthly-top3", period: "2026-12", awardedAt: new Date("2027-01-01T00:00:00Z") },
        ],
      },
      now,
      timezone: TZ,
    });
    const [hours, leaderboard, special] = guide.fields.map((field) => field.value);
    expect(guide.description).toContain("**3 of 8**");
    expect(hours).toContain("✅ Earned Nov 12, 2026");
    expect(hours).toContain(`${progressBar(72 / 150)} 72h / 150h`);
    expect(hours).toContain("\n72h / 500h");
    expect(leaderboard).toContain("✅ Earned ×1 · last December 2026");
    expect(leaderboard).toContain("🔒 Not earned yet");
    expect(special).toContain("🔒 12 days to go");
  });

  it("words the DM for each kind of badge", () => {
    const byKey = (key: string) => BADGES.find((badge) => badge.key === key)!;
    expect(awardSentence(byKey("hours-50"), "", 51 * HOUR, TZ)).toBe("You've spent 50 hours on shift. Next up: 150 hours.");
    expect(awardSentence(byKey("hours-1000"), "", 1000 * HOUR, TZ)).toContain("every hours badge");
    expect(awardSentence(byKey("monthly-first"), "2026-12", 0, TZ)).toBe("You finished December 2026 at #1 on the staff leaderboard.");
  });
});

describe("profile card", () => {
  const now = new Date("2027-01-20T12:00:00Z");
  const standing = { activeMs: 72 * HOUR, firstTrackedAt: firstShiftAt, awards: [] };

  it("draws dashes rather than zeros when the member has no recent shifts", () => {
    const model = profileCardModel({
      robloxUsername: "Kuro", rank: null, avatar: null, stats: null, standing, now, timezone: TZ,
    });
    expect(model.tiles.map((tile) => tile.value)).toEqual(["—", "—", "—", "—", "—"]);
    expect(model.badgeSummary).toBe("0 of 8");
    expect(model.sinceLabel).toBe("Since first shift · Jul 2026");
    expect(model.next).toMatchObject({ label: "Next: 150 hours", progressLabel: "72h / 150h" });
  });

  it("names the rank without its number and fills its pill with the member's role colour", () => {
    const card = (rank: { name: string; number: number } | null) => profileCardModel({
      robloxUsername: "Kuro", rank, avatar: null, stats: null, standing, now, timezone: TZ,
    });
    const engineer = card({ name: "[LE] Lift Engineer", number: 7 });
    expect(engineer.rank).toBe("[LE] Lift Engineer");
    expect(engineer.rankColor).toBe("#d4843d");
    expect(card({ name: "[OW] Owner", number: 255 }).rankColor).toBe("#369876");
    expect(card({ name: "[ES] Engineers Supervisor", number: 9 }).rankColor).toBe("#be00ff");
    expect(card({ name: "[TS] Trainee Surfer", number: 5 }).rankColor).toBe("#4c59d0");
    // A rank with no Discord role, and somebody with no shift yet, get no role colour.
    expect(card({ name: "Member", number: 1 }).rankColor).toBeNull();
    expect(card(null)).toMatchObject({ rank: null, rankColor: null });
    expect(engineer).not.toHaveProperty("subtitle");
  });

  it("renders a PNG of the card's size, and a badge icon", async () => {
    const model = profileCardModel({
      robloxUsername: "Kuro", rank: { name: "[LE] Lift Engineer", number: 7 }, avatar: Buffer.from("not an image"),
      stats: null, standing, now, timezone: TZ,
    });
    const png = await renderProfileCard(model);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(CARD_WIDTH);
    expect(png.readUInt32BE(20)).toBe(CARD_HEIGHT);
    const icon = await renderBadgeIcon(BADGES[0]!, 128);
    expect(icon.readUInt32BE(16)).toBe(128);
  });
});

describe("Roblox avatar lookup", () => {
  const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

  it("refuses an image URL that is not Roblox's CDN", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ data: [{ state: "Completed", imageUrl: "https://evil.example/a.png" }] }));
    await expect(robloxHeadshot(1n, fetcher as never)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns the image bytes from Roblox's CDN", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ data: [{ state: "Completed", imageUrl: "https://tr.rbxcdn.com/abc/420/420/AvatarHeadshot/Png" }] }))
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response);
    await expect(robloxHeadshot(1n, fetcher as never)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("gives up quietly when Roblox has no headshot", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ data: [{ state: "Pending", imageUrl: null }] }));
    await expect(robloxHeadshot(1n, fetcher as never)).resolves.toBeNull();
  });
});

describe("badge awarding", () => {
  function fakeDb(options: { sessions: unknown[]; credits: Array<{ sessionId: string; activeMilliseconds: bigint }>; creditTotals?: unknown[] }) {
    return {
      badgeSettings: {
        upsert: vi.fn().mockResolvedValue({ monthsAwardedThrough: null }),
        update: vi.fn(),
      },
      identity: { findMany: vi.fn().mockResolvedValue([]) },
      badgeProgress: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn(), update: vi.fn() },
      session: { findMany: vi.fn().mockResolvedValue(options.sessions), findFirst: vi.fn().mockResolvedValue(null) },
      badgeCredit: {
        findMany: vi.fn().mockResolvedValue(options.credits),
        createMany: vi.fn(),
        update: vi.fn(),
        deleteMany: vi.fn(),
        groupBy: vi.fn().mockResolvedValue(options.creditTotals ?? []),
      },
      badgeAward: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
  }
  const session = (id: string, activeMs: number, deletedAt: Date | null = null) => ({
    id, deletedAt, activeMilliseconds: BigInt(activeMs), inactiveMilliseconds: 0n, identity: { robloxUserId: 7n },
  });

  it("credits new sessions, follows edits, and drops removed ones, back to the very first shift", async () => {
    const db = fakeDb({
      sessions: [session("new", 2 * HOUR), session("edited", 3 * HOUR), session("removed", HOUR, new Date()), session("tiny", 30_000)],
      credits: [
        { sessionId: "edited", activeMilliseconds: BigInt(HOUR) },
        { sessionId: "removed", activeMilliseconds: BigInt(HOUR) },
      ],
    });
    await new BadgeService(db as never, { REPORT_TIMEZONE: TZ } as never).award(new Date("2026-11-20T00:00:00Z"));

    // No date floor: shifts from before badges existed earn hours too.
    expect(db.session.findMany.mock.calls[0]![0].where).toEqual({ state: "ENDED" });
    expect(db.badgeCredit.createMany).toHaveBeenCalledWith({
      data: [{ sessionId: "new", robloxUserId: 7n, activeMilliseconds: BigInt(2 * HOUR) }], skipDuplicates: true,
    });
    expect(db.badgeCredit.update).toHaveBeenCalledWith({ where: { sessionId: "edited" }, data: { activeMilliseconds: BigInt(3 * HOUR) } });
    expect(db.badgeCredit.deleteMany).toHaveBeenCalledWith({ where: { sessionId: { in: ["removed"] } } });
  });

  it("ranks the months before badges existed, starting from the first shift", async () => {
    const db = fakeDb({ sessions: [], credits: [] });
    db.session.findFirst.mockResolvedValue({ startedAt: firstShiftAt });
    await new BadgeService(db as never, { REPORT_TIMEZONE: TZ } as never).award(new Date("2026-11-05T12:00:00Z"));

    expect(db.badgeSettings.update.mock.calls.map(([call]) => call.data.monthsAwardedThrough))
      .toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
  });

  it("grants every hours badge a credited total reaches, without duplicates", async () => {
    const db = fakeDb({ sessions: [], credits: [], creditTotals: [{ robloxUserId: 7n, _sum: { activeMilliseconds: BigInt(55 * HOUR) } }] });
    const awarded = await new BadgeService(db as never, { REPORT_TIMEZONE: TZ } as never).award(new Date("2026-11-20T00:00:00Z"));

    expect(db.badgeAward.createMany).toHaveBeenCalledWith({
      data: [
        { robloxUserId: 7n, badge: "hours-10", period: "" },
        { robloxUserId: 7n, badge: "hours-50", period: "" },
      ],
      skipDuplicates: true,
    });
    expect(awarded).toBe(2);
  });
});
