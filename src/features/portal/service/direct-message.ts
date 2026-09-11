import { DiscordAPIError, EmbedBuilder, type Client } from "discord.js";
import { errorType } from "../../../core/errors.js";
import { appLogger } from "../../../core/logger.js";
import type { SendDirectMessage } from "../api/routes.js";

/**
 * Sends a Discord DM on behalf of the store-owners site. Discord code 50007
 * means the recipient has DMs closed or shares no guild with the bot.
 */
export function createDirectMessageSender(client: Client): SendDirectMessage {
  return async (input) => {
    if (!client.isReady()) return { ok: false, status: 503, error: "discord_not_ready" };
    try {
      const user = await client.users.fetch(input.discordId);
      const embed = new EmbedBuilder().setTitle(input.title).setDescription(input.message);
      if (input.color !== undefined) embed.setColor(input.color);
      if (input.url) embed.setURL(input.url);
      await user.send({ embeds: [embed] });
      return { ok: true };
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === 50007) return { ok: false, status: 422, error: "dms_closed" };
      appLogger().warn({ category: "portal", err: error, errorType: errorType(error) }, "Could not deliver the site notification DM");
      return { ok: false, status: 502, error: "dm_send_failed" };
    }
  };
}
