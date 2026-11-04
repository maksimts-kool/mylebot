import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, loadImage, Path2D, type SKRSContext2D } from "@napi-rs/canvas";
import type { BadgeDefinition, BadgeIcon } from "../domain/badges.js";
import { BADGE_ICON_PATHS } from "./badge-icons.js";

/**
 * Draws the `/profile` card and the badge icons. Takes a finished model and
 * returns PNG bytes; deciding what goes on the card is `profile-view.ts`'s job.
 */

export type ProfileCardBadge = Pick<BadgeDefinition, "name" | "color" | "icon" | "repeatable"> & {
  earned: boolean;
  count: number;
};

export type ProfileCardModel = {
  title: string;
  subtitle: string | null;
  rank: string | null;
  avatar: Buffer | null;
  onShift: boolean;
  tiles: Array<{ label: string; value: string }>;
  badges: ProfileCardBadge[];
  badgeSummary: string;
  sinceLabel: string;
  next: { label: string; progressLabel: string; fraction: number };
};

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 616;

const PAD = 40;

const PALETTE = {
  background: "#16171f",
  banner: "#4f5bd5",
  bannerLine: "rgba(255,255,255,0.16)",
  panelStroke: "rgba(255,255,255,0.14)",
  track: "rgba(255,255,255,0.08)",
  text: "#f4f5f8",
  body: "#dcdfe6",
  muted: "#9aa0ae",
  faint: "#6b7080",
  ring: "#9aa8ff",
  bar: "#8b98ff",
  onShift: "#34d399",
  offShift: "#6b7280",
  pillFill: "rgba(140,120,255,0.20)",
  pillStroke: "rgba(170,150,255,0.50)",
  pillText: "#ddd4ff",
  lockedFill: "#1d1f28",
  lockedStroke: "#3a3d4a",
  lockedGlyph: "#4b4f5e",
  lockedText: "#6b7080",
  avatarFallback: "#c8cdd6",
  avatarFallbackText: "#3a3d44",
} as const;

/** Nunito, from Google Fonts: rounded and soft, so the card reads calm. */
const FONT = { regular: "MyleNunito", semibold: "MyleNunitoSemiBold", bold: "MyleNunitoExtraBold" } as const;

/** The repository's `assets/fonts`, found from here in both `src` and `dist`. */
function fontsDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, "assets", "fonts");
    if (existsSync(join(candidate, "Nunito-Regular.ttf"))) return candidate;
    directory = dirname(directory);
  }
  throw new Error("The profile card fonts are missing: assets/fonts/Nunito-Regular.ttf was not found");
}

