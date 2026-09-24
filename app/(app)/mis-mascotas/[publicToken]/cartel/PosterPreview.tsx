"use client";

// PosterPreview — A4 printable lost-pet poster.
//
// Controls (no-print): print button, B&W toggle, back link. When the pet has
// no photo, a strong pre-print warning renders in the controls area (a poster
// without a photo loses most of its value — tester fix #3b) and the print CTA
// is demoted to secondary styling. Printing is never blocked.
// Poster body: sex-correct PERDIDO/PERDIDA (or SE BUSCA) header, photo,
// identity, optional location, inline-editable extra text, QR, miMAR footer.
// All inline-editable fields are local state only — they never persist.

import { AR_TIME_ZONE, lastSeenHeadingLabel, lostPosterHeadline } from "@/lib/utils/format";
import Link from "next/link";
import { useState } from "react";

export type PosterPreviewProps = {
  publicToken: string;
  petName: string;
  species: string;
  breed: string | null;
  /** DISPLAY label ("Macho"/"Hembra") — rendered in the identity line. */
  sex: string;
  /** Raw sex enum ('male' | 'female' | 'unknown') — drives the headline. */
  sexRaw: string | null;
  age: string | null;
  color: string | null;
  distinguishingFeatures: string | null;
  photoUrl: string | null;
  // Lost episode
  placeName: string | null;
  /**
   * The date printed next to "Vista por última vez" — the LAST-SEEN date
   * (episode.lastSeenAt), not the mark-lost date. Renamed from `lostSince`
   * (fresh-review F3): after an owner location update the poster printed the
   * new address with the old date.
   */
  lastSeenAt: Date | null;
  // Owner contact — already filtered by disclosure prefs (null = not disclosed)
  ownerFirstName: string | null;
  ownerPhone: string | null;
  // Location disclosure gate applied before passing — null = not disclosed
  locationDisclosed: boolean;
  // Server-generated QR SVG string
  qrSvg: string;
};

