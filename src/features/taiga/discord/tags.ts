import { ChannelType, type AnyThreadChannel, type Client, type ForumChannel } from "discord.js";
import { sameName } from "../domain/mapping.js";

export type ForumState = {
  /** Exact tag set the post should carry. */
  tags: string[];
  archived: boolean;
};

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
 * Brings a post to the requested tags and archive state.
 *
 * Discord rejects edits to an archived thread, so an archived post is
 * temporarily reopened to re-tag it. Tags are always set as a whole set, never
 * added, so a post can never accumulate contradictory states.
 */
export async function applyForumState(
  thread: AnyThreadChannel,
  forum: ForumChannel,
  state: ForumState,
): Promise<{ missing: string[] }> {
  const { ids, missing } = resolveTagIds(forum, state.tags);
  const wasArchived = thread.archived ?? false;
  if (wasArchived) await thread.setArchived(false);

  const current = [...thread.appliedTags].sort();
  const desired = [...ids].sort();
  if (current.join() !== desired.join()) await thread.setAppliedTags(ids);

  if (state.archived) await thread.setArchived(true);
  return { missing };
}
