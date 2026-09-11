import { taigaConfigured } from "../../core/config.js";
import type { Feature, FeatureContext } from "../../core/feature.js";
import { taigaRoutes } from "./api/routes.js";
import { TaigaClient } from "./client.js";
import { taigaConfigSection } from "./discord/config-section.js";
import { registerForumListener } from "./discord/forum-listener.js";
import { TaigaNotifier } from "./discord/notifications.js";
import { TaigaSettingsService } from "./service/settings.js";
import { TaigaSyncService } from "./service/taiga-sync.js";

/**
 * Two-way sync between the Discord bug-report/suggestion forums and the Taiga
 * kanban board, plus a notifications channel that narrates both.
 *
 * Without Taiga credentials the feature registers nothing at all: no settings
 * page, no route, no listener — which also keeps the privileged message intents
 * off.
 */
export function createTaigaFeature(ctx: FeatureContext): Feature | null {
  if (!taigaConfigured(ctx.config)) {
    ctx.log.info({ category: "taiga" }, "Not configured; skipping");
    return null;
  }

  const taiga = new TaigaClient(ctx.config);
  const settings = new TaigaSettingsService(ctx.db);
  const notifier = new TaigaNotifier(ctx.client, settings, taiga);
  const sync = new TaigaSyncService(ctx.db, ctx.client, taiga, settings, notifier, ctx.log);

  registerForumListener(ctx.client, sync, ctx.log);

  return {
    name: "taiga",
    configSections: [taigaConfigSection(ctx.config, settings, sync)],
    // A delivery moves cards, retags forum posts and announces the change, so
    // it can only be answered where the gateway is.
    gatewayRoutes: {
      plugin: taigaRoutes({
        config: ctx.config,
        onDelivery: (payload, fingerprint) => sync.handleWebhook(payload, fingerprint),
      }),
      patterns: ["/v1/taiga/*"],
    },
    onReady: async () => {
      // Catch up on anything that moved while the bot was down.
      await sync.reconcile();
    },
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
