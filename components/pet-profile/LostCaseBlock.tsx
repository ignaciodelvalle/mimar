// LostCaseBlock — the lost-pet case surface relocated INTO the normal pet
// profile (pet-document-redesign S2, design ADR-6/ADR-7). Replaces the old
// full-screen LostCockpit early-return: renders as the urgent (top) item of
// PetAlertStrip when an open lost_pet_episode exists, absorbing all 9
// capabilities from spec REQ-5.2 while the rest of the profile (Credencial,
// Libreta, action row, Anotar sheet) stays reachable at the same time
// (cap 8 — enforced simply by NOT early-returning; see page.tsx).
//
// Lean pass (task #43, 2026-07-04, Cursor audit #735): the owner body was a
// 5-section/9-capability grid with share buried in a 4-up button row and
// double card chrome (LnCardHead title + the child's own <section> heading).
// Now: a SHARE-FIRST strip (WhatsApp hero CTA, one-line last-seen summary)
// with everything else — the 5 disclosure toggles, the full last-seen card
// (map), the scan/sightings feed — behind a native "Más opciones" <details>.
// Native details/summary (not a client Sheet) because this stays a plain
// Server Component (see DEVIATION note below) — no client state needed to
// disclose it, and prefers-reduced-motion is handled globally already
// (app/globals.css collapses all transition-duration to 0.01ms).
//
// All 9 capabilities (unchanged, just regrouped):
//   1. Urgent-treatment header — publicCode + /casos/[publicCode] link +
//      public /p/{token} link.
//   2. Marcar encontrada — owner-only. PO 2026-07-05: surfaced as a PROMINENT
//      primary CTA leading the owner body ("¡Apareció! Marcar como
//      encontrada", ?sheet=marcar-encontrada). This is now the SINGLE found
//      affordance — PetActionRow dropped its found slot for lost pets, so
//      there is no duplication.
//   3. Last-seen + update — owner: a one-line summary (place · locality ·
//      date) with a single "actualizar" link in the primary strip; the full
//      LostLastSeenCard (map + caption, flat section since the QA 2026-08-03
//      redesign) lives in "Más opciones". Org: plain read-only summary, no
//      edit affordance (LostLastSeenCard always renders an edit link, so org
//      gets a simpler inline summary instead of that component).
//   4. Scans/sightings/finder feed — LostScanFeed, visible to both roles;
//      owner: inside "Más opciones"; org: always visible (no toggle to hide
//      behind for a role that has no share/toggle content anyway).
//   5. 5 disclosure toggles + public preview — LostDisclosureCard, owner-only,
//      inside "Más opciones".
//   6. Share + poster — LostShareCard (WhatsApp hero + copy-link + Afiche),
//      owner-only, in the primary strip. Rendered directly — no LnCard
//      wrapper — since LostShareCard already renders its own <section>.
//   7. MarkLostWizard capture (update) — reachable via cap 3's "actualizar"
//      link; unchanged wizard.
//   8. Rest of profile usable simultaneously — satisfied structurally (no
//      early return anywhere in the tree that renders this block).
//   9. Single rendering path — lost_pet_episode is excluded from the generic
//      PetOpenCasesSection query (REQ-1.4 / ADR-8, lib/infra/case-queries.ts).
//
// Org viewers (REQ-5.3): informational only — header (no Marcar encontrada),
// last-seen summary (no edit), scans/sightings feed. No toggles, no share/
// poster, no MarkLostWizard entry point.
//
// DEVIATION from design.md's file-map ("(client)"): this is a plain Server
// Component, not "use client". Originally this was ALSO because
// LostDisclosureCard's toggle rows were inline
// `<form action={async () => { "use server"; ... }}>` closures — Next.js
// forbids declaring an inline server action inside a Client Component's
// subtree (it must be a Server Component, or the action must be pre-bound
// and passed down as a prop). wave-3 D2 moved LostDisclosureCard to
// LnToggleGroup (now "use client" itself, calling the pre-bound
// `toggleAction` prop directly — the "pre-bound and passed as a prop"
// alternative this comment already named) — that reason is gone, but
// LostScanFeed still transitively imports lib/infra/lost-mode → @/db,
// which is guarded by `import "server-only"` and errors if pulled into a
// client bundle. A Server Component here still matches how the original
// LostCockpit was architected (async RSC composing "use client"
// subcomponents is fine). No behavior change: this component still never
// uses hooks/state itself, so staying a Server Component costs nothing.

