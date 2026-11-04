import { ComponentType } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  buildManualSession, dayChoices, formDuration, parseClockTime, parseFlexibleDuration,
} from "../../src/features/sessions/domain/manual-entry.js";
import { SessionFormDrafts, sessionFormModal } from "../../src/features/sessions/discord/commands/session-form.js";

const TZ = "Europe/Tallinn";
const NOW = new Date("2026-11-04T12:00:00Z"); // 14:00 in Tallinn

describe("the session form's date menu", () => {
  it("offers today and the 24 days before it, newest first", () => {
    const days = dayChoices(NOW, TZ);
    expect(days).toHaveLength(25);
    expect(days[0]).toEqual({ value: "2026-11-04", label: "Today · Wed, Nov 4" });
    expect(days[1]).toEqual({ value: "2026-11-03", label: "Yesterday · Tue, Nov 3" });
    expect(days[24]!.value).toBe("2026-10-11");
  });

  it("keeps an older session's own day so editing it never moves it", () => {
    const days = dayChoices(NOW, TZ, "2026-03-02");
    expect(days).toHaveLength(25);
    expect(days[24]).toEqual({ value: "2026-03-02", label: "Mon, Mar 2" });
  });

  it("names the year of a day from last year", () => {
    expect(dayChoices(new Date("2027-01-02T12:00:00Z"), TZ)[5]!.label).toBe("Mon, Dec 28, 2026");
  });
});

