import { inspect } from "node:util";
import type { Config } from "./config.js";

/**
 * Every log line is tagged with one of these. The set is deliberately closed
 * and small: a reader scanning `docker logs` should be able to learn the whole
 * vocabulary in one sitting, and `grep " session "` should mean something.
 */
export const LOG_CATEGORIES = [
  "startup", "http", "db", "discord", "session", "command", "taiga", "verify", "portal", "config", "job",
] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

/**
 * Structured fields for one line. `category` and `actor` fill their own
 * columns; everything else is rendered as a dim `key=value` tail, so a call
 * site can attach detail without deciding how it is displayed.
 */
export type LogFields = {
  category?: LogCategory;
  /** Who this line is about — a username, not an ID. Falls back to the service name. */
  actor?: string | null | undefined;
  /** An error to render; its type, message and stack are formatted for you. */
  err?: unknown;
  [key: string]: unknown;
};

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevelName = keyof typeof LEVEL_ORDER;

export type LoggerOptions = {
  /** Shown in the actor column for lines that are not about a person. */
  service: string;
  level?: LogLevelName;
  /** `pretty` for humans, `json` for log shippers. */
  format?: "pretty" | "json";
  /** `auto` colours only on a terminal; containers usually want `always`. */
  color?: boolean | "auto" | "always" | "never";
  /** IANA zone the timestamps are rendered in, so they line up with Discord. */
  timeZone?: string;
  write?: (line: string) => void;
};

/**
 * The logging surface the whole application uses. The call signature is
 * deliberately pino-shaped — `log.info({ ...fields }, "message")` — because
 * Fastify logs through this same object.
 */
export interface Logger {
  level: LogLevelName | string;
  debug(fields: LogFields, message?: string): void;
  debug(message: string): void;
  info(fields: LogFields, message?: string): void;
  info(message: string): void;
  warn(fields: LogFields, message?: string): void;
  warn(message: string): void;
  error(fields: LogFields, message?: string): void;
  error(message: string): void;
  /** Fastify calls these; they are folded into `error` and `debug`. */
  fatal(fields: LogFields, message?: string): void;
  fatal(message: string): void;
  trace(fields: LogFields, message?: string): void;
  trace(message: string): void;
  silent(...args: unknown[]): void;
  /** A logger with fields pre-bound — usually just `{ category }`. */
  child(fields: LogFields): Logger;
}

const ESC = "\u001B[";
const ANSI = {
  reset: `${ESC}0m`,
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  gray: `${ESC}90m`,
  red: `${ESC}31m`,
  yellow: `${ESC}33m`,
  green: `${ESC}32m`,
  cyan: `${ESC}36m`,
} as const;

const LEVEL_COLOR: Record<LogLevelName, string> = {
  debug: ANSI.gray, info: ANSI.green, warn: ANSI.yellow, error: ANSI.red, silent: ANSI.gray,
};

/**
 * Noise Fastify, pino and the process attach to every line. None of it ever
 * told anyone anything they could act on, so none of it is rendered.
 */
const IGNORED_FIELDS = new Set([
  "category", "actor", "err", "error", "msg", "level", "time", "name", "pid", "hostname",
  "reqId", "req", "res", "responseTime", "v",
]);

/**
 * Lines a library emits that this application already says better in one place.
 * Fastify announces itself once per network interface a wildcard host resolves
 * to; `src/index.ts` prints where it listens, once.
 */
const IGNORED_MESSAGES = [/^Server listening at /];

const COLUMN = { level: 5, category: 8, actor: 16 } as const;

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

/** Milliseconds as something a human reads at a glance: `84ms`, `1.4s`, `19m19s`. */
export function formatDuration(milliseconds: number): string {
  const ms = Math.max(0, Math.round(milliseconds));
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

function formatValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (key.endsWith("Ms") && typeof value === "number") return formatDuration(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join(", ") : null;
  return inspect(value, { depth: 2, breakLength: Infinity, compact: true });
}

/** One line stays one line: a library's multi-line message would break the columns. */
function oneLine(text: string, limit = 300): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

/** The error's type and message for the line itself; its frames go underneath. */
function describeError(value: unknown): { summary: string; frames: string[] } {
  if (!(value instanceof Error)) return { summary: oneLine(String(value)), frames: [] };
  // `fetch failed` and friends keep the reason anyone actually wants in `cause`.
  const cause = value.cause instanceof Error ? ` (${value.cause.name}: ${value.cause.message})` : "";
  return {
    summary: oneLine(`${value.name}: ${value.message}${cause}`),
    frames: value.stack?.split("\n").slice(1).map((frame) => frame.trim()).filter(Boolean) ?? [],
  };
}

function createTimestamp(timeZone: string | undefined): (at: Date) => string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  // `en-CA` gives `2026-09-11, 16:28:04`; the comma is the only thing to drop.
  return (at) => formatter.format(at).replace(",", "");
}

/** Splits pino's `(fields, message)` / `(message)` overloads apart. */
function splitArguments(first: LogFields | string, second?: string): { fields: LogFields; message: string } {
  if (typeof first === "string") return { fields: {}, message: first };
  return { fields: first, message: second ?? String(first["msg"] ?? "") };
}

/** `LoggerOptions` once every default and `auto` has been resolved. */
type ResolvedOptions = {
  service: string;
  level: LogLevelName;
  format: "pretty" | "json";
  color: boolean;
  timeZone?: string;
  write: (line: string) => void;
};

class PrettyLogger implements Logger {
  private readonly threshold: number;
  private readonly timestamp: (at: Date) => string;