import Image from "next/image";
import Link from "next/link";

import { setPetDisclosurePrefsAction } from "@/app/actions/lost-mode";
import { reactivateLostSearchAction } from "@/app/actions/reactivate-lost-search";
import { Icon } from "@/components/Icon";
import {
  type DisclosurePrefs,
  LostDisclosureCard,
} from "@/components/pet-profile/LostDisclosureCard";
import { LostLastSeenCard } from "@/components/pet-profile/LostLastSeenCard";
import {
  LostScanFeed,
  type ReportFeedItemAction,
  type ScanFeedItem,
} from "@/components/pet-profile/LostScanFeed";
import { LostShareCard } from "@/components/pet-profile/LostShareCard";
import { MarkFoundInlineForm } from "@/components/pet-profile/MarkFoundInlineForm";
import { SheetTriggerLink } from "@/components/pet-profile/SheetTriggerLink";
import { LnAlert } from "@/components/ui/Alert";
import type { LostEpisode } from "@/lib/infra/lost-mode";
import { credentialQrUrl } from "@/lib/infra/site-url";
import { formatDateShort, foundParticiple, lostThirdPersonPhrase } from "@/lib/utils/format";
import { reportLostFeedItemAction } from "@/src/modules/events/actions";

export type LostCaseBlockPet = {
  id: string;
  name: string;
  publicToken: string;
  sex: string | null;
  discloseFirstNameWhenLost: boolean;
  disclosePhoneWhenLost: boolean;
  discloseEmailWhenLost: boolean;
  discloseLastLocationWhenLost: boolean;
  allowFinderFormWhenLost: boolean;
  /** KEY 1 of the two-key public-contact model (migration 0193). */
  discloseCaretakerContactWhenLost: boolean;
};

type Props = {
  pet: LostCaseBlockPet;
  photoUrl: string | null;
  episode: LostEpisode | null;
  scans: ScanFeedItem[];
  ownerFirstName: string;
  /**
   * A5 — the pet has an origin shelter, so a found-pet report also alerts it.
   * Resolved server-side with the notifier's own predicate
   * (lib/infra/origin-shelter-alert.ts) and disclosed inside LostDisclosureCard.
   */
  alertsOriginShelter: boolean;
  /** Owner-gate — org/vet viewers get the read-only variant (REQ-5.3). */
  isOwner: boolean;
  /**
   * Whether this viewer may change the TITULAR's lost-mode disclosure choices.
   *
   * SEPARATE FROM `isOwner`, and that separation is the point. A `caretaker`
   * holds a Path-1 ownership row, so `isOwner` is true for them and they
   * correctly get the owner variant of this block — marking the animal found is
   * explicitly one of their allowed actions. But the owner variant also carries
   * "Qué se muestra al público", which governs the TITULAR's own name, phone,
   * email and last-known location. Those are not the caretaker's to publish.
   *
   * REQUIRED, never defaulted. A prop that defaults to `true` fails open the day
   * somebody adds a second call site, and this one guards another person's PII.
   */
  canManageDisclosure: boolean;
  /**
   * KEY 2 of the two-key public-contact model: the active caretaker's display
   * name IF they consented at invitation accept, null otherwise. Null hides the
   * sixth disclosure row entirely — see LostDisclosureCard.
   */
  caretakerConsentName?: string | null;
};

