// PublicLostSections — the lost-mode BODY of the public credential
// (pet-state-header R3.1/R3.4). The full-page LostPublicCredential takeover is
// retired: a lost pet renders the SAME structural card as an active pet, with
// the masthead in the lost treatment (page.tsx stamps `data-situation`) and
// these sections between the name bar and the identity grid.
//
// What strangers need in five seconds:
//   1) The pet is lost. (masthead chip + the urgent strip here, with recency)
//   2) The owner is real. (first name if disclosed)
//   3) How to help fast. (call / email / finder form / sighting)
//   4) Where it was last seen. (one map preview if disclosed)
//
// All props are server-resolved AFTER applying the disclosure prefs on
// `pets`. The component itself never decides what to show — the page
// passes only what's actually disclosable.

import { Icon } from "@/components/Icon";
import { lostTimeLabel } from "@/lib/infra/lost-listing";
import { tattooLocationLabel } from "@/lib/reference/lookups";
import { DISPUTE_TIP_NOTICE } from "@/lib/ui/dispute-copy";
import {
  foundPossessivePhrase,
  lastSeenHeadingLabel,
  lostBannerHeadline,
  lostFirstPersonLine,
  normalizePhoneForTel,
  sightingPhrase,
} from "@/lib/utils/format";
import dynamic from "next/dynamic";
import Image from "next/image";

// Live mini-map of the last-seen point. Loaded via next/dynamic (maplibre-gl must
// not run on the server) — same pattern as LostLastSeenCard (owner side).
const LocationMap = dynamic(() => import("@/components/LocationMap"), {
  loading: () => (
    <div className="h-40 w-full animate-pulse rounded-xl border border-ln-line bg-ln-stripe" />
  ),
});

interface Props {
  petName: string;
  /** Pet sex ('male' | 'female' | 'unknown') — genders the lost-mode copy. */
  petSex: string | null;
  /** "Canino · marrón · collar rojo" — short identifying line. EMPTY STRING when
   *  the pet has no colour and no señas: the caller builds it (page.tsx) and
   *  deliberately returns "" rather than a lone species word, which described
   *  nothing and rendered as a floating orphan under the headline. */
  identityLine: string;
  /** Owner first name, or null if hidden by prefs. */
  ownerFirstName: string | null;
  /** E.164 phone for tel:, or null if hidden by prefs. */
  ownerPhoneE164: string | null;
  /** Owner email for mailto:, or null if hidden by prefs (R3.4.12 gap fix —
   * discloseEmailWhenLost previously fetched the email but never rendered it). */
  ownerEmail?: string | null;
  /**
   * Alternate contact: the pet's temporary caretaker (custodia-temporal).
   *
   * NULL is the default and by far the common case. It is non-null only when
   * BOTH keys of the two-key model hold — the titular's disclosure toggle AND
   * the caretaker's own consent, recorded when they accepted the invitation.
   * This component does not evaluate that; it is resolved server-side in
   * lib/infra/caretaker-public-contact.ts so the rule lives in one place.
   */
  caretakerContact?: { firstName: string | null; phoneE164: string | null } | null;
  /** Last seen place label or null if hidden. */
  lastSeenPlaceName: string | null;
  /** Last seen locality. */
  lastSeenLocality: string | null;
  /**
   * Raw "lat, lng" decimal degrees for the demoted coordinate line under the
   * map (UI review M3). Never substituted into `lastSeenPlaceName` — a
   * coordinate pair is not a place, and it used to LEAD the section.
   */
  lastSeenCoords?: string | null;
  /**
   * When the displayed last-seen point was reported. Renders as recency
   * ("hace 18 días") beside the place, so the first line answers WHERE and HOW
   * FRESH — the two things a neighbour decides on. Null → no recency shown
   * (never a guessed one).
   */
  lastSeenAt?: Date | null;
  /** Distinguishing features (free text from pet record), or null. */
  distinguishingFeatures: string | null;
  /** Finder form URL. Pass null to hide the CTA. */
  finderFormHref: string | null;
  /** Sighting form URL ("La vi cerca de acá"). Independent of finderFormHref —
   * surfaces a lower-commitment way to help (drop a pin, no custody claim). */
  sightingFormHref?: string | null;
  /** Date the pet was marked lost. */
  lostSince: Date;
  /** Tattoo code — gated by lost status (D3). Null if pet has no tattoo. */
  tattooCode?: string | null;
  /** Tattoo body location enum value — used to look up the human label. */
  tattooLocation?: string | null;
  /** Free-form origin / description (FCA, criadero, campaign, etc.). */
  tattooDescription?: string | null;
  /** Resolved public URL of the tattoo photo, or null if unavailable. */
  tattooPhotoUrl?: string | null;
  /** Last seen lat/lng — when present, renders an inline MapLibre mini-map of
   * the point plus an "Abrir en Google Maps" link so a finder can navigate from
   * where the pet was lost. Sprint 5 PR-041 / doc 10 §3 punto 1. */
  lastSeenLat?: number | null;
  lastSeenLng?: number | null;
  /** Free-form lost description fields from the mark-lost event payload (spec §8.4).
   * Always shown when present — no disclosure pref gates animal identity details. */
  lostDescription?: {
    accessoriesWhenLost: string | null;
    behaviorNotes: string | null;
    lastSeenContext: string | null;
  } | null;
  /** Permanent conditions (e.g. blind, deaf) disclosed for the LOST credential —
   * welfare-safety info a finder needs. Server-resolved: null unless the owner
   * opted into `discloseConditionsPublicly` AND the pet has at least one
   * condition. See lib/reference/permanent-conditions.ts `resolveLostSpecialConditions`. */
  specialConditions?: { labels: string[]; other: string | null } | null;
  /** D2 hardening (red-team 2026-07): true while pets.inCustodyDispute is set.
   * The caller must ALSO null the contact fields and both form hrefs; this flag
   * only swaps the "no channels" warning for the neutral authority notice so
   * the card explains WHY there is no way to contact anyone. */
  custodyDisputed?: boolean;
}