export function PosterPreview({
  publicToken,
  petName,
  species,
  breed,
  sex,
  sexRaw,
  age,
  color,
  distinguishingFeatures,
  photoUrl,
  placeName,
  lastSeenAt,
  ownerFirstName,
  ownerPhone,
  locationDisclosed,
  qrSvg,
}: PosterPreviewProps) {
  const [grayscale, setGrayscale] = useState(false);
  const [extraText, setExtraText] = useState("");

  const identityParts = [species, breed, sex, age].filter(Boolean).join(" · ");

  const lastSeenLabel = lastSeenAt
    ? lastSeenAt.toLocaleDateString("es-AR", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: AR_TIME_ZONE,
      })
    : null;

  return (
    <>
      {/* @page rule scoped to this component's mount lifetime so it is removed
          on client-side navigation and does not leak to other routes (e.g. libreta). */}
      <style>{"@page { size: A4 portrait; margin: 1cm; }"}</style>

      {/* ── Print controls (hidden when printing) ── */}
      <header className="no-print print:hidden bg-[var(--color-ln-card)] border-b border-[var(--color-ln-line)] py-4 px-6 flex flex-wrap items-center gap-3 mb-6">
        <Link
          href={`/mis-mascotas/${publicToken}`}
          className="text-sm text-[var(--color-ln-ink-2)] underline underline-offset-4 hover:text-[var(--color-ln-ink)] mr-auto"
        >
          ← Volver al perfil de {petName}
        </Link>

        <button
          type="button"
          onClick={() => setGrayscale((v) => !v)}
          className="px-3 py-1.5 text-sm rounded-[var(--radius-pill)] border border-[var(--color-ln-line)] text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)] transition-colors"
        >
          {grayscale ? "Versión color" : "Versión blanco y negro"}
        </button>

        <button
          type="button"
          onClick={() => window.print()}
          className={
            photoUrl
              ? "px-4 py-2 text-sm font-medium rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white hover:bg-[var(--color-ln-azul-700)] transition-colors"
              : // Demoted (secondary) when there is no photo — the warning below
                // is the primary message. Printing is still possible.
                "px-4 py-2 text-sm font-medium rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] text-[var(--color-ln-ink-2)] hover:bg-[var(--color-ln-stripe)] transition-colors"
          }
        >
          Imprimir cartel
        </button>

        {/* Pre-print warning — a cartel without a photo barely works (tester
            fix #3b). Full-width row under the controls; hidden when printing. */}
        {!photoUrl && (
          <p
            role="alert"
            className="w-full basis-full rounded-[var(--radius-sm)] border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] px-3 py-2 text-sm text-[var(--color-ln-warn)]"
          >
            Sin foto, el cartel pierde casi todo su valor — agregá una antes de imprimir.{" "}
            <Link
              href={`/mis-mascotas/${publicToken}?sheet=editar-mascota`}
              className="font-semibold underline underline-offset-2"
            >
              Agregar foto
            </Link>
          </p>
        )}
      </header>

      {/* ── A4 poster ── */}
      <main
        className={`mx-auto w-[210mm] min-h-[297mm] bg-white p-[1cm] space-y-4 print:w-full print:min-h-screen print:p-0 print:space-y-3${grayscale ? " print:grayscale" : ""}`}
        data-testid="poster-body"
      >
        {/* Headline banner — sex-correct PERDIDO/PERDIDA; SE BUSCA when the
            sex is not recorded (never a slashed headline on a street poster). */}
        <div className="bg-[var(--color-ln-seal)] text-white text-center py-3 rounded-[var(--radius-sm)]">
          <p className="text-4xl font-black tracking-widest uppercase">
            {lostPosterHeadline(sexRaw)}
          </p>
        </div>

        {/* Photo */}
        <div className="flex justify-center">
          {photoUrl ? (
            <img
              src={photoUrl}
              alt={petName}
              className="w-56 h-56 object-cover rounded-2xl ring-4 ring-[var(--color-ln-seal)] shadow-lg"
            />
          ) : (
            <div className="w-56 h-56 rounded-2xl bg-[var(--color-ln-stripe)] flex items-center justify-center text-6xl font-bold text-[var(--color-ln-mute)] ring-4 ring-[var(--color-ln-seal)] shadow-lg">
              {petName.charAt(0).toUpperCase()}
            </div>
          )}
        </div>

        {/* Pet name */}
        <h1 className="text-center text-4xl font-black tracking-tight text-[var(--color-ln-ink)]">
          {petName}
        </h1>

        {/* Identity line */}
        {identityParts && (
          <p className="text-center text-base text-[var(--color-ln-ink-2)]">{identityParts}</p>
        )}

        {/* Color */}
        {color && (
          <p className="text-sm text-[var(--color-ln-ink)]">
            <span className="font-semibold">Color:</span> {color}
          </p>
        )}

        {/* Distinguishing features */}
        {distinguishingFeatures && (
          <p className="text-sm text-[var(--color-ln-ink)]">
            <span className="font-semibold">Señas:</span> {distinguishingFeatures}
          </p>
        )}

        {/* Last seen (gated by disclosure pref) */}
        {locationDisclosed && (placeName || lastSeenLabel) && (
          <div className="text-sm text-[var(--color-ln-ink)] space-y-0.5">
            {placeName && (
              <p>
                <span className="font-semibold">{lastSeenHeadingLabel(sexRaw)}:</span> {placeName}
              </p>
            )}
            {lastSeenLabel && (
              <p>
                <span className="font-semibold">Fecha:</span> {lastSeenLabel}
              </p>
            )}
          </div>
        )}

        {/* Owner contact */}
        {(ownerFirstName || ownerPhone) && (
          <div className="text-sm text-[var(--color-ln-ink)] space-y-0.5">
            <p className="font-semibold">Contacto:</p>
            {ownerFirstName && ownerPhone && (
              <p>
                {ownerFirstName} · {ownerPhone}
              </p>
            )}
            {ownerFirstName && !ownerPhone && <p>{ownerFirstName}</p>}
            {!ownerFirstName && ownerPhone && <p>{ownerPhone}</p>}
          </div>
        )}

        {/* QR code */}
        <div className="flex flex-col items-center gap-2 pt-2">
          <div
            className="w-36 h-36 p-1 bg-white rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered SVG from qrcode lib
            dangerouslySetInnerHTML={{ __html: qrSvg }}
            data-testid="qr-container"
          />
          <p className="text-xs text-[var(--color-ln-ink-2)] text-center">Escaneá para más info</p>
        </div>

        {/* Extra text — inline-editable, local state only */}
        <div className="border border-dashed border-[var(--color-ln-line)] rounded-[var(--radius-sm)] p-3">
          <textarea
            value={extraText}
            onChange={(e) => setExtraText(e.target.value)}
            placeholder="Información adicional (opcional — solo visible en este cartel)"
            rows={2}
            className="w-full text-sm text-[var(--color-ln-ink)] bg-transparent resize-none placeholder:text-[var(--color-ln-mute)]"
          />
        </div>

        {/* Footer */}
        <footer className="text-center pt-4 border-t border-[var(--color-ln-line)]">
          <p className="text-xs text-[var(--color-ln-mute)] uppercase tracking-widest">
            miMAR · Documento de Identificación para Mascotas
          </p>
        </footer>
      </main>
    </>
  );
}
