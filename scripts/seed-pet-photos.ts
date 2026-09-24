/**
 * Seed placeholder photos for the QA owner's pets — dev/QA tool.
 *
 * Run with:
 *   pnpm seed:pet-photos
 *
 * What this does:
 *   Firulais / Michi / Atún (owner@dim.test) shipped with `primary_photo_id
 *   IS NULL` — the pet-profile two-face redesign surfaces the photo on
 *   Face 1's LnHero, so QA/demo runs looked bare. This generates one
 *   distinct 640x640 PNG per pet (solid warm background + the pet's
 *   initial, rasterized from an inline SVG via `sharp`), uploads it to the
 *   `pet-photos` Storage bucket (the SAME public bucket `petPhotoUrl()` /
 *   the real photo-upload path in src/modules/pets/actions.ts read from —
 *   NOT the demo-only `seed-photos` bucket seed-demo.ts uses), inserts an
 *   `attachments` row, and points `pets.primary_photo_id` at it.
 *
 * Idempotent: a pet that already has `primary_photo_id` set is skipped.
 *
 * Mirrors scripts/seed-demo.ts conventions:
 *   - dotenv loaded BEFORE any heavy import that touches DATABASE_URL.
 *   - Local-only safety guard (refuses non-local Supabase / NODE_ENV=production).
 *   - log("STEP" | "OK" | "SKIP" | "WARN" | "FAIL", msg).
 */

// ---------------------------------------------------------------------------
// 1. Env bootstrap + safety guards (must run before db/index.ts imports)
// ---------------------------------------------------------------------------

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const isLocalUrl = (u: string) => u.includes("127.0.0.1") || u.includes("localhost");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local — aborting.",
  );
  process.exit(2);
}
if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed: NODE_ENV=production.");
  process.exit(2);
}
if (!isLocalUrl(SUPABASE_URL) || !isLocalUrl(DATABASE_URL)) {
  console.error(
    `Refusing to seed: NEXT_PUBLIC_SUPABASE_URL (${SUPABASE_URL}) or DATABASE_URL is not local.`,
  );
  process.exit(2);
}

type LogTag = "STEP" | "OK" | "SKIP" | "WARN" | "FAIL";
function log(tag: LogTag, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${tag.padEnd(4)}] ${msg}`);
}

const PET_PHOTOS_BUCKET = "pet-photos";
const OWNER_EMAIL = "owner@dim.test";

// One warm, distinct background per pet — deliberately NOT the ln-* design
// tokens (this is a placeholder QA asset, not product UI).
const TARGET_PETS: Array<{ publicToken: string; bgColor: string }> = [
  { publicToken: "DIM-9HAK-D5Z4", bgColor: "#D97757" }, // Firulais — terracotta
  { publicToken: "DIM-4SUZ-U2HT", bgColor: "#E8A33D" }, // Michi — amber
  { publicToken: "DIM-VT3V-SEA3", bgColor: "#C15B4A" }, // Atún — coral
];

function placeholderSvg(initial: string, bgColor: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">
    <rect width="640" height="640" fill="${bgColor}"/>
    <text
      x="320" y="410"
      font-family="Georgia, 'Times New Roman', serif"
      font-size="300"
      font-weight="600"
      fill="#ffffff"
      text-anchor="middle"
    >${initial}</text>
  </svg>`;
}

async function findAuthUserIdByEmail(supabase: any, email: string): Promise<string | null> {
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message ?? "(no message)"}`);
    const hit = data.users.find((u: any) => u.email === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
    page += 1;
  }
}

async function main(): Promise<void> {
  const { createClient: createSdkClient } = await import("@supabase/supabase-js");
  const { eq } = await import("drizzle-orm");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const sharp = (await import("sharp")).default;
  const { randomUUID } = await import("node:crypto");
  // Import the schema directly (relative path) instead of "@/db" — the "@/db"
  // barrel pulls in the `server-only` sentinel (db/index.ts), which is meant
  // to guard Next.js server/client bundle boundaries and has no meaning for a
  // standalone script. Building our own drizzle client here avoids needing
  // the server-only stub hook that scripts/seed-demo.ts et al. require.
  const schema = await import("../db/schema");
  const { pets, attachments } = schema;

  const supabase = createSdkClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const client = postgres(DATABASE_URL, { prepare: false });
  const db = drizzle(client, { schema });

  log("STEP", `Resolving owner user id for ${OWNER_EMAIL}`);
  const ownerUserId = await findAuthUserIdByEmail(supabase, OWNER_EMAIL);
  if (!ownerUserId) {
    log("FAIL", `No auth user found for ${OWNER_EMAIL} — aborting.`);
    process.exit(1);
  }
  log("OK", `owner user id: ${ownerUserId}`);

  for (const target of TARGET_PETS) {
    log("STEP", `Pet ${target.publicToken}`);
    const [pet] = await db
      .select({ id: pets.id, name: pets.name, primaryPhotoId: pets.primaryPhotoId })
      .from(pets)
      .where(eq(pets.publicToken, target.publicToken))
      .limit(1);

    if (!pet) {
      log("WARN", `pet ${target.publicToken} not found — skipping.`);
      continue;
    }

    if (pet.primaryPhotoId) {
      log("SKIP", `${pet.name} (${target.publicToken}) already has a primary photo.`);
      continue;
    }

    const initial = pet.name.charAt(0).toUpperCase();
    const svg = placeholderSvg(initial, target.bgColor);
    const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();

    const storagePath = `${randomUUID()}.png`;
    const { error: uploadError } = await supabase.storage
      .from(PET_PHOTOS_BUCKET)
      .upload(storagePath, pngBuffer, { contentType: "image/png" });
    if (uploadError) {
      log("FAIL", `upload failed for ${pet.name}: ${uploadError.message}`);
      continue;
    }

    const [attachment] = await db
      .insert(attachments)
      .values({
        petId: pet.id,
        uploadedByUserId: ownerUserId,
        storagePath,
        mimeType: "image/png",
        fileSize: pngBuffer.length,
      })
      .returning({ id: attachments.id });

    await db.update(pets).set({ primaryPhotoId: attachment.id }).where(eq(pets.id, pet.id));

    log("OK", `${pet.name} (${target.publicToken}) → ${storagePath}`);
  }

  log("OK", "Done.");
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