let fontsRegistered = false;
function registerFonts(): void {
  if (fontsRegistered) return;
  const directory = fontsDirectory();
  GlobalFonts.registerFromPath(join(directory, "Nunito-Regular.ttf"), FONT.regular);
  GlobalFonts.registerFromPath(join(directory, "Nunito-SemiBold.ttf"), FONT.semibold);
  GlobalFonts.registerFromPath(join(directory, "Nunito-ExtraBold.ttf"), FONT.bold);
  fontsRegistered = true;
}

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function alpha(hex: string, opacity: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${opacity})`;
}

/** `hex` moved `amount` of the way toward `toward`. */
function mix(hex: string, toward: string, amount: number): string {
  const [r1, g1, b1] = rgb(hex);
  const [r2, g2, b2] = rgb(toward);
  const channel = (from: number, to: number) => Math.round(from + (to - from) * amount);
  return `rgb(${channel(r1, r2)},${channel(g1, g2)},${channel(b1, b2)})`;
}

function roundedRect(ctx: SKRSContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/** An outlined card: a stroke only, so the card stays light. */
function panel(ctx: SKRSContext2D, x: number, y: number, width: number, height: number, radius = 20): void {
  roundedRect(ctx, x, y, width, height, radius);
  ctx.lineWidth = 2;
  ctx.strokeStyle = PALETTE.panelStroke;
  ctx.stroke();
}

/** Sets the largest font, from `size` down to `min`, that fits `text` in `maxWidth`. */
function fitFont(ctx: SKRSContext2D, text: string, family: string, size: number, maxWidth: number, min = 12): number {
  let current = size;
  ctx.font = `${current}px ${family}`;
  while (current > min && ctx.measureText(text).width > maxWidth) {
    current -= 1;
    ctx.font = `${current}px ${family}`;
  }
  return current;
}

/** Shortens `text` with an ellipsis until it fits the current font. */
function truncate(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let shortened = text;
  while (shortened.length > 1 && ctx.measureText(`${shortened}…`).width > maxWidth) shortened = shortened.slice(0, -1);
  return `${shortened}…`;
}

/** Strokes a badge's artwork, centred and scaled to sit inside a medallion of `radius`. */
function drawIcon(ctx: SKRSContext2D, icon: BadgeIcon, cx: number, cy: number, radius: number, color: string): void {
  const scale = (radius * 1.34) / 24;
  ctx.save();
  ctx.translate(cx - 12 * scale, cy - 12 * scale);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.fillStyle = color;
  for (const part of BADGE_ICON_PATHS[icon]) {
    const path = new Path2D(typeof part === "string" ? part : part.d);
    // Filled shapes are stroked too, so their corners round like everything else.
    if (typeof part !== "string") ctx.fill(path);
    ctx.stroke(path);
  }
  ctx.restore();
}

function drawLock(ctx: SKRSContext2D, cx: number, cy: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, 15, 0, Math.PI * 2);
  ctx.fillStyle = "#2a2d38";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = PALETTE.background;
  ctx.stroke();
  ctx.fillStyle = "#9aa0ae";
  roundedRect(ctx, cx - 7, cy - 2, 14, 10, 2);
  ctx.fill();
  ctx.strokeStyle = "#9aa0ae";
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.arc(cx, cy - 3, 4.5, Math.PI, 0);
  ctx.stroke();
  ctx.restore();
}

/** A medallion: flat face, stroked rim with an outer echo, and the badge's icon. */
function drawMedallion(ctx: SKRSContext2D, badge: Pick<ProfileCardBadge, "color" | "icon" | "earned">, cx: number, cy: number, radius: number): void {
  ctx.save();
  if (badge.earned) {
    // Flat face with stroked rings: an outer echo and the rim.
    ctx.lineWidth = 2;
    ctx.strokeStyle = alpha(badge.color.glyph, 0.3);
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 7, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = badge.color.fill;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = badge.color.glyph;
    ctx.beginPath();
    ctx.arc(cx, cy, radius - 1.5, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.fillStyle = PALETTE.lockedFill;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.setLineDash([7, 6]);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = PALETTE.lockedStroke;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
  drawIcon(ctx, badge.icon, cx, cy, radius, badge.earned ? badge.color.glyph : PALETTE.lockedGlyph);
  if (!badge.earned) drawLock(ctx, cx + radius * 0.72, cy + radius * 0.72);
}

function drawBackground(ctx: SKRSContext2D): void {
  ctx.fillStyle = PALETTE.background;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  const bannerHeight = 136;
  ctx.fillStyle = PALETTE.banner;
  ctx.fillRect(0, 0, CARD_WIDTH, bannerHeight);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, CARD_WIDTH, bannerHeight);
  ctx.clip();
  // Stroked contour lines and rings, like a calm sea, instead of shading.
  ctx.lineWidth = 2;
  ctx.strokeStyle = PALETTE.bannerLine;
  for (let line = 0; line < 5; line += 1) {
    const base = 30 + line * 26;
    ctx.beginPath();
    ctx.moveTo(480, base + 20);
    ctx.bezierCurveTo(700, base - 40, 880, base + 60, CARD_WIDTH, base - 10);
    ctx.stroke();
  }
  for (const [x, y, r] of [[1040, 10, 120], [1040, 10, 170], [300, -40, 110]] as const) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.beginPath();
  ctx.moveTo(0, bannerHeight - 1);
  ctx.lineTo(CARD_WIDTH, bannerHeight - 1);
  ctx.stroke();
}

async function drawAvatar(ctx: SKRSContext2D, model: ProfileCardModel, cx: number, cy: number, radius: number): Promise<void> {
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 12, 0, Math.PI * 2);
  ctx.fillStyle = PALETTE.background;
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = PALETTE.ring;
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 7, 0, Math.PI * 2);
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = PALETTE.avatarFallback;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  let drawn = false;
  if (model.avatar) {
    try {
      const image = await loadImage(model.avatar);
      ctx.drawImage(image, cx - radius, cy - radius, radius * 2, radius * 2);
      drawn = true;
    } catch {
      // A corrupt thumbnail falls back to initials rather than failing the card.
      drawn = false;
    }
  }
  if (!drawn) {
    ctx.fillStyle = PALETTE.avatarFallbackText;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(radius * 0.8)}px ${FONT.bold}`;
    ctx.fillText(model.title.slice(0, 2).toUpperCase(), cx, cy + 2);
  }
  ctx.restore();

  // Presence dot: green while on shift.
  const angle = Math.PI / 4;
  const dx = cx + Math.cos(angle) * (radius + 2);
  const dy = cy + Math.sin(angle) * (radius + 2);
  ctx.beginPath();
  ctx.arc(dx, dy, 19, 0, Math.PI * 2);
  ctx.fillStyle = PALETTE.background;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(dx, dy, 13, 0, Math.PI * 2);
  ctx.fillStyle = model.onShift ? PALETTE.onShift : PALETTE.offShift;
  ctx.fill();
}

