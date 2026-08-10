import { describe, expect, it, vi, type Mock } from "vitest";
import {
  finalWarningBatches,
  VerificationService,
  type UnverifiedMember,
  type VerificationGateway,
} from "../../src/features/verification/service/verification-service.js";

const guildId = "1068891577054933083";
const now = new Date("2026-08-11T12:00:00Z");

function member(discordUserId: string): UnverifiedMember {
  return { discordUserId, displayName: `Member ${discordUserId}` };
}

type MockVerificationGateway = {
  [Key in keyof VerificationGateway]: Mock<VerificationGateway[Key]>;
};

function gateway(members: UnverifiedMember[]): MockVerificationGateway {
  return {
    listUnverifiedMembers: vi.fn<VerificationGateway["listUnverifiedMembers"]>().mockResolvedValue(members),
    postGeneralReminder: vi.fn<VerificationGateway["postGeneralReminder"]>().mockResolvedValue(undefined),
    postFinalWarning: vi.fn<VerificationGateway["postFinalWarning"]>().mockResolvedValue(undefined),
    postRemovedMembers: vi.fn<VerificationGateway["postRemovedMembers"]>().mockResolvedValue(undefined),
    kick: vi.fn<VerificationGateway["kick"]>().mockResolvedValue(undefined),
  };
}

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function schedule(lastReminderAt: Date | null = null) {
  return {
    findUnique: vi.fn().mockResolvedValue(lastReminderAt === null ? null : { guildId, lastReminderAt }),
    upsert: vi.fn().mockResolvedValue({ guildId, lastReminderAt: now }),
  };
}

describe("verification service", () => {
  it("seeds new members, warns month-old members, and removes only previously warned members", async () => {
    const fresh = member("100");
    const warningDue = member("200");
    const kickDue = member("300");
    const discord = gateway([fresh, warningDue, kickDue]);
    const verificationMember = {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([
        { guildId, discordUserId: warningDue.discordUserId, firstSeenAt: new Date("2026-07-15T12:00:00Z"), warnedAt: null },
        { guildId, discordUserId: kickDue.discordUserId, firstSeenAt: new Date("2026-01-01T12:00:00Z"), warnedAt: new Date("2026-08-08T12:00:00Z") },
      ]),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn().mockResolvedValue({}),
    };
    const log = logger();
    const verificationSchedule = schedule();
    const service = new VerificationService({ verificationMember, verificationSchedule } as never, guildId, discord, log as never);

    await service.run(now);

    expect(verificationMember.createMany).toHaveBeenCalledWith({
      data: [{ guildId, discordUserId: fresh.discordUserId, firstSeenAt: now }],
      skipDuplicates: true,
    });
    expect(discord.postGeneralReminder).toHaveBeenCalledOnce();
    expect(verificationSchedule.upsert).toHaveBeenCalledWith({
      where: { guildId },
      create: { guildId, lastReminderAt: now },
      update: { lastReminderAt: now },
    });
    expect(discord.kick).toHaveBeenCalledWith(kickDue);
    expect(discord.postRemovedMembers).toHaveBeenCalledWith([kickDue]);
    expect(discord.postFinalWarning).toHaveBeenCalledWith([warningDue]);
    expect(verificationMember.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { warnedAt: now },
    }));
  });

  it("keeps the record and reports a failed kick for a later retry", async () => {
    const kickDue = member("300");
    const discord = gateway([kickDue]);
    discord.kick.mockRejectedValue(new Error("Missing permissions"));
    const verificationMember = {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([
        { guildId, discordUserId: kickDue.discordUserId, firstSeenAt: new Date("2026-01-01T12:00:00Z"), warnedAt: new Date("2026-08-08T12:00:00Z") },
      ]),
      createMany: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    };
    const log = logger();
    const service = new VerificationService({ verificationMember, verificationSchedule: schedule() } as never, guildId, discord, log as never);

    await expect(service.run(now)).rejects.toThrow(/operational failures/);
    expect(verificationMember.delete).not.toHaveBeenCalled();
    expect(discord.postRemovedMembers).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("drops tracking as soon as nobody has the Unverified role", async () => {
    const discord = gateway([]);
    const verificationMember = {
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      findMany: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    };
    const service = new VerificationService({ verificationMember, verificationSchedule: schedule() } as never, guildId, discord, logger() as never);

    await service.run(now);

    expect(verificationMember.deleteMany).toHaveBeenCalledWith({ where: { guildId } });
    expect(verificationMember.findMany).not.toHaveBeenCalled();
    expect(discord.kick).not.toHaveBeenCalled();
  });

  it("does nothing when the persisted three-day reminder is not due", async () => {
    const discord = gateway([member("100")]);
    const verificationMember = {
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    };
    const verificationSchedule = schedule(new Date("2026-08-10T12:00:00Z"));
    const service = new VerificationService({ verificationMember, verificationSchedule } as never, guildId, discord, logger() as never);

    await expect(service.run(now)).resolves.toBe(false);
    expect(discord.listUnverifiedMembers).not.toHaveBeenCalled();
    expect(verificationMember.deleteMany).not.toHaveBeenCalled();
    expect(verificationSchedule.upsert).not.toHaveBeenCalled();
  });

  it("splits large final-warning mention lists below Discord's limit", () => {
    const members = Array.from({ length: 200 }, (_, index) => member(String(100_000_000_000_000_000n + BigInt(index))));
    const batches = finalWarningBatches(members);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(members);
    for (const batch of batches) {
      const content = `${batch.map(({ discordUserId }) => `<@${discordUserId}>`).join(" ")}\n\nYou have 3 days left to verify. Please do it now or you will be removed from the server.`;
      expect(content.length).toBeLessThanOrEqual(2_000);
    }
  });
});
