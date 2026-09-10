/**
 * The pure half of `scripts/release.ts`: what the next version is and what the
 * changelog looks like afterwards. Kept apart from the script so it can be
 * tested without running git.
 */

export type VersionPart = "major" | "release" | "beta";

export const UNRELEASED_HEADING = "## Unreleased";

/** Seeded into the fresh Unreleased section, and read back as "no entries yet". */
export const EMPTY_CHANGELOG_BODY = "_Nothing yet._";

/** The version `npm version <part>` will produce, known before anything is written. */
export function nextVersion(version: string, part: VersionPart): string {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version: ${version}`);
    const [major, minor, patch] = version.split(".").map(Number) as [number, number, number];
    if (part === "major") return `${major + 1}.0.0`;
    if (part === "release") return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
}

export type ChangelogPlan = {
    /** What is currently written under the Unreleased heading, "" when nothing is. */
    entries: string;
    /** The changelog as it should read once this version is released. */
    promote(version: string, date: string): string;
};

/**
 * Reads the Unreleased section. Releasing renames it to the new version and
 * seeds an empty Unreleased section above it, so the changelog cannot silently
 * fall behind the tags.
 */
export function planChangelog(text: string): ChangelogPlan {
    const start = text.indexOf(UNRELEASED_HEADING);
    if (start === -1) {
        throw new Error(`CHANGELOG.md has no ${UNRELEASED_HEADING} section to release.`);
    }
    const bodyStart = start + UNRELEASED_HEADING.length;
    const nextHeading = text.indexOf("\n## ", bodyStart);
    const body = (nextHeading === -1 ? text.slice(bodyStart) : text.slice(bodyStart, nextHeading)).trim();
    const rest = nextHeading === -1 ? "" : text.slice(nextHeading + 1);

    return {
        entries: body === EMPTY_CHANGELOG_BODY ? "" : body,
        promote(version, date) {
            const released = `## ${version} - ${date}\n\n${body || EMPTY_CHANGELOG_BODY}\n`;
            return `${text.slice(0, start)}${UNRELEASED_HEADING}\n\n${EMPTY_CHANGELOG_BODY}\n\n${released}\n${rest}`;
        },
    };
}
