import { BLOCK_MINUTES } from "./policy.js";

function timestamp(date: Date, style: "t"): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

/**
 * What a server's thread says when somebody moves a person's access from the
 * panel. The panel shows the current state; the thread is where it is
 * remembered, so the server half writes this line as it applies the change.
 */
export function accessNotice(
  action: "disabled" | "restored",
  username: string,
  by: string,
  until?: Date,
): string {
  return action === "disabled"
    ? `🔒 ${by} disabled **${username}**'s command access for ${BLOCK_MINUTES} minutes${until ? `, until ${timestamp(until, "t")}` : ""}.`
    : `🔓 ${by} gave **${username}**'s command access back.`;
}
