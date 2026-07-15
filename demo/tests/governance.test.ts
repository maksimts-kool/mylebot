import { describe, expect, it } from "vitest";
import { RANKS, assignableRanks, canManageRank, canReviewApplication, canSetRank } from "../domain/ranks.js";

describe("rank governance", () => {
  it("SM manages everyone below SM but not SM", () => {
    expect(canManageRank(RANKS.SM, RANKS.LS)).toBe(true);
    expect(canManageRank(RANKS.SM, RANKS.ES)).toBe(true);
    expect(canManageRank(RANKS.SM, RANKS.SM)).toBe(false);
  });

  it("SS manages only the Surfer track below SS", () => {
    expect(canManageRank(RANKS.SS, RANKS.LS)).toBe(true);
    expect(canManageRank(RANKS.SS, RANKS.LE)).toBe(false); // wrong track
    expect(canManageRank(RANKS.SS, RANKS.SS)).toBe(false); // peer
  });

  it("ES manages only the Engineer track below ES", () => {
    expect(canManageRank(RANKS.ES, RANKS.LE)).toBe(true);
    expect(canManageRank(RANKS.ES, RANKS.LS)).toBe(false);
  });

  it("promoting LS to a peer supervisor requires SM, not SS", () => {
    expect(canSetRank(RANKS.SS, RANKS.LS, RANKS.SS)).toBe(false);
    expect(canSetRank(RANKS.SM, RANKS.LS, RANKS.SS)).toBe(true);
  });

  it("reviewing follows the track: SS reviews LS, ES reviews LE, SM reviews both", () => {
    expect(canReviewApplication(RANKS.SS, "LS")).toBe(true);
    expect(canReviewApplication(RANKS.SS, "LE")).toBe(false);
    expect(canReviewApplication(RANKS.ES, "LE")).toBe(true);
    expect(canReviewApplication(RANKS.SM, "LS")).toBe(true);
    expect(canReviewApplication(RANKS.SM, "LE")).toBe(true);
  });

  it("assignableRanks for SM over an LS includes LE/SS/ES but never SM or LS itself", () => {
    const codes = assignableRanks(RANKS.SM, RANKS.LS).map((r) => r.code);
    expect(codes).toContain("SS");
    expect(codes).toContain("ES");
    expect(codes).not.toContain("SM");
    expect(codes).not.toContain("LS");
  });
});
