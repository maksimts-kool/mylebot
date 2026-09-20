import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { createLogger } from "../../src/core/logger.js";
import { CommandLogService } from "../../src/features/command-logs/service/command-log-service.js";
import type { CommandEvent } from "../../src/features/command-logs/domain/events.js";
import { commandBatchSchema } from "../../src/features/command-logs/domain/events.js";
import type { CommandLogSettings, CommandLogSettingsService } from "../../src/features/command-logs/service/settings.js";

const config = loadConfig({
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgresql://example.invalid/db",
  ROBLOX_INGESTION_SECRET: "12345678901234567890123456789012",
  ROBLOX_UNIVERSE_ID: "100",
  ROBLOX_GROUP_ID: "200",
  ROBLOX_ALLOWED_PLACE_IDS: "300",
});
const silent = createLogger({ service: "test", level: "silent" });

/** One valid event, parsed through the wire schema so the types are real. */
const BASE = commandBatchSchema.parse({
  events: [{
    eventId: "650daf2b-79b0-4d70-9c19-2a280fa3ac39",
    occurredAt: new Date("2026-09-20T18:42:00Z").toISOString(),
    universeId: "100",
    placeId: "300",
    jobId: "job-1",
    serverType: "PUBLIC",
    playerCount: 14,
    maxPlayers: 30,
    runner: { userId: "999", username: "MaksimTs", rankNumber: 9, rankName: "Supervisor", adminLevel: 201 },
    command: { text: ":kick Kiryoku", name: "Kick", alias: "kick", requiredLevel: 201 },
    targets: ["Kiryoku"],
  }],
}).events[0]!;

function event(overrides: Partial<CommandEvent> = {}): CommandEvent {
  return { ...BASE, ...overrides };
}

function build(settings: Partial<CommandLogSettings> = {}, create = vi.fn().mockResolvedValue({ id: "entry-1" })) {
  const db = {
    commandLogEntry: { create },
    commandBlock: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn(), deleteMany: vi.fn() },
  };
  const settingsService = {
    get: vi.fn().mockResolvedValue({ enabled: true, channelId: "channel-1", includeStudio: true, ...settings }),
  } as unknown as CommandLogSettingsService;
  return {
    db,
    create,
    service: new CommandLogService(db as never, config, settingsService, silent),
  };
}

describe("recording a command run", () => {
  it("refuses an event from another universe or place", async () => {
    const { service } = build();
    await expect(service.record(event({ universeId: 999n }))).rejects.toThrow(/universe/);
    await expect(service.record(event({ placeId: 999n }))).rejects.toThrow(/place/);
  });

  it("stores the run with the risk its required level implies", async () => {
    const { service, create } = build();
    const result = await service.record(event());
    expect(result.status).toBe("recorded");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ risk: "MEDIUM", commandName: "Kick", commandAlias: "kick", targets: ["Kiryoku"] }),
    }));
  });

  it("keeps nothing while logging is off or has no channel", async () => {
    const off = build({ enabled: false });
    expect(await off.service.record(event())).toEqual({ status: "skipped", reason: "disabled" });
    expect(off.create).not.toHaveBeenCalled();

    const homeless = build({ channelId: "" });
    expect(await homeless.service.record(event())).toEqual({ status: "skipped", reason: "no_channel" });
  });

  it("logs a Studio playtest only while Studio is switched on", async () => {
    const included = build();
    expect((await included.service.record(event({ serverType: "STUDIO" }))).status).toBe("recorded");

    const excluded = build({ includeStudio: false });
    expect(await excluded.service.record(event({ serverType: "STUDIO" })))
      .toEqual({ status: "skipped", reason: "studio_excluded" });
  });

  it("drops the lookup-only commands staff type constantly", async () => {
    const { service, create } = build();
    // Adonis indexes ":cmds" as "ViewCommands", so recognising either spelling
    // is what makes the filter work at all.
    const byIndex = await service.record(event({ command: { text: ":cmds", name: "ViewCommands", alias: "cmds", requiredLevel: 101 } }));
    expect(byIndex).toEqual({ status: "skipped", reason: "quiet_command" });
    const byAlias = await service.record(event({ command: { text: ":unview", name: "Unknown", alias: "unview", requiredLevel: 101 } }));
    expect(byAlias).toEqual({ status: "skipped", reason: "quiet_command" });
    expect(create).not.toHaveBeenCalled();
  });

  it("treats a re-sent batch as already handled rather than posting twice", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "7" });
    const { service } = build({}, vi.fn().mockRejectedValue(conflict));
    expect(await service.record(event())).toEqual({ status: "duplicate" });
  });
});

describe("command blocks", () => {
  it("extends an existing block instead of adding a second one", async () => {
    const { service, db } = build();
    const now = new Date("2026-09-20T18:42:00Z");
    const expiresAt = await service.block({
      robloxUserId: 999n,
      robloxUsername: "MaksimTs",
      byDiscordUserId: "discord-1",
      byDiscordName: "presser",
      entryId: "entry-1",
    }, now);
    expect(expiresAt.getTime() - now.getTime()).toBe(15 * 60 * 1000);
    expect(db.commandBlock.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { robloxUserId: 999n },
      update: expect.objectContaining({ expiresAt }),
    }));
  });

  it("ignores a block that has already run out", async () => {
    const { service, db } = build();
    db.commandBlock.findUnique.mockResolvedValue({ expiresAt: new Date("2026-09-20T18:00:00Z") });
    expect(await service.blockFor(999n, new Date("2026-09-20T18:42:00Z"))).toBeNull();
    db.commandBlock.findUnique.mockResolvedValue({ expiresAt: new Date("2026-09-20T19:00:00Z") });
    expect(await service.blockFor(999n, new Date("2026-09-20T18:42:00Z"))).toEqual(new Date("2026-09-20T19:00:00Z"));
  });
});
