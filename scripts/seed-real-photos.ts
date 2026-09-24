/**
 * Wire real pet photos — dev/QA tool.
 *
 * Reads image files from scripts/assets/pet-photos-real/ named
 * `<public_token>.<jpg|jpeg|png|webp>`, center-crops + resizes each to
 * 1024x1024 JPEG, uploads it to the `pet-photos` Storage bucket, inserts an
 * attachments row, and points `pets.primary_photo_id` at it — replacing any
 * generated placeholder from seed-demo-polish / seed-pet-photos.
 *
 * Run with:
 *   pnpm seed:real-photos
 *
 * Idempotent: re-running re-uploads (upsert) and re-points. Unknown tokens
 * are logged and skipped. See scripts/assets/pet-photos-real/README.md.
 *
 * Mirrors scripts/seed-demo-polish.ts conventions: dotenv before db imports,
 * local-only guards, own postgres-js client (runs under plain `tsx` — the
 * server-only stub loader combo swallows stdout on Windows).
 */

// ---------------------------------------------------------------------------
// 1. Env bootstrap + safety guards (must run before any db import)
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
  console.error("Refusing to seed: Supabase or DATABASE_URL is not local.");
  process.exit(2);
}

type LogTag = "STEP" | "OK" | "SKIP" | "WARN" | "FAIL";
function log(tag: LogTag, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${tag.padEnd(4)}] ${msg}`);
}

const PHOTOS_DIR = "scripts/assets/pet-photos-real";
const PET_PHOTOS_BUCKET = "pet-photos";
const EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

async function main(): Promise<void> {
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const { extname, basename, join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const { createClient } = await import("@supabase/supabase-js");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const { eq, inArray } = await import("drizzle-orm");
  const sharp = (await import("sharp")).default;
  const schema = await import("../db/schema");

  if (!existsSync(PHOTOS_DIR)) {
    log("FAIL", `${PHOTOS_DIR} does not exist — nothing to wire.`);
    process.exit(1);
  }

  const files = readdirSync(PHOTOS_DIR).filter((f) => EXTENSIONS.has(extname(f).toLowerCase()));
  if (files.length === 0) {
    log("SKIP", `No image files in ${PHOTOS_DIR} — drop <public_token>.jpg files first.`);
    process.exit(0);
  }
  log("STEP", `Found ${files.length} image file(s) in ${PHOTOS_DIR}.`);

  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const tokens = files.map((f) => basename(f, extname(f)));
  const petRows = await db
    .select({ id: schema.pets.id, publicToken: schema.pets.publicToken, name: schema.pets.name })
    .from(schema.pets)
    .where(inArray(schema.pets.publicToken, tokens));
  const petByToken = new Map(petRows.map((p) => [p.publicToken, p]));

  let wired = 0;
  for (const file of files) {
    const token = basename(file, extname(file));
    const pet = petByToken.get(token);
    if (!pet) {
      log("WARN", `${file}: no pet with public_token=${token} — skipped.`);
      continue;
    }

    const raw = readFileSync(join(PHOTOS_DIR, file));
    const jpeg = await sharp(raw)
      .rotate() // honor EXIF orientation from phone cameras
      .resize(1024, 1024, { fit: "cover", position: "attention" })
      .jpeg({ quality: 85 })
      .toBuffer();

    const storagePath = `${pet.id}/${randomUUID()}.jpg`;
    const { error: uploadError } = await supabase.storage
      .from(PET_PHOTOS_BUCKET)
      .upload(storagePath, jpeg, { contentType: "image/jpeg", upsert: true });
    if (uploadError) {
      log("FAIL", `${file}: upload failed — ${uploadError.message}`);
      continue;
    }

    const [attachment] = await db
      .insert(schema.attachments)
      .values({
        petId: pet.id,
        storagePath,
        mimeType: "image/jpeg",
        fileSize: jpeg.byteLength,
      })
      .returning({ id: schema.attachments.id });

    await db
      .update(schema.pets)
      .set({ primaryPhotoId: attachment.id })
      .where(eq(schema.pets.id, pet.id));

    wired += 1;
    log("OK", `${pet.name} (${token}) → ${storagePath}`);
  }

  log("STEP", `Done: ${wired}/${files.length} photo(s) wired.`);
  await sql.end();
}

main().catch((err) => {
  console.error("[FAIL]", err);
  process.exit(1);
});
