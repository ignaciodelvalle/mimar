// CredentialFace — the FRONT of the pet profile's one-document credential
// ("Una sola libreta" redesign; server component). Everything below the blue
// band (which DocumentChrome renders around this face) lives here as one framed
// sheet, bound by labeled hairline dividers so it reads as a single credential
// rather than a stack of panels:
//
//   Identity row (photo overlapping the band · name + "Registrada" badge ·
//     "Macho · Perro" · location chip · public-credential QR)
//   — Cumplimiento —  ComplianceObligationsPanel (bare) + ppp/service-dog rows
//   — Avisos —        the prioritized alert strip (only when non-empty)
//   — Anotar —        the embedded free-text capture (owner + active only)
//   — (actions) —     the icon action row
//
// H1 (provenance gate): the compliance grid is ComplianceObligationsPanel,
// re-hosted verbatim — its `tone: "ok"` only ever comes from
// deriveComplianceState, which requires a professional/institutional-verified
// event. This component does not derive compliance itself.
//
// Org-path viewers receive the exact same read-only object — the caller passes
// `anotar={null}` and an org-scoped `actions` node (no capture, no ⋯ Más), so
// this face never grows an owner-only affordance on its own.

import Link from "next/link";
import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { ComplianceObligationsPanel } from "@/components/pet-profile/ComplianceObligationsPanel";
import { DiscList, DiscRow } from "@/components/pet-profile/DiscList";
import { FirstStepsChecklist } from "@/components/pet-profile/FirstStepsChecklist";
import { LnAlert } from "@/components/ui/Alert";
import { CredentialQr } from "@/components/ui/CredentialQr";
import type { LnHeroProps } from "@/components/ui/Hero";
import { LnMemorialChip, LnVstamp } from "@/components/ui/StatusFlag";
import type { FirstStepItem } from "@/lib/projections/first-steps-checklist";
import type { ComplianceState } from "@/lib/projections/pet-compliance";
import type { PetSituation } from "@/lib/ui/pet-situation";
import { registeredAdjective } from "@/lib/utils/format";

export type CredentialFacePppInfo = {
  attested: boolean;
  registerHref: string;
};

export type CredentialFaceServiceDogInfo = {
  serviceTypeLabel: string;
  manageHref: string;
  presentHref: string;
};

/**
 * In-Memoriam skin data (pet-document-redesign ADR-15). Passed only when
 * `pet.status === 'deceased'` — its presence IS the memorial-mode switch.
 */
export type CredentialFaceMemorial = {
  birthYear: number | null;
  deathYear: number | null;
};

