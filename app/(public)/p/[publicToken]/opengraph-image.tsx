// Branded Open Graph image for the public credential page (task #43
// share-first lost flow). Next's file-convention route: this component
// generates the og:image / twitter:image meta tags for every /p/{token}
// share automatically — no manual `openGraph.images` in generateMetadata
// (page.tsx), which would take precedence over this file and silently
// disable it.
//
// Lost pets get the urgent "SE BUSCA" treatment (spec REQ-5, share-first
// design); active/deceased credentials get the calmer "Credencial pública"
// card so every /p/{token} share still carries a branded preview, not just
// lost ones. Both variants show only Tier-0 data — name, species, photo —
// the same subset the page itself exposes publicly. NO owner PII (name,
// phone, location) ever enters this image, lost or not.
//
// Photo fallback: WhatsApp/Facebook link-preview scrapers fetch this route
// from Vercel, which in turn fetches the pet's photo from the public
// pet-photos Supabase bucket via <img src>. If a pet has no photo, or the
// bucket fetch fails, we fall back to an initial-letter avatar instead of
// erroring the whole image (a broken og:image is worse than a plain one).
//
// Node runtime (not edge): the pet lookup goes through Drizzle +
// postgres-js, which needs a real TCP socket — same constraint as every
// other DB-backed route in this app.
export const runtime = "nodejs";

import { attachments, db, pets } from "@/db";
import { publicPetByToken } from "@/lib/infra/public-pet-lookup";
import { isPublicTokenReadThrottled } from "@/lib/infra/public-token-throttle";
import { petPhotoUrl } from "@/lib/infra/storage";
import { speciesLabel } from "@/lib/utils/format";
import { eq } from "drizzle-orm";
import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "miMAR — credencial pública de mascota";

// Literal hex, not CSS vars: satori (next/og's renderer) has no DOM/CSSOM to
// resolve var(--color-ln-*) against, so it must get literal values. This is
// a deliberate, narrow exception to the project's ln-* token convention —
// grandfathered in scripts/design-tokens-baseline.json (hexStyle: 3) rather
// than exempted from the guard entirely, so any *additional* raw hex added
// here later still fails lint:tokens.
const INK = "#1b2a33";
const MUTE = "#616e77";
const PAPER = "#fbfaf5";
const CARD = "#ffffff";
const AZUL = "#0e5a99";
const CELESTE = "#4e97d1";
const SEAL = "#a23a2c";

export default async function Image({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;

  // THROTTLED THE SAME WAY THE PAGE IS, and this was missing until 2026-08-21.
  //
  // This file is a SEPARATE HTTP request, not part of the page render: Next's
  // file convention publishes it as its own route, and WhatsApp / Facebook /
  // Google fetch it directly. So the guard on page.tsx never covered it, and
  // the coverage fence could not see it either — that test walked `page.tsx`
  // files under this directory, and this is not one.
  //
  // Left open it was the cheapest token oracle in the product: unauthenticated,
  // unthrottled, and it answers "is this animal lost?" through the artwork
  // (SE BUSCA vs Credencial pública). It is also the most expensive read to
  // serve — a 1200×630 satori render on every hit.
  //
  // Its own bucket, deliberately, for the reason the coverage fence states: a
  // scraper hammering link previews must not spend the budget of the person
  // who just found a dog in the street and is loading its credential.
  const throttled = await isPublicTokenReadThrottled("public_token_og_image");

  const [row] = throttled
    ? []
    : await db
        .select({
          name: pets.name,
          species: pets.species,
          status: pets.status,
          photoPath: attachments.storagePath,
        })
        .from(pets)
        .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
        // PO-4: a soft-deleted pet resolves to no row, so the share preview
        // degrades to the generic branded card — the page itself 404s, and a
        // scraper must not keep the erased pet's name alive in a link preview.
        .where(publicPetByToken(publicToken))
        .limit(1);
  // A throttled read renders the SAME generic card an unknown token renders.
  // That is the anti-oracle property and it comes free: every branch below
  // already handles `row === undefined`, so being rate-limited is
  // indistinguishable from asking about a pet that does not exist.

  const name = row?.name ?? "Mascota";
  const isLost = row?.status === "lost";
  const speciesText = row ? speciesLabel(row.species) : "";
  const photoUrl = petPhotoUrl(row?.photoPath ?? undefined);
  const accent = isLost ? SEAL : AZUL;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: PAPER,
        fontFamily: "sans-serif",
      }}
    >
      {/* miMAR guilloché stripe */}
      <div
        style={{
          display: "flex",
          height: 14,
          width: "100%",
          background: `linear-gradient(90deg, ${AZUL}, ${CELESTE})`,
        }}
      />

      <div
        style={{
          display: "flex",
          flex: 1,
          alignItems: "center",
          gap: 56,
          padding: "56px 72px",
        }}
      >
        {/* Photo / initial-letter fallback */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 340,
            height: 340,
            flexShrink: 0,
            borderRadius: 28,
            overflow: "hidden",
            backgroundColor: "#efe9da",
            border: `8px solid ${accent}`,
          }}
        >
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl} width={340} height={340} style={{ objectFit: "cover" }} alt="" />
          ) : (
            <span style={{ fontSize: 150, fontWeight: 700, color: MUTE }}>
              {name.charAt(0).toUpperCase()}
            </span>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          {isLost && (
            <div style={{ display: "flex", marginBottom: 24 }}>
              <span
                style={{
                  display: "flex",
                  fontSize: 30,
                  fontWeight: 700,
                  color: "#ffffff",
                  backgroundColor: SEAL,
                  padding: "10px 28px",
                  borderRadius: 999,
                  letterSpacing: 2,
                }}
              >
                SE BUSCA
              </span>
            </div>
          )}
          <span
            style={{
              display: "flex",
              fontSize: 76,
              fontWeight: 700,
              color: INK,
              lineHeight: 1.05,
            }}
          >
            {name}
          </span>
          {speciesText && (
            <span style={{ display: "flex", fontSize: 34, color: MUTE, marginTop: 18 }}>
              {speciesText}
            </span>
          )}
        </div>
      </div>

      {/* Footer brand bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "22px 72px",
          borderTop: "1px solid #e4dfd0",
          backgroundColor: CARD,
        }}
      >
        <span style={{ display: "flex", fontSize: 30, fontWeight: 700, color: AZUL }}>miMAR</span>
        <span style={{ display: "flex", fontSize: 22, color: MUTE }}>
          Credencial digital de mascotas
        </span>
      </div>
    </div>,
    { ...size },
  );
}
