import { describe, expect, it } from "vitest";
import { EMPTY_CHANGELOG_BODY, nextVersion, planChangelog } from "../../scripts/release-plan.js";

const changelog = [
  "# Changelog",
  "",
  "All notable changes are recorded here.",
  "",
  "## Unreleased",
  "",
  "- Added a thing.",
  "- Fixed another thing.",
  "",
  "## 0.13.4 - 2026-08-22",
  "",
  "- An older entry.",
  "",
].join("\n");

describe("next version", () => {
  it("maps each release part onto the right component", () => {
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
    expect(nextVersion("1.2.3", "release")).toBe("1.3.0");
    expect(nextVersion("1.2.3", "beta")).toBe("1.2.4");
  });

  it("rejects a version package.json could not have produced", () => {
    expect(() => nextVersion("1.2", "beta")).toThrow(/Invalid version/);
  });
});

describe("changelog promotion", () => {
  it("reads what is waiting to be released", () => {
    expect(planChangelog(changelog).entries).toBe("- Added a thing.\n- Fixed another thing.");
  });

  it("renames the Unreleased section and opens an empty one above it", () => {
    const promoted = planChangelog(changelog).promote("0.14.0", "2026-09-10");
    expect(promoted).toBe([
      "# Changelog",
      "",
      "All notable changes are recorded here.",
      "",
      "## Unreleased",
      "",
      EMPTY_CHANGELOG_BODY,
      "",
      "## 0.14.0 - 2026-09-10",
      "",
      "- Added a thing.",
      "- Fixed another thing.",
      "",
      "## 0.13.4 - 2026-08-22",
      "",
      "- An older entry.",
      "",
    ].join("\n"));
  });

  it("treats a freshly seeded section as having nothing to release", () => {
    const seeded = planChangelog(changelog).promote("0.14.0", "2026-09-10");
    expect(planChangelog(seeded).entries).toBe("");
  });

  it("refuses a changelog with no Unreleased section", () => {
    expect(() => planChangelog("# Changelog\n\n## 0.1.0 - 2026-01-01\n")).toThrow(/no ## Unreleased/);
  });
});
