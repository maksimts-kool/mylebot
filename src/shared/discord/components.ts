import { ActionRowBuilder, TextInputBuilder, TextInputStyle } from "discord.js";

export const PUBLIC_COMPONENT_LIFETIME_MS = 15 * 60_000;

type PublicComponentRegistration = {
  userId: string;
  onExpire: () => Promise<void>;
  timeout: NodeJS.Timeout;
};

/**
 * Keeps the controls on a publicly visible reply usable only by the person who
 * ran the command, and disables them once they go idle.
 */
export class PublicComponentTracker {
  private readonly registrations = new Map<string, PublicComponentRegistration>();

  constructor(private readonly lifetimeMs = PUBLIC_COMPONENT_LIFETIME_MS) {}

  track(messageId: string, userId: string, onExpire: () => Promise<void>): void {
    const previous = this.registrations.get(messageId);
    if (previous) clearTimeout(previous.timeout);

    const registration: PublicComponentRegistration = {
      userId,
      onExpire,
      timeout: setTimeout(() => {
        if (this.registrations.get(messageId) !== registration) return;
        this.registrations.delete(messageId);
        void onExpire().catch((error: unknown) => console.error("Failed to disable expired public controls", { error, messageId }));
      }, this.lifetimeMs),
    };
    registration.timeout.unref();
    this.registrations.set(messageId, registration);
  }

  access(messageId: string, userId: string): "allowed" | "not-owner" | "expired" {
    const registration = this.registrations.get(messageId);
    if (!registration) return "expired";
    if (registration.userId !== userId) return "not-owner";
    this.track(messageId, userId, registration.onExpire);
    return "allowed";
  }
}

/** A single-line modal text field wrapped in the action row Discord requires. */
export function textInputRow(id: string, label: string, value = "", required = true): ActionRowBuilder<TextInputBuilder> {
  const field = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required);
  if (value) field.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(field);
}