export function PublicLostSections({
  petName,
  petSex,
  identityLine,
  ownerFirstName,
  ownerPhoneE164,
  ownerEmail = null,
  caretakerContact = null,
  lastSeenPlaceName,
  lastSeenLocality,
  lastSeenCoords = null,
  lastSeenAt = null,
  distinguishingFeatures,
  finderFormHref,
  sightingFormHref = null,
  lostSince,
  tattooCode = null,
  tattooLocation = null,
  tattooDescription = null,
  tattooPhotoUrl = null,
  lastSeenLat = null,
  lastSeenLng = null,
  lostDescription = null,
  specialConditions = null,
  custodyDisputed = false,
}: Props) {
  const tattooLocLabel = tattooLocationLabel(tattooLocation);
  const hasLastSeenCoords =
    lastSeenLat != null &&
    lastSeenLng != null &&
    Number.isFinite(lastSeenLat) &&
    Number.isFinite(lastSeenLng);
  const mapHref = hasLastSeenCoords
    ? `https://www.google.com/maps/search/?api=1&query=${lastSeenLat},${lastSeenLng}`
    : null;
  return (
    <div data-section="lost-sections">
      {/* Urgent strip — the state + recency (first body strip; the masthead
          chip above already carries role="alert", so this strip stays a plain
          visual reinforcement rather than a second SR announcement). */}
      <div
        data-section="lost-urgent-strip"
        className="border-t border-ln-err-100 bg-ln-err-050 px-4 py-3"
      >
        <p className="m-0 flex items-center gap-1.5 text-sm font-bold tracking-wide text-ln-err">
          <Icon name="alert-triangle" size="sm" decorative />
          {lostBannerHeadline(petSex)}
          <span className="font-medium opacity-80">· {formatLostSince(lostSince)}</span>
        </p>
        {/* First-person headline + identity line (R3.4.10). */}
        <p className="mt-1.5 text-md font-semibold text-ln-ink">
          ¡Hola! Soy {petName} — {lostFirstPersonLine(petSex)}
        </p>
        {identityLine && <p className="mt-0.5 text-sm text-ln-ink-2">{identityLine}</p>}
        {/* Owner name disclosure ("Tu nombre" toggle). Standalone on purpose:
            it used to appear ONLY inside the phone CTA ("Llamar a X"), so with
            the phone toggle off the promised "Lo busca X" never rendered
            anywhere (Cowork QA v3, M1). */}
        {ownerFirstName && (
          <p data-section="lost-owner-name" className="mt-0.5 text-sm font-medium text-ln-ink-2">
            Lo busca {ownerFirstName}.
          </p>
        )}
        {/* Alternate contact — the temporary caretaker. Both keys of the
            two-key model were checked server-side; by the time this renders,
            the caretaker has personally agreed to appear here. Named as an
            ALTERNATE rather than presented as the owner: the finder must not be
            left thinking they are talking to the titular, and the caretaker is
            not one. */}
        {caretakerContact?.firstName && (
          <p
            data-section="lost-caretaker-contact"
            className="mt-0.5 text-sm font-medium text-ln-ink-2"
          >
            Mientras tanto la cuida {caretakerContact.firstName}.
          </p>
        )}
        {distinguishingFeatures && (
          <p className="mt-1 text-sm italic text-ln-ink-2">"{distinguishingFeatures}"</p>
        )}

        {/* CTA row — every enabled contact channel, right under the name bar.
            ONE accent, two weights (UI review, PO 2026-08-06): the two actions
            that actually reunite a pet — reaching the owner by phone and "la
            tengo conmigo" — are SOLID ln-azul; email and sighting are outline.
            This row previously mixed three fills (a green solid "Llamar", a
            blue solid finder CTA, two outlines), so the finder's eye had to
            rank two competing primaries in different hues while holding
            somebody's lost dog. The green was doubly wrong here: ln-ok is the
            product's "al día / verified" semantic, and this is the one card
            where nothing is fine. */}
        <div data-section="lost-cta-row" className="mt-3 flex flex-wrap gap-2">
          {ownerPhoneE164 && (
            <a
              href={`tel:${normalizePhoneForTel(ownerPhoneE164) ?? ownerPhoneE164}`}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-ln-azul px-5 text-sm font-semibold text-white hover:bg-ln-azul-700"
            >
              {/* Just "Llamar". The name used to ride along here because this
                  CTA was its ONLY carrier; the standalone "Lo busca X." line
                  above took that job (M1), so repeating it turns the row's
                  primary action into the longest label in the row for no new
                  information. */}
              <Icon name="telefono" size="sm" decorative /> Llamar
            </a>
          )}
          {caretakerContact?.phoneE164 && (
            <a
              href={`tel:${normalizePhoneForTel(caretakerContact.phoneE164) ?? caretakerContact.phoneE164}`}
              data-section="lost-caretaker-call"
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-ln-card border border-ln-line px-5 text-sm font-semibold text-ln-ink hover:bg-ln-stripe"
            >
              {/* Outline, never solid: the titular's "Llamar" is the row's one
                  primary. The caretaker is an alternate, and a second solid
                  button would make the finder rank two competing primaries
                  while holding somebody's lost dog. */}
              <Icon name="telefono" size="sm" decorative /> Llamar a{" "}
              {caretakerContact.firstName ?? "quien la cuida"}
            </a>
          )}
          {ownerEmail && (
            <a
              href={`mailto:${ownerEmail}`}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-ln-card border border-ln-line px-5 text-sm font-semibold text-ln-ink hover:bg-ln-stripe"
            >
              <Icon name="mail" size="sm" decorative /> Escribir por email
            </a>
          )}
          {/* Plain anchors ON PURPOSE (not next/link): the finder is an
              anonymous one-shot visitor with no client state worth keeping —
              a hard navigation renders the form instantly server-side and is
              immune to the soft-router stall family (QA: 2-4s delays and
              harness Enter-activation misses on the Link version). */}
          {finderFormHref && (
            <a
              href={finderFormHref}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-ln-azul px-5 text-sm font-semibold text-white hover:bg-ln-azul-700"
            >
              <Icon name="ubicacion" size="sm" decorative /> {foundPossessivePhrase(petSex)}
            </a>
          )}
          {sightingFormHref && (
            <a
              href={sightingFormHref}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-ln-card border border-ln-line px-5 text-sm font-semibold text-ln-ink hover:bg-ln-stripe"
            >
              <Icon name="ojo" size="sm" decorative /> {sightingPhrase(petSex)}
            </a>
          )}
        </div>

        {/* Phone-privacy note (Cowork I1 / Cursor IDEA) — the NORMAL lost state:
            the phone is not disclosed but an aviso path exists, so explain why
            there's no "Llamar" button and point the finder at the avisos.
            Suppressed when a call CTA is present (phone disclosed). It renders on
            the null-phone prop alone — identical whether the owner has no phone or
            simply didn't disclose it — so it never leaks whether a phone EXISTS,
            only that we don't show one. Mutually exclusive with the no-channels
            warning below (that one needs NO aviso path at all). */}
        {!ownerPhoneE164 && (finderFormHref || sightingFormHref) && (
          <p className="mt-3 text-xs text-ln-ink-2">
            Por privacidad no mostramos el teléfono del dueño: completá uno de estos avisos y le
            llega al instante.
          </p>
        )}

        {/* Custody dispute (D2 hardening, red-team 2026-07): every contact and
            relay channel is suppressed by the caller, so explain WHY with the
            neutral authority notice — never the misleading "no channels
            enabled" warning below. */}
        {custodyDisputed && (
          <p
            data-section="lost-custody-dispute-notice"
            className="mt-3 rounded-lg bg-[var(--color-ln-warn-050)] px-3 py-2 text-xs text-ln-ink-2"
          >
            {DISPUTE_TIP_NOTICE}
          </p>
        )}

        {/* Honest warning — the DEGENERATE state: no phone, no email, and no
            aviso path (neither the finder form nor the sighting form). email and
            sighting are included in the check because telling a finder there are
            "no contact channels" next to a working mailto or a sighting CTA would
            lie. Suppressed for a disputed pet — the neutral notice above owns
            that state. */}
        {!custodyDisputed &&
          !ownerPhoneE164 &&
          !finderFormHref &&
          !sightingFormHref &&
          !ownerEmail && (
            <p className="mt-3 rounded-lg bg-[var(--color-ln-warn-050)] px-3 py-2 text-xs text-ln-warn">
              Esta mascota no tiene canales de contacto habilitados.
            </p>
          )}
      </div>

      {/* Special-conditions disclosure (welfare safety) — a finder handling a
          blind, deaf, or medicated pet needs to know before they act. Only
          rendered when the owner opted in (discloseConditionsPublicly) AND
          there's at least one disclosable condition. Placed right after the
          identity/CTA strip so it's one of the first things a finder sees. */}
      {specialConditions && (specialConditions.labels.length > 0 || specialConditions.other) && (
        <section
          role="note"
          aria-label="Necesita cuidados especiales"
          data-section="special-conditions"
          className="border-t border-l-4 border-t-ln-line-2 border-l-ln-warn bg-[var(--color-ln-warn-050)] px-4 py-3"
        >
          <p className="flex items-center gap-2 text-sm font-bold text-ln-warn">
            <Icon name="alert-triangle" size="sm" decorative />
            Necesita cuidados especiales
          </p>
          {specialConditions.labels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {specialConditions.labels.map((label) => (
                <span
                  key={label}
                  className="inline-flex rounded-full bg-ln-warn px-3 py-1 text-xs font-semibold text-white"
                >
                  {label}
                </span>
              ))}
            </div>
          )}
          {specialConditions.other && (
            <p className="mt-2 text-sm text-ln-ink-2">{specialConditions.other}</p>
          )}
        </section>
      )}

      {/* Last-seen section — rendered ONLY when there is disclosable location
          data. The old "Sin ubicación de avistaje registrada" empty-state read
          as a data gap even when the owner HAD a location and simply chose not
          to publish it (props arrive disclosure-filtered, so this component
          cannot tell the cases apart) — tester fix #7: hide it entirely. */}
      {(lastSeenPlaceName || lastSeenLocality || hasLastSeenCoords) && (
        <section className="border-t border-ln-line-2 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-ln-mute">
            {lastSeenHeadingLabel(petSex)}
          </p>
          {/* WHERE + HOW FRESH, in that order (UI review M3). This line used to
              open with six-decimal coordinates because the loader substituted
              them for a missing address — "-54.806060, -68.304976 · Ushuaia".
              A neighbour reads the place name and decides whether they were
              near there; the recency tells them whether it is still worth
              looking. Coordinates are for the finder who wants to navigate,
              and they now live under the map. */}
          {(lastSeenPlaceName || lastSeenLocality || lastSeenAt || hasLastSeenCoords) && (
            <p className="mt-1 text-sm font-medium text-ln-ink">
              {[
                // Pin-only records (a map tap, no address) say so in words —
                // the same phrase the owner surface uses — instead of leading
                // with a bare recency or the raw pair.
                lastSeenPlaceName ??
                  (!lastSeenLocality && hasLastSeenCoords ? "Punto marcado en el mapa" : null),
                lastSeenLocality,
                lastSeenAt ? formatLostSince(lastSeenAt) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          {/* No fixed height and no overflow-hidden here, and no border either:
              LocationMap already carries its own h-64 and rounded border. This
              wrapper used to clamp it to h-40 and clip, which cut the bottom 96px
              — exactly where MapLibre draws the attribution control. The ODbL
              licence requires that credit be visible, so the clip was a licensing
              defect, not a cosmetic one (it also produced the double frame).
              This is the only one of LocationMap's eight call sites that wrapped
              it in a fixed-height box; the other seven let it size itself. */}
          {hasLastSeenCoords ? (
            <div className="mt-3 w-full">
              <LocationMap lat={lastSeenLat as number} lng={lastSeenLng as number} />
            </div>
          ) : (
            <div className="mt-3 flex h-32 flex-col items-center justify-center gap-1 rounded-xl bg-gradient-to-br from-[var(--color-ln-ok-050)] to-ln-celeste/10 text-[var(--color-ln-mute)]">
              <Icon name="ubicacion" size={28} decorative />
              <span className="text-xs text-[var(--color-ln-mute)]">
                Sin punto exacto en el mapa
              </span>
            </div>
          )}
          {/* Demoted coordinate line (UI review M3) — small mono, muted, UNDER
              the map, beside the navigation link that is what most finders
              actually want. Kept rather than deleted: a rural point with no
              street address is sometimes only expressible as a pair, and a
              rescuer with a handheld GPS needs to type it somewhere. */}
          {(lastSeenCoords || mapHref) && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              {mapHref && (
                <a
                  href={mapHref}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-xs font-medium text-ln-ok underline underline-offset-2 hover:text-ln-ok/80"
                >
                  Abrir en Google Maps ↗
                </a>
              )}
              {lastSeenCoords && (
                <span
                  data-section="lost-last-seen-coords"
                  className="font-ln-mono text-xs text-ln-mute"
                >
                  {lastSeenCoords}
                </span>
              )}
            </div>
          )}
        </section>
      )}

      {tattooCode && (
        <section className="border-t border-ln-line-2 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-ln-mute">Tatuaje</p>
          <p className="mt-1 font-ln-mono text-sm font-medium text-ln-ink">
            {tattooCode}
            {tattooLocLabel && (
              <span className="ml-2 font-sans text-xs text-ln-mute">· {tattooLocLabel}</span>
            )}
          </p>
          {tattooDescription && (
            <p className="mt-1 text-xs italic text-ln-ink-2">{tattooDescription}</p>
          )}
          {tattooPhotoUrl && (
            /* `relative` is load-bearing: <Image fill> renders position:absolute,
               so without a positioned ancestor its containing block is the
               VIEWPORT — a full-bleed photo painted on top of every finder CTA
               and swallowed all taps (QA round 2, finding #0).
               pointer-events-none is defense-in-depth: the photo is decorative
               and must never intercept a click. */
            <div className="relative mt-3 aspect-video w-full overflow-hidden rounded-xl">
              <Image
                src={tattooPhotoUrl}
                alt={`Tatuaje de ${petName}`}
                fill
                sizes="(max-width: 480px) 100vw, 480px"
                className="pointer-events-none object-cover"
              />
            </div>
          )}
          <p className="mt-2 text-xs text-ln-mute">
            Compará el código y la foto con el animal que tenés en frente antes de confirmar la
            coincidencia.
          </p>
        </section>
      )}

      {/* Lost description — accessories, behaviour, last-seen context.
          Animal identity details per spec §8.4 — not gated by disclosure prefs. */}
      {lostDescription &&
        (lostDescription.accessoriesWhenLost ||
          lostDescription.behaviorNotes ||
          lostDescription.lastSeenContext) && (
          <section className="border-t border-ln-line-2 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-ln-mute">
              Detalles cuando se perdió
            </p>
            {lostDescription.accessoriesWhenLost && (
              <div className="mt-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-ln-mute">
                  Accesorios
                </p>
                <p className="mt-0.5 text-sm text-ln-ink">{lostDescription.accessoriesWhenLost}</p>
              </div>
            )}
            {lostDescription.behaviorNotes && (
              <div className="mt-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-ln-mute">
                  Comportamiento
                </p>
                <p className="mt-0.5 text-sm text-ln-ink">{lostDescription.behaviorNotes}</p>
              </div>
            )}
            {lostDescription.lastSeenContext && (
              <div className="mt-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-ln-mute">
                  Contexto
                </p>
                <p className="mt-0.5 text-sm text-ln-ink">{lostDescription.lastSeenContext}</p>
              </div>
            )}
          </section>
        )}
    </div>
  );
}

// `now` is a parameter (default = call time) so the label is a pure function
// of (d, now) and unit-testable for determinism. This renders inside a Server
// Component today (single server evaluation, no hydration re-run), but keeping
// it pure guards the relative-`now` class against a future SSR-eager refactor.
// Delegates to lostTimeLabel — the /perdidas list and this credential detail now
// speak ONE relative-time vocabulary (Cowork B2 / consistency: the same pet no
// longer reads "hace 3 semanas" on the card and "hace 27 días" here).
export function formatLostSince(d: Date, now: number = Date.now()): string {
  return lostTimeLabel(d, new Date(now));
}