export type CredentialFaceProps = {
  /** Identity data — same shape the hero used (name/breed/photo/tags/status). */
  heroProps: Omit<LnHeroProps, "actions">;
  complianceState: ComplianceState;
  /**
   * ABSOLUTE public-credential URL the QR encodes — built by the caller with
   * `credentialQrUrl()` (lib/infra/site-url.ts). The QR itself is drawn in the
   * browser by <CredentialQr> from this string alone (native-readiness Track
   * 2); this face used to receive pre-rendered SVG markup instead, which tied a
   * scannable credential to a server round-trip.
   */
  credentialUrl: string;
  /** Public credential page URL. E.g. /p/{token} */
  publicHref: string;
  /**
   * Pet's recorded sex ("male" | "female" | "unknown"/null) — drives gender
   * agreement on the "Registrado/a" badge and the situation skin's adjective
   * labels (Perdido/a, Fallecido/a). QA histórico 2026-07-08 #2.
   */
  petSex?: string | null;
  /** Rendered only when the jurisdiction PPP rule applies. */
  /** Rendered only for a vigente, in-service registered service dog. */
  serviceDog?: CredentialFaceServiceDogInfo | null;
  petPublicToken: string;
  /** In-Memoriam skin (ADR-15) — sepia tone + ribbon + deceased-date line. */
  memorial?: CredentialFaceMemorial | null;
  /**
   * Pet SITUATION skin (state-language, #42). When the pet is in a non-default
   * situation (perdida, observación antirrábica, en tratamiento, preñada, en
   * adopción / tránsito), the credential ADOPTS that situation's skin: the face
   * gets its tint (`data-situation` CSS variants) and the passive "Registrada"
   * registration badge is DEMOTED to a quiet secondary marker. The situation's
   * TEXT lives exclusively in the masthead band chip (DocumentChrome) — the
   * single state authority (PO 2026-07-16); this face never repeats the label.
   * The caller must pass `null` for the default (`al-dia`) and for deceased
   * pets (the memorial skin above owns that state) so the two skins never
   * stack.
   */
  situation?: PetSituation | null;
  /** Prioritized alert strip node. `null`/absent → no "Avisos" section. */
  avisos?: ReactNode;
  /**
   * Embedded capture node. Currently always `null` — the caller
   * (`app/(app)/mis-mascotas/[publicToken]/page.tsx`) stopped passing one when
   * the mid-face capture textarea was removed in favor of the "Asentar" tab-bar
   * action and the PetActionRow "Anotar" link (both route to `?sheet=anotar`).
   * The prop stays so a future embedded-capture surface has a slot without
   * touching every caller again; `null`/absent → no "Anotar" section renders.
   */
  anotar?: ReactNode;
  /** Action row node (PetActionRow). Always rendered as the sheet footer. */
  actions?: ReactNode;
  /**
   * "Primeros pasos" owner-onboarding checklist (pending rows only — see
   * lib/projections/first-steps-checklist.ts). Owner-only, non-deceased;
   * the caller passes `null`/absent (or an empty array) for every other
   * viewer/state, which renders no section — this is onboarding, not a
   * permanent fixture, and it is distinct from the Cumplimiento panel below
   * (legal obligations) — see that file's scope-boundary doc comment.
   */
  firstSteps?: FirstStepItem[] | null;
  /**
   * RUPPPA export affordance for the PPP card (L-11) — passed straight through
   * to ComplianceObligationsPanel. Owner-only; the page passes null otherwise.
   */
  pppExport?: ReactNode;
};

