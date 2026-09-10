import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { UNRELEASED_HEADING, nextVersion, planChangelog, type VersionPart } from "./release-plan.js";

const versionPartAliases: Readonly<Record<string, VersionPart>> = {
    m: "major",
    major: "major",
    r: "release",
    release: "release",
    b: "beta",
    beta: "beta",
};

const OPTIONS = ["--dry-run", "--skip-checks", "--allow-empty-changelog"] as const;
const CHANGELOG_URL = new URL("../CHANGELOG.md", import.meta.url);
/** Files the release itself rewrites, which have to join the version commit. */
const RELEASE_ARTIFACTS = ["CHANGELOG.md", "src/core/version.ts"] as const;

function run(command: string, args: readonly string[], captureOutput = false): string {
    const useNpmCli = process.platform === "win32" && command === "npm";
    const npmCliPath = process.env.npm_execpath;

    if (useNpmCli && npmCliPath === undefined) {
        throw new Error("npm_execpath is unavailable; run this script through npm.");
    }

    const executable = useNpmCli ? process.execPath : command;
    const executableArgs: readonly string[] = useNpmCli ? [npmCliPath!, ...args] : args;
    const result = spawnSync(executable, executableArgs, {
        encoding: "utf8",
        stdio: captureOutput ? "pipe" : "inherit",
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        const details = captureOutput ? result.stderr.trim() : "";
        throw new Error(`${command} ${args.join(" ")} failed${details ? `: ${details}` : ""}`);
    }

    return captureOutput ? result.stdout.trim() : "";
}

/** Like `run`, but a failure is reported as `null` instead of thrown. */
function tryRun(command: string, args: readonly string[]): string | null {
    try {
        return run(command, args, true);
    } catch {
        return null;
    }
}

function printUsage(): void {
    console.error("Usage: npm run release -- <M|R|B> [options]");
    console.error("  M / major   1.2.3 -> 2.0.0");
    console.error("  R / release 1.2.3 -> 1.3.0");
    console.error("  B / beta    1.2.3 -> 1.2.4");
    console.error("");
    console.error("Options:");
    console.error("  --dry-run                Report the plan and stop before changing anything.");
    console.error("  --skip-checks            Do not run npm test, typecheck, and build first.");
    console.error("  --allow-empty-changelog  Release even with no entries under the Unreleased heading.");
}

function currentVersion(): string {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
        throw new Error("package.json contains an invalid version");
    }
    return packageJson.version;
}

function today(): string {
    const now = new Date();
    return [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
    ].join("-");
}

/** Everything that has to be true before the release is allowed to start. */
function assertReleasable(tag: string): void {
    const worktreeStatus = run("git", ["status", "--porcelain"], true);
    if (worktreeStatus !== "") {
        const paths = worktreeStatus.split("\n").map((line) => `  ${line.trim()}`).join("\n");
        throw new Error(`The working tree is not clean. Commit or stash these before releasing:\n${paths}`);
    }

    const originUrl = run("git", ["remote", "get-url", "origin"], true);
    if (!originUrl.toLowerCase().includes("github.com")) {
        throw new Error(`The origin remote is not hosted on GitHub: ${originUrl}`);
    }

    const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], true);
    const defaultBranch = tryRun("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.replace(/^origin\//, "") ?? "main";
    if (branch !== defaultBranch) {
        throw new Error(`Releases are cut from ${defaultBranch}, but HEAD is on ${branch}. Switch branches or merge first.`);
    }

    if (run("git", ["tag", "--list", tag], true) !== "") {
        throw new Error(`Tag ${tag} already exists locally. Delete it, or choose a different version part.`);
    }

    // Without the remote's current state neither check can be judged. The push
    // at the end still refuses to release on top of someone else's work.
    if (tryRun("git", ["fetch", "origin", "--tags"]) === null) {
        console.warn("Warning: origin is unreachable; skipping the up-to-date and remote tag checks.");
        return;
    }
    const behind = tryRun("git", ["rev-list", "--count", `HEAD..origin/${branch}`]);
    if (behind !== null && behind !== "0") {
        throw new Error(`${branch} is ${behind} commit(s) behind origin/${branch}. Pull before releasing.`);
    }
    if (tryRun("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])) {
        throw new Error(`Tag ${tag} already exists on origin.`);
    }
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((argument) => argument.startsWith("--")));
const positional = args.filter((argument) => !argument.startsWith("--"));
const unknownFlags = [...flags].filter((flag) => !OPTIONS.includes(flag as (typeof OPTIONS)[number]));
const versionPart = positional.length === 1 ? versionPartAliases[positional[0]!.toLowerCase()] : undefined;

if (versionPart === undefined || unknownFlags.length > 0) {
    if (unknownFlags.length > 0) console.error(`Unknown option: ${unknownFlags.join(", ")}`);
    printUsage();
    process.exitCode = 1;
} else {
    const from = currentVersion();
    const to = nextVersion(from, versionPart);
    const tag = `v${to}`;
    let bumped = false;

    try {
        assertReleasable(tag);

        const changelog = planChangelog(readFileSync(CHANGELOG_URL, "utf8"));
        if (changelog.entries === "" && !flags.has("--allow-empty-changelog")) {
            throw new Error(`CHANGELOG.md has no entries under ${UNRELEASED_HEADING}. Describe the release there, or pass --allow-empty-changelog.`);
        }

        console.log(`Releasing ${from} -> ${to} (${tag}), a ${versionPart} bump.`);
        console.log(changelog.entries === ""
            ? "  Changelog: no entries."
            : changelog.entries.split("\n").map((line) => `  ${line}`).join("\n"));

        if (flags.has("--dry-run")) {
            console.log("Dry run: nothing was changed.");
        } else {
            if (flags.has("--skip-checks")) {
                console.warn("Warning: releasing without running tests, typecheck, and build.");
            } else {
                for (const script of ["test", "typecheck", "build"]) run("npm", ["run", script]);
            }

            const npmVersionPart = versionPart === "release" ? "minor" : versionPart === "beta" ? "patch" : "major";
            run("npm", ["version", npmVersionPart, "-m", "chore(release): v%s"]);
            bumped = true;

            const version = currentVersion();
            if (version !== to) {
                throw new Error(`Expected npm to produce ${to}, but package.json now says ${version}.`);
            }
            writeFileSync(CHANGELOG_URL, changelog.promote(version, today()));

            // `npm version` has already committed and tagged. Fold the changelog
            // and the generated version file into that same commit, then move the
            // tag onto the amended commit so the tag and the release agree.
            const pending = run("git", ["status", "--porcelain", "--", ...RELEASE_ARTIFACTS], true);
            if (pending !== "") {
                run("git", ["add", ...RELEASE_ARTIFACTS]);
                run("git", ["commit", "--amend", "--no-edit"]);
                run("git", ["tag", "--force", "--annotate", tag, "--message", tag]);
            }

            run("git", ["push", "origin", "HEAD", "--follow-tags"]);
            console.log(`Released ${tag} to GitHub.`);
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        if (bumped) {
            console.error("");
            console.error(`The version bump was committed locally, but ${tag} was not pushed. To undo it:`);
            console.error(`  git tag --delete ${tag}`);
            console.error("  git reset --hard HEAD~1");
        }
        process.exitCode = 1;
    }
}
