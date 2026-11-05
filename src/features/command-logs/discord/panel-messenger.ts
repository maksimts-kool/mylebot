import {
  ChannelType, DiscordAPIError, ThreadAutoArchiveDuration,
  type AnyThreadChannel, type Client, type TextChannel,
} from "discord.js";
import type { CommandLogEntry } from "@prisma/client";
import { LinkUnavailableError } from "../../../core/link.js";
import type { Logger } from "../../../core/logger.js";
import type { CommandLogsBotPort, CommandRunView, PanelLocation, PanelView } from "../link.js";
import { commandLogEmbed } from "./command-log-embed.js";
import { serverPanelComponents, serverPanelEmbed, threadName } from "./server-panel.js";

/** Discord API error codes this feature has to tell apart. */
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;
const MISSING_PERMISSIONS = 50013;

function gone(error: unknown): boolean {
  return error instanceof DiscordAPIError && (error.code === UNKNOWN_CHANNEL || error.code === UNKNOWN_MESSAGE);
}

function draw(panel: PanelView) {
  return {
    embeds: [serverPanelEmbed(panel.server, panel.staff, panel.blockedUntil, panel.shifts)],
    components: serverPanelComponents(panel.server, panel.staff, panel.blockedUntil),
  };
}

/**
 * The command log's hands in Discord: it draws the panels and posts the runs
 * the server half decided on, and says where they ended up.
 */
export function commandLogsBotPort(client: Client, parentLog: Logger): CommandLogsBotPort {
  const log = parentLog.child({ category: "command" });

  function requireReady(): void {
    if (!client.isReady()) throw new LinkUnavailableError("Discord is not connected");
  }

  /** A thread to post in, reopened when it archived itself; null when it is gone. */
  async function thread(threadId: string): Promise<AnyThreadChannel | null> {
    try {
      const found = await client.channels.fetch(threadId) as AnyThreadChannel;
      if (found.archived) await found.setArchived(false);
      return found;
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === UNKNOWN_CHANNEL) return null;
      throw error;
    }
  }

  return {
    async openPanel(channelId, panel) {
      requireReady();
      const channel = await client.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
        log.error({ channelId }, "The command log channel is not a text channel");
        return null;
      }
      const message = await (channel as TextChannel).send(draw(panel));
      const started = await message.startThread({
        name: threadName(panel.server),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        reason: `Adonis command log for job ${panel.server.jobId}`,
      });
      log.info({ jobId: panel.server.jobId }, "Opened a panel and log thread for a server");
      return { channelId: channel.id, threadId: started.id, messageId: message.id };
    },

    async editPanel(channelId, messageId, panel) {
      requireReady();
      try {
        const channel = await client.channels.fetch(channelId) as TextChannel;
        await channel.messages.edit(messageId, draw(panel));
      } catch (error) {
        if (gone(error)) return "gone";
        throw error;
      }
      // Rosters repaint the panel every minute, so only a closing is news.
      log[panel.server.closedAt ? "info" : "debug"](
        { jobId: panel.server.jobId, staff: panel.staff.length },
        panel.server.closedAt ? "Closed the server panel" : "Updated the server panel",
      );
      return "edited";
    },

    /** Deleting the panel message leaves its thread behind, so both go, thread first. */
    async removePanel(location: PanelLocation) {
      requireReady();
      try {
        const found = await client.channels.fetch(location.threadId) as AnyThreadChannel | null;
        await found?.delete();
      } catch (error) {
        // Deleting a thread takes Manage Threads. Without it the panel still
        // goes, and the thread is left to archive itself.
        if (error instanceof DiscordAPIError && error.code === MISSING_PERMISSIONS) {
          log.warn({ jobId: location.jobId }, "Removing an empty log thread needs Manage Threads; leaving it to archive");
        } else if (!gone(error)) {
          throw error;
        }
      }
      if (location.panelMessageId) {
        try {
          const channel = await client.channels.fetch(location.channelId) as TextChannel | null;
          await channel?.messages.delete(location.panelMessageId);
        } catch (error) {
          if (!gone(error)) throw error;
        }
      }
    },

    async postRun(threadId, entry: CommandLogEntry, view: CommandRunView) {
      requireReady();
      const target = await thread(threadId);
      if (!target) return null;
      const message = await target.send({ embeds: [commandLogEmbed(entry, view)] });
      log.info(
        { actor: entry.robloxUsername, risk: entry.risk, targets: entry.targets, jobId: entry.jobId },
        `Posted :${entry.commandAlias} to the server's log thread`,
      );
      return { messageId: message.id };
    },

    async notice(threadId, content) {
      requireReady();
      const target = await thread(threadId);
      if (target) await target.send({ content, allowedMentions: { parse: [] } });
    },
  };
}
