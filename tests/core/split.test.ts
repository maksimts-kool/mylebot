import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Every module a file loads at runtime. Type-only imports are erased by the
 * compiler, so they are left out: a bot module may name a row's type without
 * ever loading the code that reads it.
 */
function runtimeImports(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /^import\s+(?!type\s)[\w*{}\s,$]+?\s+from\s+["']([^"']+)["']/gm,
    /^export\s+(?!type\s)(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/gm,
    /^import\s+["']([^"']+)["']/gm,
    /import\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

/** The project files and packages reachable from `entry` at runtime. */
function reachable(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [resolve(root, entry)];
  while (pending.length) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of runtimeImports(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) {
        packages.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!);
        continue;
      }
      pending.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return { files, packages };
}

describe("the two halves", () => {
  it("never loads the database client, or anything of the server half, in the bot", () => {
    const { files, packages } = reachable("src/bot.ts");
    const loaded = [...files].map((file) => relative(root, file));

    expect(loaded).not.toContain("src/core/db.ts");
    expect(loaded).not.toContain("src/server.ts");
    // A feature's service layer is its server half.
    expect(loaded.filter((file) => /\/service\//.test(file))).toEqual([]);
    for (const name of ["@prisma/client", "@prisma/adapter-pg", "pg"]) expect(packages).not.toContain(name);
  });

  it("keeps Discord out of the server half", () => {
    const { files, packages } = reachable("src/server.ts");
    const loaded = [...files].map((file) => relative(root, file));

    expect(loaded).not.toContain("src/bot.ts");
    expect(loaded.filter((file) => /\/discord\//.test(file))).toEqual([]);
    expect(packages).not.toContain("discord.js");
  });
});
