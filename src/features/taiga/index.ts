import { taigaConfigured } from "../../core/config.js";
import type { Feature, FeatureContext } from "../../core/feature.js";
import { taigaRoutes } from "./api/routes.js";
import { TaigaClient } from "./client.js";
import { TaigaCommandHandler, taigaCommandData } from "./discord/commands.js";
import { registerForumListener } from "./discord/forum-listener.js";
import { TaigaNotifier } from "./discord/notifications.js";
import { TaigaSettingsService } from "./service/settings.js";
import { TaigaSyncService } from "./service/taiga-sync.js";

/**
 * Two-way sync between the Discord bug-report/suggestion forums and the Taiga
 * kanban board, plus a notifications channel that narrates both.
 *
 * Without Taiga credentials the feature registers nothing at all: no command,
 * no route, no listener — which also keeps the privileged message intents off.
 */
export function createTaigaFeature(ctx: FeatureContext): Feature | null {
  if (!taigaConfigured(ctx.config)) {
    ctx.log.info({ feature: "taiga" }, "Taiga integration is not configured; skipping");
    return null;
  }

  const taiga = new TaigaClient(ctx.config);
  const settings = new TaigaSettingsService(ctx.db);
  const notifier = new TaigaNotifier(ctx.client, settings, taiga);
  const sync = new TaigaSyncService(ctx.db, ctx.client, taiga, settings, notifier, ctx.log);

  registerForumListener(ctx.client, sync, ctx.log);
  new TaigaCommandHandler(ctx.client, ctx.db, ctx.config, settings, sync).register();

  return {
    name: "taiga",
    commands: taigaCommandData,
    routes: taigaRoutes({
      config: ctx.config,
      onDelivery: (payload, fingerprint) => sync.handleWebhook(payload, fingerprint),
    }),
    onReady: async () => {
      // Catch up on anything that moved while the bot was down.
      await sync.reconcile();
    },
    jobs: [
      {
        name: "Taiga reconcile",
        intervalMs: ctx.config.TAIGA_RECONCILE_SECONDS * 1000,
        run: () => sync.reconcile(),
      },
      {
        name: "Taiga webhook cleanup",
        intervalMs: 24 * 60 * 60 * 1000,
        run: async () => {
          const count = await sync.cleanupDeliveries(ctx.config.PROCESSED_EVENT_RETENTION_DAYS);
          if (count) ctx.log.info({ job: "Taiga webhook cleanup", removedDeliveryCount: count }, "Expired Taiga webhook records removed");
        },
      },
    ],
  };
}
