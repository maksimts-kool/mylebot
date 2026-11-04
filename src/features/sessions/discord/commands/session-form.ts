import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, LabelBuilder, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, type ModalSubmitInteraction,
} from "discord.js";
import { dayChoices, type SessionFormInput } from "../../domain/manual-entry.js";

/** The button on a rejected form's error that opens it again, filled in. */
export const SESSION_RETRY_PREFIX = "session:retry:";

/** How long a rejected form's answers wait to be fixed. */
const DRAFT_LIFETIME_MS = 15 * 60_000;

const FIELDS = { date: "date", start: "start", end: "end", inactive: "inactive", note: "note" } as const;

export type SessionFormOptions = {
  customId: string;
  title: string;
  reasonLabel: string;
  timezone: string;
  now: Date;
  /** What to fill the form with: a session being edited, or answers being fixed. */
  values?: Partial<SessionFormInput>;
};

function textField(id: string, placeholder: string, maxLength: number, value: string | undefined, required = true): TextInputBuilder {
  const input = new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short)
    .setPlaceholder(placeholder).setMaxLength(maxLength).setRequired(required);
  if (value) input.setValue(value);
  return input;
}

/**
 * The add/edit session form. The day is chosen from a menu, the times are
 * short boxes, and active time is never asked for — it is what the rest leaves.
 */
export function sessionFormModal(options: SessionFormOptions): ModalBuilder {
  const values = options.values ?? {};
  const days = dayChoices(options.now, options.timezone, values.date);
  const selected = values.date ?? days[0]!.value;
  return new ModalBuilder().setCustomId(options.customId).setTitle(options.title).addLabelComponents(
    new LabelBuilder().setLabel("Date").setDescription("The day the session started")
      .setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId(FIELDS.date).setRequired(true)
        .addOptions(days.map((day) => ({ ...day, default: day.value === selected })))),
    new LabelBuilder().setLabel("Start time").setDescription("24-hour clock, e.g. 14:30")
      .setTextInputComponent(textField(FIELDS.start, "14:30", 8, values.start)),
    new LabelBuilder().setLabel("End time").setDescription("Earlier than the start means it ran past midnight")
      .setTextInputComponent(textField(FIELDS.end, "16:45", 8, values.end)),
    new LabelBuilder().setLabel("Inactive time").setDescription("Leave empty if they were active the whole time")
      .setTextInputComponent(textField(FIELDS.inactive, "e.g. 10m or 1h 5m", 20, values.inactive, false)),
    new LabelBuilder().setLabel(options.reasonLabel)
      .setTextInputComponent(textField(FIELDS.note, "Why this change is needed", 300, values.note)),
  );
}

export function readSessionForm(interaction: ModalSubmitInteraction): SessionFormInput {
  return {
    date: interaction.fields.getStringSelectValues(FIELDS.date)[0] ?? "",
    start: interaction.fields.getTextInputValue(FIELDS.start),
    end: interaction.fields.getTextInputValue(FIELDS.end),
    inactive: interaction.fields.getTextInputValue(FIELDS.inactive),
    note: interaction.fields.getTextInputValue(FIELDS.note),
  };
}

/**
 * Answers to a form the bot rejected, kept briefly so a mistake costs one
 * correction instead of retyping everything. Keyed by who typed them and which
 * form, so nobody reopens somebody else's answers.
 */
export class SessionFormDrafts {
  private readonly drafts = new Map<string, { input: SessionFormInput; expiresAt: number }>();

  constructor(private readonly lifetimeMs = DRAFT_LIFETIME_MS) {}

  save(userId: string, formId: string, input: SessionFormInput, now = Date.now()): void {
    for (const [key, draft] of this.drafts) if (draft.expiresAt <= now) this.drafts.delete(key);
    this.drafts.set(`${userId}|${formId}`, { input, expiresAt: now + this.lifetimeMs });
  }

  get(userId: string, formId: string, now = Date.now()): SessionFormInput | null {
    const draft = this.drafts.get(`${userId}|${formId}`);
    return draft && draft.expiresAt > now ? draft.input : null;
  }

  forget(userId: string, formId: string): void {
    this.drafts.delete(`${userId}|${formId}`);
  }
}

/** The error reply for a rejected form, with a button that reopens it filled in. */
export function retryRow(formId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${SESSION_RETRY_PREFIX}${formId}`).setLabel("Fix and resubmit").setEmoji("✏️").setStyle(ButtonStyle.Primary),
  );
}
