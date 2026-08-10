import { readFileSync, writeFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
  throw new Error("package.json contains an invalid version");
}

const target = new URL("../src/core/version.ts", import.meta.url);
writeFileSync(target, `// Updated by scripts/sync-version.ts during \`npm version\`.\nexport const APP_VERSION = ${JSON.stringify(packageJson.version)};\n`);
