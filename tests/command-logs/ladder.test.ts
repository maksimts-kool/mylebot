import { describe, expect, it } from "vitest";
import { isQuietCommand } from "../../src/features/command-logs/domain/policy.js";
import { riskForLevel, riskLabel } from "../../src/features/command-logs/domain/risk.js";
import {
  MINIMUM_RESTORE_LEVEL, STAFF_TIERS, TOP_TIER_LEVEL, levelForGroupRank, minimumPresserLevel, tierName,
} from "../../src/features/command-logs/domain/staff-ladder.js";

describe("staff ladder", () => {
  it("grants a tier only to the exact group ranks Adonis lists", () => {
    expect(levelForGroupRank(7)).toBe(101);
    expect(levelForGroupRank(9)).toBe(201);
    expect(levelForGroupRank(10)).toBe(250);
    expect(levelForGroupRank(254)).toBe(250);
    // The group owner, who has no Adonis entry because the game gives them
    // everything through IsPlaceOwner.
    expect(levelForGroupRank(255)).toBe(250);
    // Ranks between the listed ones hold no tier, exactly as in Adonis.
    expect(levelForGroupRank(8)).toBe(0);
    expect(levelForGroupRank(0)).toBe(0);
  });

  it("names the tier a level belongs to, including the ones above Managers", () => {
    expect(tierName(0)).toBe("Players");
    expect(tierName(101)).toBe("Engineers");
    expect(tierName(150)).toBe("Engineers");
    expect(tierName(201)).toBe("Supervisors");
    expect(tierName(250)).toBe("Managers");
    expect(tierName(301)).toBe("Directors");
    expect(tierName(900)).toBe("Creators");
  });

  it("requires one tier above the run, and stops at the top staffed tier", () => {
    expect(minimumPresserLevel(101)).toBe(201);
    expect(minimumPresserLevel(201)).toBe(250);
    expect(minimumPresserLevel(250)).toBe(TOP_TIER_LEVEL);
    // Nothing above Managers is staffed, so a higher run does not become
    // undisableable.
    expect(minimumPresserLevel(900)).toBe(TOP_TIER_LEVEL);
  });

  it("takes a Manager to give access back, whatever tier the run was", () => {
    expect(MINIMUM_RESTORE_LEVEL).toBe(TOP_TIER_LEVEL);
    expect(tierName(MINIMUM_RESTORE_LEVEL)).toBe("Managers");
    // A Supervisor may take access away from an Engineers run, but undoing it
    // overrules them, so it is out of their hands.
    expect(minimumPresserLevel(101)).toBeLessThan(MINIMUM_RESTORE_LEVEL);
  });

  it("never lets somebody disable a run of their own tier below the top", () => {
    for (const { level } of STAFF_TIERS) {
      if (level === TOP_TIER_LEVEL) continue;
      expect(minimumPresserLevel(level)).toBeGreaterThan(level);
    }
  });
});

describe("command risk", () => {
  it("reads risk from the level a command demands", () => {
    expect(riskForLevel(0)).toBe("LOW");
    expect(riskForLevel(101)).toBe("LOW");
    expect(riskForLevel(102)).toBe("MEDIUM");
    expect(riskForLevel(201)).toBe("MEDIUM");
    expect(riskForLevel(250)).toBe("HIGH");
    expect(riskForLevel(301)).toBe("CRITICAL");
    expect(riskForLevel(900)).toBe("CRITICAL");
  });

  it("labels every risk level", () => {
    expect(riskLabel(riskForLevel(101))).toContain("Low");
    expect(riskLabel(riskForLevel(900))).toContain("Critical");
  });
});

describe("what is worth logging", () => {
  it("recognises a lookup command by its Adonis index or by the typed alias", () => {
    expect(isQuietCommand("ViewCommands", "cmds")).toBe(true);
    expect(isQuietCommand("PlayerList", "players")).toBe(true);
    // Either half alone is enough, because a place may report only one.
    expect(isQuietCommand("unknown", "banlist")).toBe(true);
    expect(isQuietCommand("Freecam", "unknown")).toBe(true);
  });

  it("keeps anything that touches the game or another player", () => {
    expect(isQuietCommand("Kick", "kick")).toBe(false);
    expect(isQuietCommand("Shutdown", "shutdown")).toBe(false);
    expect(isQuietCommand("Invisible", "invisible")).toBe(false);
  });
});
