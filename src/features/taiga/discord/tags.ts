import { ChannelType, type AnyThreadChannel, type Client, type ForumChannel } from "discord.js";
import { KNOWN_FORUM_TAGS, sameName } from "../domain/mapping.js";

/** Discord refuses more than five tags on a post. */
export const MAX_APPLIED_TAGS = 5;

export type ForumState = {
  /** Exact set of board-state tags the post should carry. */
  tags: string[];
  archived: boolean;
};

/**
 * The bot owns the four board-state tags and nothing else. Any other tag — a
 * forum's own `Bug`/`Suggestion` category, or anything staff add by hand —
 * belongs to the post and must survive a column change.
 *
 * State tags come first so they are the ones that keep their place if the post
 * is already at Discord's five-tag ceiling.
 */
export function nextAppliedTags(currentIds: string[], stateIds: string[], managedIds: string[]): string[] {
  const managed = new Set(managedIds);
  const preserved = currentIds.filter((id) => !managed.has(id));
  return [...new Set([...stateIds, ...preserved])].slice(0, MAX_APPLIED_TAGS);
}

export async function fetchForumChannel(client: Client, channelId: string): Promise<ForumChannel | null> {
  if (!channelId) return null;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  return channel?.type === ChannelType.GuildForum ? channel : null;
}

/** Maps tag names onto the forum's tag IDs, reporting any the forum lacks. */
export function resolveTagIds(forum: ForumChannel, names: string[]): { ids: string[]; missing: string[] } {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const tag = forum.availableTags.find((available) => sameName(available.name, name));
    if (tag) ids.push(tag.id);
    else missing.push(name);
  }
  return { ids, missing };
}

/**
 * Brings a post to the requested board state and archive state.
 *
 * The board-state tags are replaced as a set, never added to, so a post can
 * never carry two contradictory states at once. Discord also rejects edits to
 * an archived thread, so an archived post is briefly reopened to re-tag it.
 */
export async function applyForumState(
  thread: AnyThreadChannel,
  forum: ForumChannel,
  state: ForumState,
): Promise<{ missing: string[] }> {
  const { ids, missing } = resolveTagIds(forum, state.tags);
  const managed = resolveTagIds(forum, KNOWN_FORUM_TAGS).ids;
  const desiredIds = nextAppliedTags([...thread.appliedTags], ids, managed);

  const wasArchived = thread.archived ?? false;
  if (wasArchived) await thread.setArchived(false);

  const current = [...thread.appliedTags].sort();
  if (current.join() !== [...desiredIds].sort().join()) await thread.setAppliedTags(desiredIds);

  if (state.archived) await thread.setArchived(true);
  return { missing };
}
