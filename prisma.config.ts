import { defineConfig } from "prisma/config";

// Local CLI commands (migrate, studio) read the connection URL from .env;
// CI (generate) and production (migrate deploy) provide DATABASE_URL through
// the ambient environment instead.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file present — fall back to the ambient environment.
}

const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  // Only declare the datasource when a URL is available; `generate` runs in CI
  // without one and must not fail resolving it.
  ...(url ? { datasource: { url } } : {}),
});