export function LostCaseBlock({
  pet,
  photoUrl,
  episode,
  scans,
  ownerFirstName,
  alertsOriginShelter,
  isOwner,
  canManageDisclosure,
  caretakerConsentName = null,
}: Props) {
  // No open episode while status is still 'lost' — the auto-close cron
  // (ADR-18) never resets pets.status, so this is the STALE state, not the
  // absence of a lost pet. The caller (page.tsx) only mounts this block when
  // `pet.status === 'lost'`, so a null episode here unambiguously means the
  // episode auto-closed for inactivity and the search needs a decision.
  if (!episode) {
    return (
      <StaleLostCaseBanner petPublicToken={pet.publicToken} petSex={pet.sex} isOwner={isOwner} />
    );
  }

  const toggleAction = setPetDisclosurePrefsAction.bind(null, pet.publicToken);
  // Bound here and passed ONLY to the holder variant of the feed, never to the
  // org one. The server refuses `report_content` on the org path in BOTH doors —
  // `reportLostFeedItemAction` itself for this web path, and `checkCommandGuard`
  // for the API the phone uses. Naming only the API one, as this comment did for
  // a revision, credits the guard that does NOT protect this call site.
  //
  // WITHHOLDING THE CONTROL HERE IS COSMETIC, NOT THE CONTROL. This action is
  // bound at module level in a component that renders on both variants, so its
  // action id reaches the org client either way and can be POSTed directly. The
  // authorization is the server-side refusal; this line only avoids offering a
  // button that would answer with a refusal — the same thing the disclosure card
  // refuses to do for a caretaker.
  //
  // WHY the refusal exists: the hide is pet-global, so an organization holding
  // custody could otherwise make a finder's "tengo a tu perro" vanish from the
  // owner's own cockpit.
  const reportAction = reportLostFeedItemAction.bind(null, pet.publicToken);

  const prefs: DisclosurePrefs = {
    discloseFirstNameWhenLost: pet.discloseFirstNameWhenLost,
    disclosePhoneWhenLost: pet.disclosePhoneWhenLost,
    discloseEmailWhenLost: pet.discloseEmailWhenLost,
    discloseLastLocationWhenLost: pet.discloseLastLocationWhenLost,
    allowFinderFormWhenLost: pet.allowFinderFormWhenLost,
    discloseCaretakerContactWhenLost: pet.discloseCaretakerContactWhenLost,
  };

  // Single source of truth for the public origin (task #43 audit #735: this
  // used to hardcode "https://mimar.ar", diverging from other pages' guesses
  // like "https://www.mimar.gob.ar"). Re-audited: the raw `?? "http://localhost:3000"`
  // fallback does NOT catch a set-but-EMPTY NEXT_PUBLIC_SITE_URL (`??` only
  // catches null/undefined) — that produced a host-less RELATIVE URL for the
  // share link, the pet's main broadcast channel (the same class of bug
  // credentialQrUrl was built to cure for the credential QR). Routed through
  // the canonical `.trim() || fallback` resolver instead, so this can never
  // regress to an unclickable link.
  const publicUrl = credentialQrUrl(pet.publicToken);
  // Disclosure-aware (fixes audit #735: the prior text claimed to honour
  // disclosure prefs but never actually varied on them) — only names the
  // owner when discloseFirstNameWhenLost is on.
  const shareText = pet.discloseFirstNameWhenLost
    ? `${pet.name} ${lostThirdPersonPhrase(pet.sex)}. Lo busca ${ownerFirstName}. Si la ves, escaneá el QR o avisanos.`
    : `${pet.name} ${lostThirdPersonPhrase(pet.sex)}. Si la ves, escaneá el QR o avisanos.`;
  const posterHref = `/mis-mascotas/${pet.publicToken}/cartel`;
  const publicHref = `/p/${pet.publicToken}`;
  const editLastSeenHref = `/mis-mascotas/${pet.publicToken}/perdida`;
  const caseHref = `/casos/${episode.publicCode}`;

  const sightingsCount = episode.sightingsCount;
  const scanCount = scans.filter((s) => s.kind === "scan").length;

  // Pin-only last-seen record (address null, coords present — e.g. the owner
  // updated with just a map pin): say so instead of "Ubicación no
  // especificada", which contradicts the map shown in LostLastSeenCard and
  // on the public credential (cursor pre-push review 2026-08-03).
  const hasLastSeenPin = episode.lastSeenLat != null && episode.lastSeenLng != null;
  const lastSeenLabel =
    episode.placeName ??
    (hasLastSeenPin ? "Punto marcado en el mapa" : "Ubicación no especificada");

  return (
    <div
      data-section="lost-case-block"
      className="overflow-hidden rounded-md border border-[var(--color-ln-line-strong)]"
    >
      {/* Quiet card head — capability 1 + 2. DEMOTED from the seal→err
          gradient banner (pet-state-header R7.2): the credential masthead band
          now owns the perdida red on BOTH faces, so a second full-red header
          in the body duplicated the signal. Same content, tinted-strip
          treatment. Flagged for PO in the demo — reversible one-file change. */}
      <div
        data-section="lost-case-head"
        className="border-b border-[var(--color-ln-err-100)] bg-[var(--color-ln-err-050)] px-4 py-3.5"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded-full border-2 border-[var(--color-ln-err-100)] bg-[var(--color-ln-card)]">
            {photoUrl ? (
              <Image src={photoUrl} alt={pet.name} fill sizes="40px" className="object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center font-ln-serif text-lg font-bold text-[var(--color-ln-err)]">
                {pet.name.charAt(0).toUpperCase()}
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="m-0 font-ln-serif text-lg font-semibold leading-tight text-[var(--color-ln-err)]">
              {pet.name} {lostThirdPersonPhrase(pet.sex)}
            </p>
            <p className="mt-0.5 text-sm text-[var(--color-ln-ink-2)]">
              <Link
                href={caseHref}
                className="font-ln-mono text-sm tracking-[.02em] text-[var(--color-ln-ink-2)] underline-offset-2 hover:underline"
              >
                {episode.publicCode}
              </Link>
              {" · "}
              <Link
                href={publicHref}
                className="text-[var(--color-ln-ink-2)] underline-offset-2 hover:underline"
              >
                Credencial pública
              </Link>
              {scanCount > 0 && ` · ${scanCount} ${scanCount === 1 ? "escaneo" : "escaneos"}`}
              {sightingsCount > 0 &&
                ` · ${sightingsCount} ${sightingsCount === 1 ? "avistamiento" : "avistamientos"}`}
            </p>
          </div>
          {/* "Marcar como encontrada" lives in the owner body below as a
              prominent primary CTA (PO 2026-07-05) — no longer duplicated in
              PetActionRow (which dropped the found slot for lost pets). */}
        </div>
      </div>

      {/* Body — owner gets the lean share-first strip; org gets the
          unchanged informational-only read (REQ-5.3). */}
      {isOwner ? (
        <div className="p-4" style={{ background: "var(--color-ln-card)" }}>
          {/* Prominent happy-path CTA — capability 2 (PO 2026-07-05: the found
              action was "hard to find" as a small icon). A worried owner looks
              here first, so the "Apareció" primary button leads the block
              (opens ?sheet=marcar-encontrada). This is now the ONLY found
              affordance — PetActionRow no longer carries it. */}
          <SheetTriggerLink
            href={`/mis-mascotas/${pet.publicToken}?sheet=marcar-encontrada`}
            className="ln-found-cta mb-4"
          >
            <Icon name="check" size="sm" decorative />
            Apareció — marcar como {foundParticiple(pet.sex)}
          </SheetTriggerLink>

          {/* Share-first hero — capability 6. Rendered directly (no LnCard
              wrapper): LostShareCard already renders its own <section>, so
              wrapping it in LnCardHead too was the double-chrome the lean
              pass targeted (two headings for one card). */}
          <LostShareCard publicUrl={publicUrl} shareText={shareText} posterHref={posterHref} />

          {/* One-line last-seen summary — capability 3. The rich
              LostLastSeenCard (map, its own copy-link, sightings count)
              moved into "Más opciones" below; this keeps the primary strip
              to a single glanceable line + one edit affordance. */}
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--color-ln-line)] pt-3">
            <p className="m-0 min-w-0 truncate text-sm" style={{ color: "var(--color-ln-ink-2)" }}>
              <span className="font-semibold">{lastSeenLabel}</span>
              <span style={{ color: "var(--color-ln-mute)" }}>
                {" "}
                · {episode.jurisdictionLocality ?? "—"} · {formatDateShort(episode.lastSeenAt)}
              </span>
            </p>
            <Link
              href={editLastSeenHref}
              className="flex-shrink-0 text-sm font-medium text-[var(--color-ln-azul)] no-underline hover:underline"
            >
              actualizar
            </Link>
          </div>

          {/* "Más opciones" — capabilities 4 (full scan/sightings feed), 5
              (disclosure toggles), and the rich last-seen card (map).
              Native <details>, not a client Sheet: this component stays a
              Server Component (see DEVIATION note above), and a disclosure
              widget needs no client state to open/close. Reduced-motion is
              handled globally (app/globals.css collapses all
              transition-duration to 0.01ms), so the arrow rotation is safe
              as-is. */}
          <details className="group mt-3">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-[var(--color-ln-azul)]">
              <span
                aria-hidden="true"
                className="inline-block transition-transform group-open:rotate-90"
              >
                ›
              </span>
              Más opciones
            </summary>

            {/* Flat sections with hairline dividers (QA 2026-08-03 redesign):
                the previous LnCard wrappers stacked card chrome on top of the
                children's own section chrome — boxes inside boxes inside the
                lost-block border. Every child now renders the same flat
                section pattern (serif h3 + small muted icon + mono action on
                the right), matching LostShareCard / LostDisclosureCard. */}
            <div className="mt-4 flex flex-col gap-5">
              <LostLastSeenCard
                placeName={episode.placeName}
                localityLabel={episode.jurisdictionLocality}
                at={episode.lastSeenAt}
                note={episode.ownerNote}
                editHref={editLastSeenHref}
                lastSeenLat={episode.lastSeenLat}
                lastSeenLng={episode.lastSeenLng}
              />

              <div className="border-t border-[var(--color-ln-line-2)] pt-4">
                <ScanFeedSection
                  scans={scans}
                  scanCount={scanCount}
                  sightingsCount={sightingsCount}
                  caseHref={caseHref}
                  reportAction={reportAction}
                />
              </div>

              {canManageDisclosure && (
                <div className="border-t border-[var(--color-ln-line-2)] pt-4">
                  <LostDisclosureCard
                    prefs={prefs}
                    toggleAction={toggleAction}
                    publicHref={publicHref}
                    ownerFirstName={ownerFirstName}
                    alertsOriginShelter={alertsOriginShelter}
                    caretakerConsentName={caretakerConsentName}
                  />
                </div>
              )}
            </div>
          </details>
        </div>
      ) : (
        <div className="flex flex-col gap-5 p-4" style={{ background: "var(--color-ln-card)" }}>
          {/* Read-only last-seen summary (REQ-5.3: no edit affordance) — same
              flat section pattern as the owner variant. */}
          <section aria-labelledby="lp-loc-org-h">
            <h3
              id="lp-loc-org-h"
              className="m-0 mb-2 flex items-center gap-1.5 font-ln-serif text-md font-semibold"
              style={{ color: "var(--color-ln-ink)" }}
            >
              <span className="text-[var(--color-ln-mute)]">
                <Icon name="ubicacion" size="sm" decorative />
              </span>
              Última vez visto
            </h3>
            <p className="m-0 text-sm" style={{ color: "var(--color-ln-ink-2)" }}>
              <span className="font-semibold">{lastSeenLabel}</span>
              <span style={{ color: "var(--color-ln-mute)" }}>
                {" "}
                · {episode.jurisdictionLocality ?? "—"} · {formatDateShort(episode.lastSeenAt)}
              </span>
            </p>
            {episode.ownerNote && (
              <p className="mt-1 text-sm italic" style={{ color: "var(--color-ln-mute)" }}>
                "{episode.ownerNote}"
              </p>
            )}
          </section>

          {/* Avistamientos y escaneos — capability 4, visible to both roles */}
          <div className="border-t border-[var(--color-ln-line-2)] pt-4">
            {/* NO `reportAction`: the org path may not report. The prop is
                optional precisely so a surface can decline to offer it. */}
            <ScanFeedSection
              scans={scans}
              scanCount={scanCount}
              sightingsCount={sightingsCount}
              caseHref={caseHref}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScanFeedSection — flat "Avistamientos y escaneos" section, shared by the
// owner ("Más opciones") and org (always-visible) variants. Same section
// header pattern as LostLastSeenCard / LostDisclosureCard.
// ---------------------------------------------------------------------------

function ScanFeedSection({
  scans,
  scanCount,
  sightingsCount,
  caseHref,
  reportAction,
}: {
  scans: ScanFeedItem[];
  scanCount: number;
  sightingsCount: number;
  caseHref: string;
  /** Omitted by the ORG variant — the org path may not report. */
  reportAction?: ReportFeedItemAction;
}) {
  return (
    <section aria-labelledby="lp-feed-h">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3
          id="lp-feed-h"
          className="m-0 flex items-center gap-1.5 font-ln-serif text-md font-semibold"
          style={{ color: "var(--color-ln-ink)" }}
        >
          <span className="text-[var(--color-ln-mute)]">
            <Icon name="ojo" size="sm" decorative />
          </span>
          Avistamientos y escaneos
        </h3>
        <Link
          href={caseHref}
          className="font-ln-mono text-xs tracking-[.04em] no-underline hover:underline"
          style={{ color: "var(--color-ln-azul)" }}
        >
          Ver caso →
        </Link>
      </div>
      <LostScanFeed
        items={scans}
        totalScans={scanCount}
        totalSightings={sightingsCount}
        reportAction={reportAction}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// StaleLostCaseBanner — the case auto-closed for inactivity (ADR-18) but
// pets.status is still 'lost'. Two CTAs for the owner: reopen a fresh
// episode, or confirm the pet was found. Org viewers get an informational
// read-only banner (same parity model as the main block).
// ---------------------------------------------------------------------------

function StaleLostCaseBanner({
  petPublicToken,
  petSex,
  isOwner,
}: {
  petPublicToken: string;
  petSex: string | null;
  isOwner: boolean;
}) {
  const reactivateAction = reactivateLostSearchAction.bind(null, petPublicToken);

  return (
    <div data-section="lost-case-block" data-lost-case-variant="stale">
      <LnAlert variant="warning" title="Búsqueda cerrada por inactividad">
        <p className="m-0">
          Pasó más de un año desde que se abrió el caso y no hubo novedades en los últimos 60 días,
          así que se cerró automáticamente. La mascota sigue marcada como perdida.
        </p>
        {isOwner && (
          <div className="mt-3 flex flex-wrap gap-2">
            <form action={reactivateAction}>
              <button
                type="submit"
                className="inline-flex min-h-11 items-center justify-center rounded-full border-[3px] border-[var(--color-ln-warn-100)] bg-[var(--color-ln-card)] px-4 text-sm font-semibold text-[var(--color-ln-warn)] transition-colors hover:bg-white"
              >
                Reactivar búsqueda
              </button>
            </form>
            <MarkFoundInlineForm
              petPublicToken={petPublicToken}
              label={`Apareció · marcar ${foundParticiple(petSex)}`}
            />
          </div>
        )}
      </LnAlert>
    </div>
  );
}
