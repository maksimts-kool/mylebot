import { describe, expect, it } from "vitest";
import { createLogger, formatDuration } from "../../src/core/logger.js";

/** A logger that collects its lines instead of writing them to stdout. */
function collecting(options: Parameters<typeof createLogger>[0] = { service: "bot" }) {
  const lines: string[] = [];
  const log = createLogger({ timeZone: "UTC", color: false, ...options, write: (line) => lines.push(line) });
  return { log, lines };
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;

describe("log lines", () => {
  it("reads as date, level, category, who, then the message", () => {
    const { log, lines } = collecting();

    log.info({ category: "session", actor: "wolfik11111111" }, "Session ended");

    expect(lines[0]).toMatch(TIMESTAMP);
    expect(lines[0]).toMatch(/INFO\s+session\s+wolfik11111111\s+Session ended$/);
  });

  it("names the service in the who column when the line is not about a person", () => {
    const { log, lines } = collecting({ service: "server" });

    log.info({ category: "http" }, "Listening on 0.0.0.0:3000");

    expect(lines[0]).toMatch(/INFO\s+http\s+server\s+Listening on 0\.0\.0\.0:3000$/);
  });

  it("puts the remaining fields after the message and drops the ones nobody reads", () => {
    const { log, lines } = collecting();

    log.info({ category: "job", durationMs: 84, reqId: "req-1of", pid: 83, removed: 2 }, "announcement cleanup");

    expect(lines[0]).toContain("announcement cleanup  removed=2  84ms");
    expect(lines[0]).not.toContain("req-1of");
    expect(lines[0]).not.toContain("pid");
  });

  it("carries bound fields into every line a child writes", () => {
    const { log, lines } = collecting();

    log.child({ category: "taiga" }).warn({ card: "#12" }, "Board unreachable");

    expect(lines[0]).toMatch(/WARN\s+taiga\s+bot\s+Board unreachable\s+card=#12$/);
  });

  it("reports an error by type and message, with its stack underneath", () => {
    const { log, lines } = collecting();

    log.error({ category: "discord", err: new TypeError("Missing Permissions") }, "Edit failed");

    const [line] = lines;
    expect(line).toContain("Edit failed  TypeError: Missing Permissions");
    expect(line!.split("\n").length).toBeGreaterThan(1);
  });

  it("says nothing below the configured level", () => {
    const { log, lines } = collecting({ service: "bot", level: "warn" });

    log.info({ category: "http" }, "routine");
    log.debug({ category: "http" }, "detail");
    log.warn({ category: "http" }, "something to look at");

    expect(lines).toEqual([expect.stringContaining("something to look at")]);
  });

  it("emits one JSON object per line when asked to", () => {
    const { log, lines } = collecting({ service: "bot", format: "json" });

    log.info({ category: "session", actor: "Tester", total: "19m19s" }, "Session ended");

    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "info", category: "session", actor: "Tester", msg: "Session ended", total: "19m19s",
    });
  });
});

describe("durations", () => {
  it("scales the unit to the length of what it is describing", () => {
    expect(formatDuration(84)).toBe("84ms");
    expect(formatDuration(1_400)).toBe("1.4s");
    expect(formatDuration(1_159_000)).toBe("19m19s");
    expect(formatDuration(7_320_000)).toBe("2h02m");
  });
});

describe("errors that would not fit on one line", () => {
  it("collapses a multi-line message so the columns stay put", () => {
    const { log, lines } = collecting();
    const sprawling = new Error("Invalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed.\n  Code: `N/A`");

    log.warn({ category: "db", err: sprawling }, "Readiness check failed");

    // A warning carries no stack, so the entry is exactly one line.
    expect(lines[0]!.split("\n")).toHaveLength(1);
    expect(lines[0]).toContain("Error: Invalid `prisma.$queryRaw()` invocation: Raw query failed. Code: `N/A`");
  });

  it("names the cause, which is where fetch keeps the part worth reading", () => {
    const { log, lines } = collecting();
    const failure = new TypeError("fetch failed", { cause: new Error("ECONNREFUSED 127.0.0.1:3000") });

    log.error({ category: "http", err: failure }, "The bot container did not answer");

    expect(lines[0]).toContain("TypeError: fetch failed (Error: ECONNREFUSED 127.0.0.1:3000)");
  });

  it("adds no empty stack block to an error that arrived without frames", () => {
    const { log, lines } = collecting();
    const bare = new Error("no frames");
    bare.stack = "Error: no frames";

    log.error({ category: "http", err: bare }, "Something went wrong");

    expect(lines[0]!.endsWith("Error: no frames")).toBe(true);
  });
});
