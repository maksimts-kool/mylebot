/**
 * The file changes of a release, run by `.github/workflows/release.yml`:
 *
 *   tsx scripts/release.ts <patch|minor|major> <notes-file>
 *
 * It raises the version in package.json, package-lock.json and
 * src/core/version.ts, turns the changelog's Unreleased section into that
 * version, and writes those entries to <notes-file> for the GitHub release.
 * Committing, tagging and publishing are the workflow's job. The only thing on
 * stdout is `version=X.Y.Z`, which the workflow reads as a step output.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { UNRELEASED_HEADING, VERSION_PARTS, nextVersion, planChangelog, type VersionPart } from "./release-plan.js";

const CHANGELOG_URL = new URL("../CHANGELOG.md", import.meta.url);
const PACKAGE_URL = new URL("../package.json", import.meta.url);

const [part, notesFile] = process.argv.slice(2);
if (!VERSION_PARTS.includes(part as VersionPart) || !notesFile) {
  throw new Error(`Usage: tsx scripts/release.ts <${VERSION_PARTS.join("|")}> <notes-file>`);
}

const { version: from } = JSON.parse(readFileSync(PACKAGE_URL, "utf8")) as { version: string };
const to = nextVersion(from, part as VersionPart);

const changelog = planChangelog(readFileSync(CHANGELOG_URL, "utf8"));
if (changelog.entries === "") {
  throw new Error(`CHANGELOG.md has nothing under ${UNRELEASED_HEADING}. Describe the release there first.`);
}

// npm keeps package-lock.json in step and runs the `version` script, which
// rewrites src/core/version.ts. Its own output goes to stderr, off the step output.
const npm = spawnSync("npm", ["version", to, "--no-git-tag-version"], { stdio: ["ignore", 2, 2] });
if (npm.status !== 0) throw new Error(`npm version ${to} failed`);

writeFileSync(CHANGELOG_URL, changelog.promote(to, new Date().toISOString().slice(0, 10)));
writeFileSync(notesFile, `${changelog.entries}\n`);
console.error(`Releasing ${from} -> ${to}`);
console.log(`version=${to}`);