  constructor(
    private readonly options: ResolvedOptions,
    private readonly bound: LogFields = {},
  ) {
    this.threshold = LEVEL_ORDER[options.level];
    this.timestamp = createTimestamp(options.timeZone);
  }

  get level(): LogLevelName {
    return this.options.level;
  }

  debug(first: LogFields | string, second?: string): void { this.write("debug", first, second); }
  info(first: LogFields | string, second?: string): void { this.write("info", first, second); }
  warn(first: LogFields | string, second?: string): void { this.write("warn", first, second); }
  error(first: LogFields | string, second?: string): void { this.write("error", first, second); }
  fatal(first: LogFields | string, second?: string): void { this.write("error", first, second); }
  trace(first: LogFields | string, second?: string): void { this.write("debug", first, second); }
  silent(): void { /* pino parity: never emits */ }

  child(fields: LogFields): Logger {
    return new PrettyLogger(this.options, { ...this.bound, ...fields });
  }

  private write(level: LogLevelName, first: LogFields | string, second?: string): void {
    if (LEVEL_ORDER[level] < this.threshold) return;
    const { fields, message } = splitArguments(first, second);
    if (IGNORED_MESSAGES.some((pattern) => pattern.test(message))) return;
    const merged = { ...this.bound, ...fields };
    // Fastify logs its own startup errors with no category of their own.
    const category = (merged.category as LogCategory | undefined) ?? "http";
    const actor = merged.actor ?? this.options.service;
    const failure = merged.err !== undefined ? merged.err : merged["error"];

    this.options.write(this.options.format === "json"
      ? this.renderJson(level, category, actor, message, merged, failure)
      : this.renderPretty(level, category, actor, message, merged, failure));
  }

  private renderJson(
    level: LogLevelName, category: LogCategory, actor: string, message: string,
    fields: LogFields, failure: unknown,
  ): string {
    const details: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (IGNORED_FIELDS.has(key) || value === undefined) continue;
      details[key] = typeof value === "bigint" ? value.toString() : value;
    }
    return JSON.stringify({
      time: new Date().toISOString(),
      level, category, actor, msg: message,
      ...(failure !== undefined ? { error: describeError(failure).summary } : {}),
      ...details,
    });
  }

  private renderPretty(
    level: LogLevelName, category: LogCategory, actor: string, message: string,
    fields: LogFields, failure: unknown,
  ): string {
    const paint = (code: string, text: string) => (this.options.color ? `${code}${text}${ANSI.reset}` : text);
    const details: string[] = [];
    let duration = "";
    for (const [key, value] of Object.entries(fields)) {
      if (IGNORED_FIELDS.has(key)) continue;
      const rendered = formatValue(key, value);
      if (rendered === null) continue;
      // A duration is the one detail that reads better without its key.
      if (key === "durationMs") duration = rendered;
      else details.push(`${key}=${rendered}`);
    }
    const failed = failure === undefined ? null : describeError(failure);
    if (failed) details.unshift(failed.summary);
    if (duration) details.push(duration);

    const head = [
      paint(ANSI.gray, this.timestamp(new Date())),
      paint(LEVEL_COLOR[level], pad(level.toUpperCase(), COLUMN.level)),
      paint(ANSI.cyan, pad(category, COLUMN.category)),
      paint(ANSI.bold, pad(actor, COLUMN.actor)),
      oneLine(message),
    ].join("  ");
    const line = details.length ? `${head}  ${paint(ANSI.dim, details.join("  "))}` : head;

    // Only an error earns a stack, and only when it arrived with frames.
    if (level !== "error" || !failed?.frames.length) return line;
    return `${line}\n${paint(ANSI.dim, failed.frames.map((frame) => `        ${frame}`).join("\n"))}`;
  }
}

/** `LOG_LEVEL` for the loggers built before, or without, a parsed config. */
function envLevel(): LogLevelName | undefined {
  const level = process.env["LOG_LEVEL"];
  return level && level in LEVEL_ORDER ? level as LogLevelName : undefined;
}

function resolveColor(setting: LoggerOptions["color"]): boolean {
  if (typeof setting === "boolean") return setting;
  if (setting === "always") return true;
  if (setting === "never") return false;
  return Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];
}

export function createLogger(options: LoggerOptions): Logger {
  return new PrettyLogger({
    service: options.service,
    level: options.level ?? "info",
    format: options.format ?? "pretty",
    color: resolveColor(options.color),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    write: options.write ?? ((line) => process.stdout.write(`${line}\n`)),
  });
}

/**
 * The logger leaf modules reach for when they have no collaborator to take one
 * from — the Discord interaction handlers, mostly, which Discord constructs
 * far from the composition root. `src/index.ts` installs the configured logger
 * over this default during startup.
 */
let ambient: Logger = createLogger({ service: "app", level: envLevel() ?? "info" });

export function setAppLogger(logger: Logger): void {
  ambient = logger;
}

export function appLogger(): Logger {
  return ambient;
}

/**
 * The process-wide logger. It is named after the role the container runs, so
 * `bot` and `server` lines stay apart once their logs are read side by side.
 * Timestamps use the reporting timezone, which is the one staff read in Discord.
 */
export function createAppLogger(config: Config): Logger {
  const role = config.APP_ROLE ?? "all";
  // The environment is the fallback so a caller holding a partial config — a
  // test building one by hand — can still turn the output down.
  const level = config.LOG_LEVEL ?? envLevel() ?? "info";
  return createLogger({
    service: role === "all" ? "app" : role,
    level,
    format: config.LOG_FORMAT ?? "pretty",
    color: config.LOG_COLOR ?? "auto",
    ...(config.REPORT_TIMEZONE ? { timeZone: config.REPORT_TIMEZONE } : {}),
  });
}