function drawHeader(ctx: SKRSContext2D, model: ProfileCardModel, nameX: number): void {
  // A quiet label in the banner's corner.
  ctx.font = `17px ${FONT.semibold}`;
  const label = "STAFF PROFILE";
  const labelWidth = ctx.measureText(label).width + 32;
  roundedRect(ctx, CARD_WIDTH - PAD - labelWidth, 30, labelWidth, 36, 18);
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, CARD_WIDTH - PAD - labelWidth + 16, 49);

  const maxWidth = CARD_WIDTH - PAD - nameX;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = PALETTE.text;
  fitFont(ctx, model.title, FONT.bold, 42, maxWidth, 26);
  ctx.fillText(truncate(ctx, model.title, maxWidth), nameX, 194);

  let x = nameX;
  if (model.rank) {
    ctx.font = `20px ${FONT.semibold}`;
    const rank = truncate(ctx, model.rank, 420);
    const width = ctx.measureText(rank).width + 36;
    roundedRect(ctx, x, 208, width, 34, 17);
    ctx.fillStyle = PALETTE.pillFill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = PALETTE.pillStroke;
    ctx.stroke();
    ctx.fillStyle = PALETTE.pillText;
    ctx.textBaseline = "middle";
    ctx.fillText(rank, x + 18, 226);
    x += width + 16;
  }
  if (model.subtitle) {
    ctx.fillStyle = PALETTE.muted;
    ctx.font = `21px ${FONT.regular}`;
    ctx.textBaseline = "middle";
    ctx.fillText(truncate(ctx, model.subtitle, CARD_WIDTH - PAD - x), x, 226);
  }
  ctx.textBaseline = "alphabetic";
}

function drawTiles(ctx: SKRSContext2D, model: ProfileCardModel, top: number): void {
  const inner = CARD_WIDTH - PAD * 2;
  const gap = 16;
  const width = (inner - gap * (model.tiles.length - 1)) / model.tiles.length;
  model.tiles.forEach((tile, index) => {
    const x = PAD + index * (width + gap);
    panel(ctx, x, top, width, 92, 16);
    ctx.textAlign = "left";
    ctx.fillStyle = PALETTE.muted;
    ctx.font = `19px ${FONT.semibold}`;
    ctx.fillText(truncate(ctx, tile.label, width - 40), x + 20, top + 36);
    ctx.fillStyle = PALETTE.text;
    fitFont(ctx, tile.value, FONT.bold, 32, width - 40, 20);
    ctx.fillText(tile.value, x + 20, top + 74);
  });
}

