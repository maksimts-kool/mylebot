import { z } from "zod";
import { appLogger } from "../../../core/logger.js";

const thumbnailResponse = z.object({
  data: z.array(z.object({ state: z.string(), imageUrl: z.string().url().nullable().optional() })),
});

/** Roblox serves thumbnails from its own CDN; nothing else is fetched. */
const THUMBNAIL_HOST = /(^|\.)rbxcdn\.com$/;

/**
 * A member's Roblox headshot as PNG bytes, or null when Roblox has none to give
 * or does not answer in time. The card draws initials instead, so a missing
 * avatar never fails a profile.
 */
export async function robloxHeadshot(robloxUserId: bigint, fetcher: typeof fetch = fetch): Promise<Buffer | null> {
  const log = appLogger().child({ category: "session" });
  try {
    const url = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxUserId}&size=420x420&format=Png&isCircular=false`;
    const response = await fetcher(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      log.warn({ status: response.status, robloxUserId: robloxUserId.toString() }, "Roblox turned down an avatar lookup");
      return null;
    }
    const parsed = thumbnailResponse.safeParse(await response.json());
    const entry = parsed.success ? parsed.data.data[0] : undefined;
    if (!entry || entry.state !== "Completed" || !entry.imageUrl) return null;
    const imageUrl = new URL(entry.imageUrl);
    if (imageUrl.protocol !== "https:" || !THUMBNAIL_HOST.test(imageUrl.hostname)) return null;
    const image = await fetcher(imageUrl, { signal: AbortSignal.timeout(5_000) });
    if (!image.ok) return null;
    return Buffer.from(await image.arrayBuffer());
  } catch (error) {
    log.warn({ err: error, robloxUserId: robloxUserId.toString() }, "Roblox avatar lookup failed");
    return null;
  }
}
