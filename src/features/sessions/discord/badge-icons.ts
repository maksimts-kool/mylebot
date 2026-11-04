import type { BadgeIcon } from "../domain/badges.js";

/**
 * One stroke of a badge picture. `fill` marks a small solid shape — an arrow
 * on a button, a crown — which reads better filled than outlined at badge size.
 */
export type IconPath = string | { d: string; fill: true };

/**
 * Badge artwork drawn for this bot. The hours badges are one family of rank
 * insignia — chevrons pointing up, then stars — so the five read as a ladder
 * at a glance; the leaderboard and Veteran badges carry the lift theme of the
 * game staff work in (My Lifts - Elevators). Every picture is SVG paths on a
 * 24×24 grid with a 2px round stroke, kept inside 2–22 so they share one
 * optical size.
 */
export const BADGE_ICON_PATHS: Readonly<Record<BadgeIcon, readonly IconPath[]>> = {
  // One chevron: the first step up.
  "rank-1": [
    "M4 14.75l8 -5.5l8 5.5",
  ],
  // Two chevrons.
  "rank-2": [
    "M4.5 11.5l7.5 -5l7.5 5",
    "M4.5 17.5l7.5 -5l7.5 5",
  ],
  // Three chevrons.
  "rank-3": [
    "M5 9.25l7 -4.5l7 4.5",
    "M5 14.25l7 -4.5l7 4.5",
    "M5 19.25l7 -4.5l7 4.5",
  ],
  // Three chevrons under a star.
  "rank-star": [
    "M5.5 12.75l6.5 -4l6.5 4",
    "M5.5 16.75l6.5 -4l6.5 4",
    "M5.5 20.75l6.5 -4l6.5 4",
    { d: "M12 1.5L12.79 3.51L14.95 3.64L13.28 5.02L13.82 7.11L12 5.95L10.18 7.11L10.72 5.02L9.05 3.64L11.21 3.51z", fill: true },
  ],
  // Three chevrons under three stars.
  "rank-stars": [
    "M5.5 12.75l6.5 -4l6.5 4",
    "M5.5 16.75l6.5 -4l6.5 4",
    "M5.5 20.75l6.5 -4l6.5 4",
    { d: "M6 3.3L6.59 4.79L8.19 4.89L6.95 5.91L7.35 7.46L6 6.6L4.65 7.46L5.05 5.91L3.81 4.89L5.41 4.79z", fill: true },
    { d: "M12 1.3L12.68 2.97L14.47 3.1L13.09 4.26L13.53 6L12 5.05L10.47 6L10.91 4.26L9.53 3.1L11.32 2.97z", fill: true },
    { d: "M18 3.3L18.59 4.79L20.19 4.89L18.95 5.91L19.35 7.46L18 6.6L16.65 7.46L17.05 5.91L15.81 4.89L17.41 4.79z", fill: true },
  ],
  // A calendar page with a star on it: the month that was theirs.
  "month-star": [
    "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2z",
    "M3 9.5h18",
    "M8 3v4",
    "M16 3v4",
    { d: "M12 11.4L12.94 13.81L15.52 13.96L13.52 15.59L14.17 18.09L12 16.7L9.83 18.09L10.48 15.59L8.48 13.96L11.06 13.81z", fill: true },
  ],
  // Three lifts standing as a podium, with a star over first place.
  "lift-podium": [
    "M2 22h20",
    "M3 22v-7a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v7",
    "M9 22v-12a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v12",
    "M15 22v-4a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4",
    "M6 17v5",
    "M12 12v10",
    { d: "M12 1.8l.68 1.77l1.89 .1l-1.48 1.19l.5 1.82l-1.59 -1.03l-1.59 1.03l.5 -1.82l-1.48 -1.19l1.89 -.1z", fill: true },
  ],
  // A shield carrying the lift's up and down arrows.
  "lift-shield": [
    "M12 2.5l7.5 3v6c0 4.6 -3.1 8.4 -7.5 10c-4.4 -1.6 -7.5 -5.4 -7.5 -10v-6z",
    { d: "M12 7l2.5 3.5h-5z", fill: true },
    { d: "M12 17.5l2.5 -3.5h-5z", fill: true },
  ],
};
