import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

import { postgresTlsOption } from "./db/tls";

// drizzle-kit runs outside Next.js, so it doesn't auto-load .env.local.
config({ path: ".env.local" });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Did you copy .env.local.example to .env.local?");
}

// TLS (db/tls.ts): drizzle-kit opens its OWN client, so the app's
// postgresTlsOption never reached it, and postgres.js defaults to plaintext.
// The `{ url }` credential form takes no `ssl`, so the URL is split into the
// host form, which does; drizzle-kit spreads it into postgres.js as-is
// (`postgres({ ...credentials, max: 1 })`, the driver it picks because `pg`
// is not installed). Same rule as every app client: "require" off loopback.
const url = new URL(process.env.DATABASE_URL);

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1) || "postgres",
    ssl: postgresTlsOption(process.env.DATABASE_URL),
  },
  verbose: true,
  // Strict mode prompts for confirmation before applying changes. In CI there's
  // no stdin, so the prompt hangs until the job timeout (~90 min) — see the
  // `Schema vs migrations drift` job in `.github/workflows/ci.yml`. Disable
  // strict mode in CI; keep it on locally so devs are warned before pushes.
  strict: process.env.CI !== "true",
});
