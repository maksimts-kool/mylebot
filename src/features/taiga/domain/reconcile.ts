import { sameName } from "./mapping.js";

/** What the bot believes about a card. */
export type TrackedCard = {
  taigaStoryId: number;
  statusName: string;
  declinedAt: Date | null;
};

/** What Taiga currently says. */
export type RemoteStory = {
  id: number;
  statusName: string | null;
};

export type ReconcileAction =
  | { type: "moved"; taigaStoryId: number; from: string; to: string }
  | { type: "missing"; taigaStoryId: number; lastStatus: string };

/**
 * Diffs tracked cards against the board so a webhook lost to a restart or a
 * failed delivery still gets applied.
 *
 * `remoteComplete` is the safety catch: a card only counts as deleted when the
 * whole board was read successfully. A partial read must never be able to
 * decline every post at once.
 */
export function reconcileCards(
  tracked: TrackedCard[],
  remote: RemoteStory[],
  { remoteComplete }: { remoteComplete: boolean },
): ReconcileAction[] {
  const byId = new Map(remote.map((story) => [story.id, story]));
  const actions: ReconcileAction[] = [];
  for (const card of tracked) {
    if (card.declinedAt) continue;
    const story = byId.get(card.taigaStoryId);
    if (!story) {
      if (remoteComplete) actions.push({ type: "missing", taigaStoryId: card.taigaStoryId, lastStatus: card.statusName });
      continue;
    }
    if (!story.statusName) continue;
    if (!sameName(story.statusName, card.statusName)) {
      actions.push({ type: "moved", taigaStoryId: card.taigaStoryId, from: card.statusName, to: story.statusName });
    }
  }
  return actions;
}
