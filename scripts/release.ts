import { spawnSync } from "node:child_process";

type VersionPart = "major" | "release" | "beta";

const versionPartAliases: Readonly<Record<string, VersionPart>> = {
    m: "major",
    major: "major",
    r: "release",
    release: "release",
    b: "beta",
    beta: "beta",
};

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

function printUsage(): void {
    console.error("Usage: npm run release -- <M|R|B>");
    console.error("  M / major   1.2.3 -> 2.0.0");
    console.error("  R / release 1.2.3 -> 1.3.0");
    console.error("  B / beta    1.2.3 -> 1.2.4");
}

const requestedPart = process.argv[2]?.toLowerCase();
const versionPart = requestedPart === undefined ? undefined : versionPartAliases[requestedPart];

if (versionPart === undefined) {
    printUsage();
    process.exitCode = 1;
} else {
    try {
        const worktreeStatus = run("git", ["status", "--porcelain"], true);
        if (worktreeStatus !== "") {
            throw new Error("The working tree is not clean. Commit or stash changes before releasing.");
        }

        const originUrl = run("git", ["remote", "get-url", "origin"], true);
        if (!originUrl.toLowerCase().includes("github.com")) {
            throw new Error(`The origin remote is not hosted on GitHub: ${originUrl}`);
        }

        const npmVersionPart = versionPart === "release" ? "minor" : versionPart === "beta" ? "patch" : "major";
        run("npm", ["version", npmVersionPart, "-m", "chore(release): v%s"]);

        const version = run("node", ["-p", "require('./package.json').version"], true);
        run("git", ["push", "origin", "HEAD", "--follow-tags"]);
        console.log(`Released v${version} to GitHub.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}
