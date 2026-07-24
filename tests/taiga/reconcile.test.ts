import { describe, expect, it } from "vitest";
import { reconcileCards } from "../../src/features/taiga/domain/reconcile.js";

const tracked = [
  { taigaStoryId: 1, statusName: "Suggested", declinedAt: null },
  { taigaStoryId: 2, statusName: "Planned", declinedAt: null },
  { taigaStoryId: 3, statusName: "In game", declinedAt: null },
];

describe("reconciling tracked cards against the board", () => {
  it("reports a card that moved while the bot was not listening", () => {
    const actions = reconcileCards(tracked, [
      { id: 1, statusName: "Planned" },
      { id: 2, statusName: "Planned" },
      { id: 3, statusName: "In game" },
    ], { remoteComplete: true });
    expect(actions).toEqual([{ type: "moved", taigaStoryId: 1, from: "Suggested", to: "Planned" }]);
  });

  it("ignores a difference that is only casing or padding", () => {
    const actions = reconcileCards(tracked, [
      { id: 1, statusName: " suggested " },
      { id: 2, statusName: "PLANNED" },
      { id: 3, statusName: "In game" },
    ], { remoteComplete: true });
    expect(actions).toEqual([]);
  });

  it("reports a card that disappeared from the board", () => {
    const actions = reconcileCards(tracked, [
      { id: 1, statusName: "Suggested" },
      { id: 3, statusName: "In game" },
    ], { remoteComplete: true });
    expect(actions).toEqual([{ type: "missing", taigaStoryId: 2, lastStatus: "Planned" }]);
  });

  it("never reports deletions when the board could not be read in full", () => {
    const actions = reconcileCards(tracked, [], { remoteComplete: false });
    expect(actions).toEqual([]);
  });

  it("still applies moves it can see from an incomplete read", () => {
    const actions = reconcileCards(tracked, [{ id: 2, statusName: "Done" }], { remoteComplete: false });
    expect(actions).toEqual([{ type: "moved", taigaStoryId: 2, from: "Planned", to: "Done" }]);
  });

  it("leaves already declined cards alone", () => {
    const actions = reconcileCards(
      [{ taigaStoryId: 9, statusName: "Suggested", declinedAt: new Date() }],
      [],
      { remoteComplete: true },
    );
    expect(actions).toEqual([]);
  });

  it("skips a card whose remote status is unreadable rather than guessing", () => {
    const actions = reconcileCards(
      [{ taigaStoryId: 1, statusName: "Suggested", declinedAt: null }],
      [{ id: 1, statusName: null }],
      { remoteComplete: true },
    );
    expect(actions).toEqual([]);
  });
});
