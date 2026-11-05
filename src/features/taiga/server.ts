import { taigaConfigured } from "../../core/config.js";
import type { ServerContext, ServerFeature } from "../../core/feature.js";
import { taigaRoutes } from "./api/routes.js";
import { TaigaClient } from "./client.js";
import { TAIGA_PORT, type TaigaBotPort } from "./link.js";
import { TaigaSettingsService } from "./service/settings.js";
import { taigaServerPort } from "./service/taiga-port.js";
import { TaigaSyncService } from "./service/taiga-sync.js";

/**
 * Two-way sync between the Discord bug-report/suggestion forums and the Taiga
 * kanban board, the half that owns it: the Taiga client, the webhook, the card
 * rows and the reconcile sweep.
 *
 * Without Taiga credentials the feature composes nothing at all — and tells
 * the bot half so, which keeps the privileged message intents off.
 */
export function createTaigaServer(ctx: ServerContext): ServerFeature | null {
  if (!taigaConfigured(ctx.config)) {
    ctx.log.info({ category: "taiga" }, "Not configured; skipping");
    return null;
  }

  const taiga = new TaigaClient(ctx.config);
  const settings = new TaigaSettingsService(ctx.db);
  const sync = new TaigaSyncService(ctx.db, taiga, settings, ctx.bot.port<TaigaBotPort>(TAIGA_PORT), ctx.log);

  return {
    name: "taiga",
    // The webhook is answered here even while Discord is away: a delivery the
    // bot cannot show is left for the reconcile sweep to finish.
    routes: taigaRoutes({
      config: ctx.config,
      onDelivery: (payload, fingerprint) => sync.handleWebhook(payload, fingerprint),
    }),
    ports: { [TAIGA_PORT]: taigaServerPort(ctx.config, settings, sync) },
    // Catch up on anything that moved while Discord could not be told.
    onBotReady: async () => { await sync.reconcile(); },
    jobs: [
      {
        name: "Taiga reconcile",
        intervalMs: ctx.config.TAIGA_RECONCILE_SECONDS * 1000,
        run: async () => { await sync.reconcile(); },
      },
      {
        name: "Taiga webhook cleanup",
        intervalMs: 24 * 60 * 60 * 1000,
        run: async () => {
          const count = await sync.cleanupDeliveries(ctx.config.PROCESSED_EVENT_RETENTION_DAYS);
          return count ? `removed ${count} expired delivery records` : undefined;
        },
      },
    ],
  };
}
