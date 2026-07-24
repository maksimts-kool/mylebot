/** Building the Taiga card content from a Discord forum post. Pure. */

export const MAX_SUBJECT_LENGTH = 200;
export const MAX_BODY_LENGTH = 6_000;
export const EMPTY_BODY_PLACEHOLDER = "_The post had no text content._";

export type StoryAuthor = {
  discordId: string;
  /** The author's Discord display name; Taiga cannot render a Discord mention. */
  name: string;
};

export type StoryDescriptionInput = {
  body: string;
  guildId: string;
  threadId: string;
  author: StoryAuthor;
};

function truncate(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

export function buildStorySubject(threadName: string): string {
  const subject = truncate(threadName, MAX_SUBJECT_LENGTH);
  return subject || "Untitled post";
}

export function discordThreadUrl(guildId: string, threadId: string): string {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

/**
 * The card body: the post's first message, a link back to the thread, and the
 * author. The Discord ID is kept next to the name so the author stays
 * identifiable after a rename.
 */
export function buildStoryDescription({ body, guildId, threadId, author }: StoryDescriptionInput): string {
  const content = truncate(body, MAX_BODY_LENGTH) || EMPTY_BODY_PLACEHOLDER;
  return [
    content,
    "",
    discordThreadUrl(guildId, threadId),
    "",
    `Created by: @${author.name} (Discord ID ${author.discordId})`,
  ].join("\n");
}
