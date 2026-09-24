import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside Next.js, so it doesn't auto-load .env.local.
config({ path: ".env.local" });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Did you copy .env.local.example to .env.local?");
}

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  verbose: true,
  // Strict mode prompts for confirmation before applying changes. In CI there's
  // no stdin, so the prompt hangs until the job timeout (~90 min) — see the
  // `Schema vs migrations drift` job in `.github/workflows/ci.yml`. Disable
  // strict mode in CI; keep it on locally so devs are warned before pushes.
  strict: process.env.CI !== "true",
});