function drawBadges(ctx: SKRSContext2D, model: ProfileCardModel, top: number): void {
  const inner = CARD_WIDTH - PAD * 2;
  ctx.textAlign = "left";
  ctx.fillStyle = PALETTE.text;
  ctx.font = `28px ${FONT.bold}`;
  ctx.fillText("Badges", PAD, top + 28);
  const headingWidth = ctx.measureText("Badges").width;
  ctx.font = `20px ${FONT.semibold}`;
  const summaryX = PAD + headingWidth + 14;
  const summaryWidth = ctx.measureText(model.badgeSummary).width + 24;
  roundedRect(ctx, summaryX, top + 6, summaryWidth, 30, 15);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fill();
  ctx.fillStyle = PALETTE.body;
  ctx.textBaseline = "middle";
  ctx.fillText(model.badgeSummary, summaryX + 12, top + 22);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = PALETTE.faint;
  ctx.font = `17px ${FONT.semibold}`;
  ctx.fillText(model.sinceLabel, summaryX + summaryWidth + 14, top + 28);

  // Progress to the next hours badge, on the right of the heading.
  const barWidth = 320;
  const barX = CARD_WIDTH - PAD - barWidth;
  ctx.textAlign = "left";
  ctx.fillStyle = PALETTE.body;
  ctx.font = `18px ${FONT.semibold}`;
  ctx.fillText(model.next.label, barX, top + 16);
  ctx.textAlign = "right";
  ctx.fillStyle = PALETTE.muted;
  ctx.fillText(model.next.progressLabel, CARD_WIDTH - PAD, top + 16);
  roundedRect(ctx, barX, top + 26, barWidth, 10, 5);
  ctx.fillStyle = PALETTE.track;
  ctx.fill();
  const fraction = Math.min(1, Math.max(0, model.next.fraction));
  if (fraction > 0) {
    roundedRect(ctx, barX, top + 26, Math.max(10, barWidth * fraction), 10, 5);
    ctx.fillStyle = PALETTE.bar;
    ctx.fill();
  }

  const slot = inner / Math.max(1, model.badges.length);
  const radius = 42;
  const cy = top + 100;
  model.badges.forEach((badge, index) => {
    const cx = PAD + slot * index + slot / 2;
    drawMedallion(ctx, badge, cx, cy, radius);
    if (badge.earned && badge.repeatable && badge.count > 0) {
      const label = `×${badge.count}`;
      ctx.font = `17px ${FONT.bold}`;
      const width = Math.max(36, ctx.measureText(label).width + 18);
      const chipX = cx + radius * 0.42;
      const chipY = cy - radius - 4;
      roundedRect(ctx, chipX, chipY, width, 28, 14);
      ctx.fillStyle = badge.color.glyph;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = PALETTE.background;
      ctx.stroke();
      ctx.fillStyle = mix(badge.color.fill, "#000000", 0.2);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, chipX + width / 2, chipY + 15);
      ctx.textBaseline = "alphabetic";
    }
    ctx.textAlign = "center";
    ctx.fillStyle = badge.earned ? PALETTE.body : PALETTE.lockedText;
    fitFont(ctx, badge.name, badge.earned ? FONT.bold : FONT.semibold, 18, slot - 10, 13);
    ctx.fillText(badge.name, cx, cy + radius + 32);
  });
}

export async function renderProfileCard(model: ProfileCardModel): Promise<Buffer> {
  registerFonts();
  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext("2d");

  roundedRect(ctx, 0, 0, CARD_WIDTH, CARD_HEIGHT, 32);
  ctx.clip();
  drawBackground(ctx);

  const avatarRadius = 76;
  await drawAvatar(ctx, model, PAD + avatarRadius + 8, 160, avatarRadius);
  drawHeader(ctx, model, PAD + avatarRadius * 2 + 46);
  drawTiles(ctx, model, 268);
  drawBadges(ctx, model, 396);

  return canvas.encode("png");
}

/** A single badge, used as the thumbnail on the DM that announces it. */
export async function renderBadgeIcon(badge: Pick<BadgeDefinition, "color" | "icon">, size = 160): Promise<Buffer> {
  registerFonts();
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  drawMedallion(ctx, { ...badge, earned: true }, size / 2, size / 2, size / 2 - size * 0.14);
  return canvas.encode("png");
}