export function CredentialFace({
  heroProps,
  complianceState,
  credentialUrl,
  publicHref,
  serviceDog,
  petPublicToken,
  memorial,
  situation,
  avisos,
  anotar,
  actions,
  petSex,
  firstSteps,
  pppExport = null,
}: CredentialFaceProps) {
  const memorialYearRange =
    memorial?.birthYear && memorial?.deathYear
      ? `${memorial.birthYear}–${memorial.deathYear}`
      : null;

  const publicLabel = publicHref.replace(/^\//, "");

  // The situation skin only engages for a genuine, non-default situation. The
  // default `al-dia` and the deceased/memorial case resolve to no skin (the
  // caller already passes null for deceased, but guard on isDefault too so a
  // stray al-dia never tints the credential green as if it were an alert).
  const activeSituation = situation && !situation.isDefault ? situation : null;

  // Gender-agree the "Registrado/a" registration adjective with the pet's
  // recorded sex. QA histórico 2026-07-08 #2.
  const registeredWord = registeredAdjective(petSex);

  // 3b improvement B — mobile compliance disclosure. The collapsed summary is
  // derived from the SAME complianceState the panel renders below (the
  // provenance-gated ComplianceObligationsPanel), so the glanceable line and
  // the expanded grid can never tell different stories. `summary.label` is the
  // "N de M al día" the projection already computes.
  //
  // Cumplimiento dedup (PO 2026-07-18): this summary line used to append
  // "· falta X" (or "· X sin verificar" for a declared-only card — the
  // medianos-sesión-2 finding #4 wording) naming the specific pending
  // obligation. Immediately below, ComplianceObligationsPanel renders that
  // SAME obligation's card with its own label + precise state ("Faltan
  // datos" / "Atestación requerida" / etc.) — the PPP case named twice,
  // back to back. The summary now owns only the COUNT; the cards below own
  // the per-obligation WHICH + STATE (they already carry that distinction —
  // see pet-compliance.ts's `declarado` vs genuinely-absent split — so no
  // information is lost by dropping the tail here).
  const complianceSummary = complianceState.summary.label;
  // A missing FACT is stamped SIN DATO, never with a temporal word. The PPP
  // "Faltan datos" card is deliberately `due` so it ranks first and never
  // counts as "al día" — but rendering `due`'s default word put "POR VENCER"
  // on a pet with nothing expiring (adversarial review 2026-08-08, S2-F06).
  //
  // The vocabulary was already here: LnVstamp's "unknown" variant, which
  // ComplianceObligationsPanel uses for a dose whose vigencia is unknowable.
  // The panel asked and this stamp did not — the same fix failing to reach its
  // sibling for the third time in two days (the others: the 44px floor and the
  // iOS zoom between Field and OpField).
  const complianceStamp = complianceState.worstIsUnknown
    ? "unknown"
    : complianceState.worstTone === "ok" ||
        complianceState.worstTone === "due" ||
        complianceState.worstTone === "over"
      ? complianceState.worstTone
      : null;
  // The summary stamp is a COMPLIANCE claim, not a vaccine-currency one: "ok"
  // here means every obligation is met, which this document already calls "al
  // día" (the counter beside it reads "3 de 3 al día"). LnVstamp's default word
  // for `ok` is VIGENTE — the vigencia-de-la-dosis lens — so the same green
  // pill spoke two different vocabularies one line apart. Overridden to AL DÍA
  // (unified pill vocabulary, PO 2026-08-06); due/over keep their own words,
  // which already mean the same thing in both lenses.
  const complianceStampLabel = complianceStamp === "ok" ? "AL DÍA" : undefined;

  // Service-dog credential row — the only credential that sits ALONGSIDE the
  // compliance panel (PPP is surfaced once inside the panel as its canonical
  // obligation card). Hoisted so the desktop-inline and mobile-disclosure slots
  // below can share the exact same node without duplicating the markup. NOTE:
  // the ComplianceObligationsPanel itself is intentionally NOT hoisted — the
  // page-order source guard (pet-profile-v2-page-order.test.ts) locates the
  // first ComplianceObligationsPanel element and requires it to appear AFTER the
  // identity row, so the panel is inlined in the compliance section below.
  const serviceDogRow = serviceDog ? (
    <div data-section="credentials" className="mt-3 flex flex-col gap-2">
      <div data-section="service-dog-row">
        <LnAlert variant="success" icon="paw">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Perro de asistencia · {serviceDog.serviceTypeLabel}</span>
            <span className="flex shrink-0 gap-3">
              <Link
                href={serviceDog.manageHref}
                className="font-ln-mono text-xs uppercase tracking-[.06em] text-[var(--color-ln-ok)] no-underline hover:underline"
              >
                Gestionar →
              </Link>
              <Link
                href={serviceDog.presentHref}
                className="font-ln-mono text-xs uppercase tracking-[.06em] text-[var(--color-ln-ok)] no-underline hover:underline"
              >
                Presentar →
              </Link>
            </span>
          </div>
        </LnAlert>
      </div>
    </div>
  ) : null;

  return (
    <div
      className="ln-cred"
      data-situation={activeSituation?.key}
      style={memorial ? { filter: "grayscale(0.35) sepia(0.2)" } : undefined}
    >
      {memorial && (
        <div data-section="memorial-ribbon" className="flex justify-center pt-4">
          <LnMemorialChip>
            En memoria{memorialYearRange ? ` · ${memorialYearRange}` : ""}
          </LnMemorialChip>
        </div>
      )}

      {/* Situation skin (#42, standardized 2026-07-16): the face carries the
          situation's TINT only (`data-situation` CSS variants). Its text lives
          exclusively in the masthead band chip (DocumentChrome) — the single
          state authority. The old `.ln-sit` status line repeated the identical
          icon + label right under that chip, which is exactly the "estado
          repetido varias veces" the PO flagged, so it was removed. */}

      {/* Identity row — the photo pokes up into the band (negative margin).
          `data-swipe-zone` marks this header/identity band as one of the
          constrained horizontal-swipe surfaces for the owner credential
          carousel (owner-ia-redesign P4): PetCredentialCarousel's delegated
          pointer handler only starts a swipe when the gesture begins inside a
          `[data-swipe-zone]`, so the long document's vertical scroll never
          fights the swipe. Inert for non-owner viewers (the shell — and thus
          the handler — is never mounted for them). */}
      <div className="ln-sec" data-swipe-zone>
        <div className="ln-idrow">
          <div className="ln-photo">
            {(() => {
              // The photo itself. Empty state shows a "+ Foto" cue only when
              // the owner can act (addPhotoHref set) — a vet/shelter reading
              // the credential sees the plain paw placeholder.
              const photo = heroProps.photoSrc ? (
                <img src={heroProps.photoSrc} alt={heroProps.name} />
              ) : (
                <span className="ln-photo-empty">
                  {heroProps.addPhotoHref ? (
                    <>
                      <span aria-hidden className="ln-photo-add-plus">
                        +
                      </span>
                      <span className="ln-photo-add">Foto</span>
                    </>
                  ) : (
                    <Icon name="paw" size="lg" decorative />
                  )}
                </span>
              );
              // Owner: the whole thumbnail opens the edit sheet already mounted
              // on this page (same form, same file input, same action) — add
              // when empty, change when present. The PO ask evolved from
              // "only when missing" (2026-07) to "let me tap it" (QA
              // 2026-08-02) because every demo pet carries a generated avatar,
              // so the empty-only affordance never appeared in practice.
              return heroProps.addPhotoHref ? (
                <Link
                  href={heroProps.addPhotoHref}
                  className="ln-photo-link"
                  aria-label={
                    heroProps.photoSrc
                      ? `Cambiar foto de ${heroProps.name}`
                      : `Agregar foto de ${heroProps.name}`
                  }
                >
                  {photo}
                </Link>
              ) : (
                photo
              );
            })()}
          </div>

          <div className="ln-idmeta">
            <h1 className="ln-idname">
              {heroProps.name}
              {/* Default state: "Registrada" is the prominent badge next to the
                  name. When a situation skin is active it is DEMOTED to the
                  quiet secondary marker below — the situation is the headline,
                  registration is the footnote (no two competing badges). */}
              {!activeSituation && (
                <span className="ln-badge-reg">
                  <Icon name="check" size="sm" decorative />
                  {registeredWord}
                </span>
              )}
            </h1>
            {activeSituation && (
              <div className="ln-reg-quiet">
                <Icon name="check" size="sm" decorative />
                {registeredWord}
              </div>
            )}
            {heroProps.breed && <div className="ln-idsub">{heroProps.breed}</div>}
            {heroProps.tags && heroProps.tags.length > 0 && (
              <div className="ln-chips">
                {heroProps.tags.map((tag) => (
                  <span key={tag.key} className="ln-chip">
                    {tag.key === "loc" && <Icon name="map-pin" size="sm" decorative />}
                    {tag.label}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="ln-qr">
            <Link
              href={publicHref}
              aria-label="Ver credencial pública"
              className="ln-qr-link no-underline"
            >
              <span className="ln-qr-frame">
                {/* `size` writes the svg's intrinsic width/height attributes;
                    `.ln-qr-frame svg` in globals.css still sizes the rendered
                    box (76px, 104px at md) because CSS beats SVG presentation
                    attributes. */}
                <CredentialQr
                  value={credentialUrl}
                  size={76}
                  label={`Código QR de la credencial pública de ${heroProps.name}`}
                />
              </span>
            </Link>
            <div className="ln-qr-cap">
              <b>Credencial pública</b>
              {publicLabel}
            </div>
          </div>
        </div>
      </div>

      {/* Primeros pasos — owner-onboarding checklist (setup tasks, never a
          legal obligation on their own). Rendered ABOVE Cumplimiento: a new
          pet needs onboarding guidance before it needs to see its compliance
          state, and the section fully vanishes once every step is done or
          dismissed — a permanent, empty divider never lingers here. */}
      {firstSteps && firstSteps.length > 0 && (
        <>
          <div className="ln-divider">
            <span className="ln-divider-label">
              <Icon name="star" size="sm" decorative />
              Primeros pasos
            </span>
          </div>
          <div className="ln-sec">
            <FirstStepsChecklist items={firstSteps} petPublicToken={petPublicToken} />
          </div>
        </>
      )}

      {/* Cumplimiento — the provenance-gated obligation grid, bare (the divider
          labels it; no card-in-card outer box). */}
      {/* A DECEASED pet has no pending obligations. The panel derives from the
          event stream and never asked for the animal's state, so a profile whose
          header already read EN MEMORIA went on showing "0 de 4 al día", "Vacuna
          antirrábica SIN REGISTRO" and "Completá la raza y el peso para saber si
          entra en el régimen PPP" — a checklist of things to do for an animal
          the owner had just reported dead (master test CIU, B5-a). It is the one
          finding in that report filed as "sólo me molestó" that would actually
          hurt someone in production. The obligations are computed all the same
          (they still feed the hero's status mapper); they are simply not shown
          to a person in mourning. */}
      {complianceState.cards.length > 0 && !memorial && (
        <>
          <div className="ln-divider">
            <span className="ln-divider-label">
              <Icon name="shield" size="sm" decorative />
              Cumplimiento
            </span>
          </div>
          <div className="ln-sec">
            {/* Cumplimiento dedup (PO 2026-07-18): the "Cumplimiento" divider
                above is the ONE surface owning the section label, and each
                breakpoint variant renders the "N de M al día" counter exactly
                once. The bare panel itself is headerless — it used to repeat
                "Estado de cumplimiento" + the counter a second (and on mobile a
                third) time. */}

            {/* Desktop (≥md) has the room: one summary row (counter + stamp)
                above the full provenance-gated grid, inline. */}
            <div className="hidden md:block">
              {/* Cumplimiento dedup, second pass (PO 2026-08-11). The counter
                  stays; the STAMP does not. `complianceStamp` is `worstTone`,
                  and the card carrying that worst tone renders its own stamp
                  with the same word in the grid IMMEDIATELY below — so on a pet
                  with one expired vaccine this row said VENCIDA and the next
                  row said VENCIDA again, ~40px apart, about the same dose.
                  "0 de 4 al día" already carries the severity at a glance.

                  The mobile variant below KEEPS its stamp on purpose: there the
                  grid is collapsed inside a <details>, so the stamp is the only
                  severity signal until the reader expands it. Same data, two
                  breakpoints, different amounts of context on screen. */}
              <div
                data-section="compliance-summary"
                className="mb-2.5 flex items-center justify-between gap-3"
              >
                <p className="m-0 text-sm font-medium text-[var(--color-ln-ink-2)]">
                  {complianceSummary}
                </p>
              </div>
              <ComplianceObligationsPanel
                state={complianceState}
                petPublicToken={petPublicToken}
                bare
                pppExport={pppExport}
              />
              {serviceDogRow}
            </div>

            {/* Mobile (<md): a glanceable summary row that expands inline to the
                SAME provenance-gated panel. This is the 3b craft win — the front
                becomes scannable, depth is one tap away, integrity is untouched
                (the disclosure wraps the identical ComplianceObligationsPanel,
                same tone/gate). The disclosure is a native <details>, so it is
                keyboard-operable with no client JS (CredentialFace stays a
                server component). Titled "Obligaciones" — a NAME, not a repeat
                of the divider's "Cumplimiento" label family.

                The md:hidden lives on a plain WRAPPER div, not on DiscList:
                `.ln-disc-list` sets `display:flex` as an UNLAYERED rule in
                globals.css, and unlayered author CSS beats Tailwind's layered
                utilities — `md:hidden` on the DiscList itself silently lost,
                mounting BOTH the expanded panel and this collapsed disclosure
                on desktop (double compliance widget on /inicio). */}
            <div className="md:hidden">
              <DiscList>
                <DiscRow
                  icon="shield"
                  title="Obligaciones"
                  summary={complianceSummary}
                  trailing={
                    complianceStamp ? (
                      <LnVstamp variant={complianceStamp} label={complianceStampLabel} />
                    ) : undefined
                  }
                >
                  <ComplianceObligationsPanel
                    state={complianceState}
                    petPublicToken={petPublicToken}
                    bare
                    pppExport={pppExport}
                  />
                  {serviceDogRow}
                </DiscRow>
              </DiscList>
            </div>
          </div>
        </>
      )}

      {/* Avisos — only when the strip carries at least one alert (the caller
          passes null when empty, so no empty divider appears). */}
      {avisos && (
        <>
          <div className="ln-divider">
            <span className="ln-divider-label">
              <Icon name="alert" size="sm" decorative />
              Avisos
            </span>
          </div>
          <div className="ln-sec">{avisos}</div>
        </>
      )}

      {/* Anotar — embedded free-text capture (owner + active only). */}
      {anotar && (
        <>
          <div className="ln-divider">
            <span className="ln-divider-label">
              <Icon name="edit" size="sm" decorative />
              Anotar
            </span>
          </div>
          <div className="ln-sec">{anotar}</div>
        </>
      )}

      {/* Action row — the sheet footer. */}
      {actions && (
        <>
          <div className="ln-divider" />
          <div className="ln-sec">{actions}</div>
        </>
      )}
    </div>
  );
}