describe("typed times", () => {
  it("accepts the usual ways of writing a time of day", () => {
    for (const value of ["14:30", "14.30", "1430", " 14:30 ", "2:30pm", "2:30 PM", "14h30"]) {
      expect(parseClockTime(value, "Start time")).toBe(14 * 60 + 30);
    }
    expect(parseClockTime("9", "Start time")).toBe(9 * 60);
    expect(parseClockTime("930", "Start time")).toBe(9 * 60 + 30);
    expect(parseClockTime("12am", "Start time")).toBe(0);
    expect(parseClockTime("12pm", "Start time")).toBe(12 * 60);
  });

  it("names the field and shows an example when a time makes no sense", () => {
    for (const value of ["25:00", "14:75", "13pm", "noon", "11/07/2026 14:30"]) {
      expect(() => parseClockTime(value, "End time")).toThrow(/End time .* isn't a time\. Write it like 14:30/);
    }
  });

  it("accepts the usual ways of writing a length of time, and empty as none", () => {
    expect(parseFlexibleDuration("", "Inactive time")).toBe(0);
    expect(parseFlexibleDuration("45", "Inactive time")).toBe(45 * 60_000);
    expect(parseFlexibleDuration("1:05", "Inactive time")).toBe(65 * 60_000);
    expect(parseFlexibleDuration("1h 5m", "Inactive time")).toBe(65 * 60_000);
    expect(parseFlexibleDuration("1h5m", "Inactive time")).toBe(65 * 60_000);
    expect(parseFlexibleDuration("2 hours 10 min", "Inactive time")).toBe(130 * 60_000);
    expect(parseFlexibleDuration("90s", "Inactive time")).toBe(90_000);
    expect(() => parseFlexibleDuration("a while", "Inactive time")).toThrow(/Inactive time "a while" isn't a length of time/);
    expect(() => parseFlexibleDuration("1h, 5x", "Inactive time")).toThrow(/isn't a length of time/);
  });

  it("writes durations back the way the form accepts them", () => {
    expect(formDuration(0)).toBe("");
    expect(formDuration(65 * 60_000)).toBe("1h 5m");
    expect(formDuration(2 * 3_600_000)).toBe("2h");
    expect(parseFlexibleDuration(formDuration(65 * 60_000), "Inactive time")).toBe(65 * 60_000);
  });
});

describe("building a session from the form", () => {
  const form = { date: "2026-11-03", start: "14:30", end: "16:45", inactive: "", note: "Missed by the tracker" };

  it("works out active time, so the parts always add up", () => {
    const session = buildManualSession({ ...form, inactive: "10m" }, TZ, NOW);
    expect(session.start.toISOString()).toBe("2026-11-03T12:30:00.000Z");
    expect(session.end.toISOString()).toBe("2026-11-03T14:45:00.000Z");
    expect(session.inactiveMs).toBe(10 * 60_000);
    expect(session.activeMs).toBe(125 * 60_000);
  });

  it("reads an end time before the start as the next day", () => {
    const session = buildManualSession({ ...form, start: "23:30", end: "1:00" }, TZ, NOW);
    expect(session.end.toISOString()).toBe("2026-11-03T23:00:00.000Z");
    expect(session.activeMs).toBe(90 * 60_000);
  });

  it("leaves an old row's reconnecting time where it was", () => {
    const session = buildManualSession({ ...form, inactive: "15m" }, TZ, NOW, 5 * 60_000);
    expect(session.activeMs + session.inactiveMs + 5 * 60_000).toBe(session.end.getTime() - session.start.getTime());
    expect(session.activeMs).toBe(115 * 60_000);
  });

  it("explains what is wrong instead of a generic error", () => {
    expect(() => buildManualSession({ ...form, inactive: "3h" }, TZ, NOW)).toThrow("Inactive time (3h) is longer than the session itself (2h 15m).");
    expect(() => buildManualSession({ ...form, end: "14:30" }, TZ, NOW)).toThrow("Start and end are the same time.");
    expect(() => buildManualSession({ ...form, date: "2026-11-04", end: "18:00" }, TZ, NOW)).toThrow(/ends in the future/);
    expect(() => buildManualSession({ ...form, date: "" }, TZ, NOW)).toThrow(/Pick the day/);
  });
});

describe("the session form", () => {
  it("asks for a day from a menu, two times, inactive time, and a reason — never active time", () => {
    const modal = sessionFormModal({ customId: "editended:abc", title: "Edit", reasonLabel: "Reason for this edit", timezone: TZ, now: NOW }).toJSON();
    const labels = modal.components.map((component) => component as { label: string; component: { type: number; custom_id: string; required?: boolean; options?: Array<{ value: string; default?: boolean }> } });
    expect(labels.map((label) => label.label)).toEqual(["Date", "Start time", "End time", "Inactive time", "Reason for this edit"]);
    expect(labels[0]!.component.type).toBe(ComponentType.StringSelect);
    expect(labels[0]!.component.options!.find((option) => option.default)?.value).toBe("2026-11-04");
    expect(labels[3]!.component.required).toBe(false);
  });

  it("comes back filled in with what was typed", () => {
    const values = { date: "2026-11-02", start: "9:00", end: "10:00", inactive: "5m", note: "Fixing it" };
    const modal = sessionFormModal({ customId: "x", title: "Add", reasonLabel: "Reason", timezone: TZ, now: NOW, values }).toJSON();
    const fields = modal.components.map((component) => (component as { component: { value?: string; options?: Array<{ value: string; default?: boolean }> } }).component);
    expect(fields[0]!.options!.find((option) => option.default)?.value).toBe("2026-11-02");
    expect(fields.slice(1).map((field) => field.value)).toEqual(["9:00", "10:00", "5m", "Fixing it"]);
  });

  it("keeps rejected answers for the person who typed them, and only for a while", () => {
    const drafts = new SessionFormDrafts(1_000);
    const input = { date: "2026-11-02", start: "9", end: "x", inactive: "", note: "n" };
    drafts.save("alice", "editended:abc", input, 0);
    expect(drafts.get("alice", "editended:abc", 500)).toEqual(input);
    expect(drafts.get("bob", "editended:abc", 500)).toBeNull();
    expect(drafts.get("alice", "editended:abc", 1_000)).toBeNull();
    drafts.save("alice", "editended:abc", input, 0);
    drafts.forget("alice", "editended:abc");
    expect(drafts.get("alice", "editended:abc", 10)).toBeNull();
  });
});
