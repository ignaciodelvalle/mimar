"use client";

// Shared location form section. Single-input pattern for both L1 and L2,
// per critique-direcciones-2026-05-27 §"Opción B": the user types one
// thing, the structured fields are derived from the selected result.
//
//   l1 — single locality autocomplete (cross-province ar_localities).
//        Province is derived from the chosen locality.
//   l2 — single Nominatim autocomplete on the address line. Map below
//        is for confirmation + drag-to-adjust; dragging reverse-geocodes
//        and refills the address + jurisdiction. No separate province/
//        locality inputs for L2 — the autocomplete pick (or pin drag)
//        fills the hidden inputs in bloque.
//
// Hidden-input wire format (back-compat with every existing action):
//   provinceCode        — ISO 3166-2:AR. Always emitted (empty when user
//                         hasn't picked anything).
//   provinceName        — display name. Companion to provinceCode.
//   localityName        — canonical when picked, raw query otherwise.
//   localityNameIndecId — INDEC id from ar_localities; empty when L2 (the
//                         pin / geocoder yields a NAME, never an id — a
//                         writer normalising with locality "soft" resolves
//                         the id server-side, e.g. the bite writers) or when
//                         L1 user typed free text. The ONE exception (L2,
//                         localidades-por-id B6): the id of the row the person
//                         picked from the "¿Es acá?" candidates.
//   localityPicked      — "1" when that pick happened (the server records
//                         the row as `user_picked`); empty otherwise.
//   locationLat         — decimal latitude (L2 only).
//   locationLng         — decimal longitude (L2 only).
//   locationAddress     — address text (L2 only). MarkLost can override
//                         the field name via inputNames.description for
//                         back-compat with its setPetLostAction reader;
//                         removal of the alias is tracked in critique §5.
//
import {
  type GeocodeResult,
  type ReversePinAnswer,
  geocodeAddressAction,
  geocodeAddressPublicAction,
  reverseGeocodeAction,
  reverseGeocodePublicAction,
} from "@/app/actions/geocoding";
import { searchLocalitiesPublicAction } from "@/app/actions/localities";
import { LocalityPickerAcross } from "@/components/LocalityPickerAcross";
import { LnInput, LnSelect } from "@/components/ui/Field";
import { PROVINCES, type Province, provinceByName } from "@/lib/reference/ar-provincias";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

const LocationPicker = dynamic(() => import("./LocationPicker"), {
  loading: () => (
    <div className="w-full h-64 rounded-lg border border-ln-line  bg-ln-stripe  animate-pulse" />
  ),
});

// Two modes: l1 (jurisdiction only) and l2 (jurisdiction + map + address).
// Deprecated aliases (`point`, `jurisdiction`, `jurisdiction+point`, `full`)
// were retired in critique §6/§8 — they had zero active consumers by the
// time the cleanup landed.
export type LocationMode = "l1" | "l2";

export type LocationFieldsValue = {
  provinceCode?: string | null;
  localityName?: string | null;
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  // Legacy alias for the address text; some consumers (MarkLost) read it
  // under a different name on the server. Pre-fill from address first,
  // description second.
  description?: string | null;
};

/** Structured value emitted by the optional `onChange` callback — the same data
 * the L2 hidden inputs carry, so a parent can LIFT this component's state
 * instead of reading the uncontrolled inputs via FormData at submit time.
 * Reflects the L2-derived jurisdiction/point/address; L1's locality pick is
 * owned by LocalityPickerAcross's own hidden inputs and is not mirrored here. */
export type LocationFieldsChange = {
  provinceCode: string | null;
  provinceName: string | null;
  localityName: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  // W8 (PO, 2026-09-24): no device GPS on the web — "gps" stays a valid
  // legacy value in lib/events/event-schemas.ts (old events, append-only)
  // but no writer here emits it any more.
  source: "pin_manual" | "geocodificada" | null;
  /** INDEC id of the row the person picked from the "¿Es acá?" candidates (B6). */
  localityIndecId?: string | null;
  /** True when that pick happened — the server records it as `user_picked`. */
  localityPicked?: boolean;
};

/** A catalogue row a pin could be in, as the reverse action offers it (B6). */
type PlaceCandidate = ReversePinAnswer["place"]["candidates"][number];

/** "Mechita (Bragado), Buenos Aires" — the department tells two homonyms apart. */
export function candidateLabel(c: PlaceCandidate): string {
  const department = c.departmentName ? ` (${c.departmentName})` : "";
  return `${c.localityName}${department}, ${c.provinceName}`;
}

const NONE_OF_THESE = "Ninguna de estas / no sé";

const FORWARD_DEBOUNCE_MS = 600;
const MIN_QUERY_LENGTH = 3;

export function LocationFields({
  mode,
  defaultValue,
  biasProvince = null,
  biasLocality = null,
  inputNames,
  allowAnonymous = false,
  onLocationPresenceChange,
  onPointPresenceChange,
  onChange,
  required = false,
  l1Label = "Localidad",
  cascade = false,
  defaultCenter = null,
}: {
  mode: LocationMode;
  defaultValue?: LocationFieldsValue;
  biasProvince?: string | null;
  biasLocality?: string | null;
  /** Renders the red-seal `*` on the L1 "Localidad" label, matching the
   * LnField required marker used by sibling fields (QA round 2 2026-07-03 #7:
   * the helper said "Requerido" but the label carried no asterisk). For L1 it is
   * also forwarded to the locality autocomplete, adding native `required` +
   * `aria-required` on the text input so an empty submit is blocked client-side. */
  required?: boolean;
  /** Overrides the L1 field label. Defaults to "Localidad". Lets a caller name
   * the field in context (e.g. "Localidad donde ejercés") WITHOUT rendering a
   * second, redundant label above the picker (#43 item 4). */
  l1Label?: string;
  /** L1 only. When true, renders a province-first cascade: a Provincia <select>
   * gates the locality autocomplete, which stays disabled until a province is
   * picked and then searches scoped to that province_code. Changing the province
   * clears the locality selection. Mirrors the JurisdictionFilter pattern.
   * Reusable capability, OPT-IN per call site: it is on wherever a caller
   * passes `cascade` — the pet alta forms, and also the move, vet-visit,
   * check-in, clinical-info, vet-upgrade, org-create and consultorio forms
   * (grep the call sites rather than trusting this list). Every other L1
   * surface keeps the single cross-province input (cascade=false). No effect
   * on L2. */
  cascade?: boolean;
  // Override the wire-format name for the L2 address / lat / lng hidden
  // inputs. Retained for flexibility; no current consumer overrides these
  // (the lastKnownLocation alias was retired by critique §5).
  inputNames?: { lat?: string; lng?: string; description?: string };
  // True for anonymous public flows (PetSightingForm, DenunciaWizard).
  // Routes geocoding calls through the IP-rate-limited public actions.
  allowAnonymous?: boolean;
  // Optional: notified whenever the field's location presence changes (true when
  // any of jurisdiction / address / map point is set). Lets a parent warn on
  // empty location without coupling to the uncontrolled hidden inputs (UI-7 B6).
  onLocationPresenceChange?: (hasLocation: boolean) => void;
  // Optional (L2): notified whenever an EXACT map point is set/cleared. Narrower
  // than onLocationPresenceChange (which also fires for a typed address alone) —
  // the denuncia wizard gates advancing on a marked point specifically, so the
  // canonical locality can be inferred from it (QA 2026-07-10, FIX #3A).
  onPointPresenceChange?: (hasPoint: boolean) => void;
  // Optional (L2): emits the full structured value whenever the derived
  // jurisdiction / point / address changes. Lets a parent LIFT this state and
  // stop reading the uncontrolled hidden inputs at submit time (DenunciaWizard
  // M-followup). Additive + opt-in — consumers that omit it are unaffected and
  // keep relying on the hidden-input wire format.
  onChange?: (value: LocationFieldsChange) => void;
  // Optional (L2): initial center for the EMPTY map — no marker, no hidden
  // input value. The public sighting form passes the pet's DISCLOSED
  // last-known lost location here (privacy-gated server-side).
  defaultCenter?: { lat: number; lng: number } | null;
}) {
  const isL2 = mode === "l2";

  // Province-first cascade (L1 + cascade only). Drives the locality search
  // scope and gates the picker. Seeded from defaultValue for a future edit
  // adoption; null in the create alta so the picker starts disabled.
  const [cascadeProvinceCode, setCascadeProvinceCode] = useState<string | null>(
    defaultValue?.provinceCode ?? null,
  );

  // Map point (L2 only). Pre-filled when defaultValue has lat/lng.
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(
    defaultValue?.lat != null && defaultValue?.lng != null
      ? { lat: defaultValue.lat, lng: defaultValue.lng }
      : null,
  );
  // panorama-event-points Slice 1: how the CURRENT coordinate was captured, so
  // consumers (the sighting writer) can record a precision hint. Set on each
  // coordinate origin: a map gesture → 'pin_manual', a typed-address geocode →
  // 'geocodificada'. Emitted as a hidden `locationSource` field; forms that
  // don't read it simply ignore the extra field.
  // W8 (PO, 2026-09-24): no device GPS anywhere on the web — 'gps' is no
  // longer an origin this component can produce. It stays a valid legacy
  // value in lib/events/event-schemas.ts for OLD events (append-only).
  const [locationSource, setLocationSource] = useState<"pin_manual" | "geocodificada" | null>(null);

  // Picked jurisdiction (L2 only) — driven by Nominatim result selection or
  // map-drag reverse geocoding. The hidden inputs read from here. Defaults
  // pre-fill from props so edit forms render with the persisted values.
  const [pickedProvince, setPickedProvince] = useState<{
    code: string;
    name: string;
  } | null>(
    defaultValue?.provinceCode
      ? {
          code: defaultValue.provinceCode,
          name: defaultValue.provinceCode, // best-effort; provinceByCode resolution happens server-side
        }
      : null,
  );
  const [pickedLocality, setPickedLocality] = useState<string | null>(
    defaultValue?.localityName ?? null,
  );
  // "¿Es acá?" (localidades-por-id B6, design addendum #1). The catalogue has
  // centroids, not boundaries, so a pin alone never names a locality: when the
  // reverse answer names no row, or a name two rows share, the candidates are
  // shown and the PERSON picks — never the form. `candidates` is what the last
  // pin offered; `pickedCandidate` what the person chose ("none" = declined).
  const [candidates, setCandidates] = useState<PlaceCandidate[]>([]);
  const [pickedCandidate, setPickedCandidate] = useState<PlaceCandidate | "none" | null>(null);
  const pickedRow = pickedCandidate !== null && pickedCandidate !== "none" ? pickedCandidate : null;

  // L2 address text + autocomplete state.
  const [addressText, setAddressText] = useState<string>(
    defaultValue?.address ?? defaultValue?.description ?? "",
  );
  const [geocodeLoading, setGeocodeLoading] = useState<"none" | "forward" | "reverse">("none");
  const [geocodeResults, setGeocodeResults] = useState<GeocodeResult[]>([]);
  const [geocodeMessage, setGeocodeMessage] = useState<"empty" | "failed" | null>(null);
  // Label of the auto-picked forward-geocode match. The single-result path
  // used to be SILENT: the pin jumped but nothing said WHAT was matched
  // (Cowork QA parte A, 2026-08-06 — the wizard "geocodifica sin feedback").
  // pickResult/reverse repopulate the input itself, so only auto-pick needs it.
  const [geocodeFoundLabel, setGeocodeFoundLabel] = useState<string | null>(null);
  // Suppress forward effect when address text was filled by a result pick
  // or by reverse geocoding (prevents infinite loops).
  //
  // PRIMED AT MOUNT when defaultValue arrives with BOTH an address and a point.
  // That pairing means the coordinates are already authoritative — a pin the
  // user placed, whose address came back from REVERSE geocoding — so running
  // the forward geocode would take the address and move the pin to whatever
  // Nominatim matches, flipping `source` to "geocodificada" and rewriting the
  // jurisdiction with it. A pin dropped on a vacant lot jumps to the street
  // number across the road, and if that crosses a boundary the denuncia routes
  // to the wrong authority — the exact guarantee the exact-point requirement
  // exists to protect.
  //
  // Latent until 2026-08-08: no caller passed a defaultValue carrying both, so
  // this effect had never run against a seeded address. The denuncia draft
  // restore became the first (adversarial review, second pass).
  const skipNextForward = useRef(
    Boolean(
      (defaultValue?.address ?? defaultValue?.description ?? "").trim() &&
        defaultValue?.lat != null &&
        defaultValue?.lng != null,
    ),
  );

  const addressInputName = inputNames?.description ?? "locationAddress";
  const latInputName = inputNames?.lat ?? "locationLat";
  const lngInputName = inputNames?.lng ?? "locationLng";

  // Forward geocoding (address text → coords + jurisdiction), debounced.
  useEffect(() => {
    if (!isL2) return;
    if (skipNextForward.current) {
      skipNextForward.current = false;
      return;
    }
    const trimmed = addressText.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setGeocodeResults([]);
      setGeocodeMessage(null);
      setGeocodeFoundLabel(null);
      return;
    }

    const forwardAction = allowAnonymous ? geocodeAddressPublicAction : geocodeAddressAction;
    const timer = setTimeout(async () => {
      setGeocodeLoading("forward");
      setGeocodeMessage(null);
      setGeocodeFoundLabel(null);
      try {
        const results = await forwardAction(trimmed, {
          province: biasProvince,
          locality: biasLocality,
        });
        if (results.length === 0) {
          setGeocodeResults([]);
          setGeocodeMessage("empty");
        } else {
          // Auto-place pin and provisional jurisdiction on top result.
          // LocationPicker only fires onChange on user gestures, so this
          // doesn't loop back into handlePointChange.
          setPoint({ lat: results[0].lat, lng: results[0].lng });
          setLocationSource("geocodificada");
          applyJurisdictionFromResult(results[0]);
          setGeocodeFoundLabel(results[0].display_name);
          // Show alternates so the user can correct the top guess.
          setGeocodeResults(results.length > 1 ? results : []);
        }
      } catch {
        setGeocodeMessage("failed");
      } finally {
        setGeocodeLoading("none");
      }
    }, FORWARD_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [addressText, biasProvince, biasLocality, isL2, allowAnonymous]);

  // Notify the parent whenever location presence changes (UI-7 B6). Presence =
  // any of jurisdiction / address text / map point set.
  // biome-ignore lint/correctness/useExhaustiveDependencies: onLocationPresenceChange is a stable callback from the parent; including it would loop on inline closures.
  useEffect(() => {
    if (!onLocationPresenceChange) return;
    const hasLocation =
      pickedProvince != null ||
      pickedLocality != null ||
      addressText.trim().length > 0 ||
      point != null;
    onLocationPresenceChange(hasLocation);
  }, [pickedProvince, pickedLocality, addressText, point]);

  // Notify the parent whenever the EXACT map point presence changes (FIX #3A).
  // biome-ignore lint/correctness/useExhaustiveDependencies: onPointPresenceChange is a stable callback from the parent; including it would loop on inline closures.
  useEffect(() => {
    if (!onPointPresenceChange) return;
    onPointPresenceChange(point != null);
  }, [point]);

  // Emit the full structured value whenever the L2-derived state changes, so a
  // parent can lift it (DenunciaWizard M-followup). Opt-in — no-op unless a
  // consumer passes onChange.
  // biome-ignore lint/correctness/useExhaustiveDependencies: onChange is a stable parent callback; including it would loop on inline closures.
  useEffect(() => {
    if (!onChange) return;
    onChange({
      provinceCode: pickedProvince?.code ?? null,
      provinceName: pickedProvince?.name ?? null,
      localityName: pickedLocality,
      lat: point?.lat ?? null,
      lng: point?.lng ?? null,
      address: isL2 ? addressText.trim() || null : null,
      source: point ? locationSource : null,
      localityIndecId: pickedRow?.localityIndecId ?? null,
      localityPicked: pickedRow !== null,
    });
  }, [pickedProvince, pickedLocality, point, addressText, locationSource, isL2, pickedCandidate]);

  // Reverse geocoding (coords → address + jurisdiction). Fires on a map
  // click/drag gesture — the only way a point can be set by hand now.
  async function handlePointChange(newPoint: { lat: number; lng: number }) {
    setPoint(newPoint);
    setLocationSource("pin_manual");
    // A new pin is a new question: what the last one offered no longer holds.
    setCandidates([]);
    setPickedCandidate(null);
    if (!isL2) return;
    setGeocodeLoading("reverse");
    setGeocodeMessage(null);
    const reverseAction = allowAnonymous ? reverseGeocodePublicAction : reverseGeocodeAction;
    try {
      const r = await reverseAction(newPoint.lat, newPoint.lng);
      if (r) {
        skipNextForward.current = true;
        setAddressText(r.display_name);
        applyJurisdictionFromResult(r);
        setGeocodeResults([]);
        setGeocodeFoundLabel(null);
        setCandidates(r.place?.status === "resolved" ? [] : (r.place?.candidates ?? []));
      } else {
        setGeocodeMessage("empty");
      }
    } catch {
      setGeocodeMessage("failed");
    } finally {
      setGeocodeLoading("none");
    }
  }

  // Map a Nominatim result's free-text province name to an ISO code via
  // PROVINCES. Sets pickedProvince + pickedLocality (best effort; both
  // null when the result doesn't resolve cleanly).
  function applyJurisdictionFromResult(r: {
    province: string | null;
    locality: string | null;
  }): void {
    const province: Province | null = r.province ? provinceByName(r.province) : null;
    setPickedProvince(province ? { code: province.code, name: province.name } : null);
    setPickedLocality(r.locality ?? null);
  }

  /** The person's answer to "¿Es acá?": a candidate row, or none of them. */
  function pickCandidate(choice: PlaceCandidate | "none") {
    setPickedCandidate(choice);
    if (choice === "none") {
      // Province-level: the place is kept, the locality left to the queue.
      setPickedLocality(null);
      return;
    }
    const province = provinceByName(choice.provinceName);
    setPickedProvince(province ? { code: province.code, name: province.name } : null);
    setPickedLocality(choice.localityName);
  }

  function pickResult(result: GeocodeResult) {
    setCandidates([]);
    setPickedCandidate(null);
    skipNextForward.current = true;
    setAddressText(result.display_name);
    setPoint({ lat: result.lat, lng: result.lng });
    setLocationSource("geocodificada");
    applyJurisdictionFromResult(result);
    setGeocodeResults([]);
    setGeocodeMessage(null);
    // The input now carries the picked label — the confirmation line would
    // just repeat it.
    setGeocodeFoundLabel(null);
  }

  return (
    <div className="space-y-4">
      {/* L1 (single input) — cross-province locality autocomplete. Province is
          derived from the chosen locality. */}
      {!isL2 && !cascade && (
        <div className="space-y-1.5">
          <label htmlFor="localityName-input" className="block text-sm font-medium text-ln-ink">
            {l1Label}
            {required && (
              <span className="ml-1 text-[var(--color-ln-seal)]" aria-hidden="true">
                *
              </span>
            )}
          </label>
          <LocalityPickerAcross
            id="localityName"
            required={required}
            defaultValue={{
              provinceCode: defaultValue?.provinceCode ?? null,
              localityName: defaultValue?.localityName ?? null,
            }}
            // On anonymous surfaces (signup, before a session exists) the default
            // auth-gated search action redirects to /login the moment the user
            // types — the picker silently shows "Sin resultados". Route through the
            // no-auth public action there; authed L1 surfaces keep the default.
            searchAction={allowAnonymous ? searchLocalitiesPublicAction : undefined}
          />
        </div>
      )}

      {/* L1 (cascade) — Provincia <select> gates a province-scoped locality
          autocomplete. Someone typing "Palermo" no longer sees the CABA barrio
          AND an unrelated locality elsewhere: they pick the province first, then
          the search is scoped to it. Wire contract is UNCHANGED — the picker
          still emits provinceCode / provinceName / localityName /
          localityNameIndecId, and it only emits a provinceCode when a real
          ar_localities row is picked (never from the raw <select>), so a
          free-typed locality still fails the LOCALITY_UNRESOLVED guard. */}
      {!isL2 && cascade && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="cascade-province" className="block text-sm font-medium text-ln-ink">
              Provincia
              {required && (
                <span className="ml-1 text-[var(--color-ln-seal)]" aria-hidden="true">
                  *
                </span>
              )}
            </label>
            <LnSelect
              id="cascade-province"
              value={cascadeProvinceCode ?? ""}
              onChange={(e) => setCascadeProvinceCode(e.target.value || null)}
              required={required}
              aria-required={required || undefined}
            >
              <option value="" disabled>
                Elegí la provincia
              </option>
              {PROVINCES.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </LnSelect>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="localityName-input" className="block text-sm font-medium text-ln-ink">
              {l1Label === "Localidad" ? "Localidad o barrio" : l1Label}
              {required && (
                <span className="ml-1 text-[var(--color-ln-seal)]" aria-hidden="true">
                  *
                </span>
              )}
            </label>
            <LocalityPickerAcross
              // Remount on province change so the query + picked locality reset —
              // a Palermo/CABA pick never survives a switch to Buenos Aires.
              key={cascadeProvinceCode ?? "none"}
              id="localityName"
              required={required}
              scopeProvinceCode={cascadeProvinceCode}
              disabled={!cascadeProvinceCode}
              defaultValue={{
                // Only carry a province from a genuinely resolved prior pick
                // (edit adoption). In the create alta this is null, so a
                // free-typed locality carries no province and stays UNRESOLVED.
                provinceCode: defaultValue?.provinceCode ?? null,
                localityName: defaultValue?.localityName ?? null,
              }}
              placeholder={
                cascadeProvinceCode ? "Buscá tu localidad o barrio" : "Elegí primero la provincia"
              }
              searchAction={allowAnonymous ? searchLocalitiesPublicAction : undefined}
            />
          </div>
        </div>
      )}

      {/* L2 — Nominatim autocomplete on the address line, plus map for
          confirmation and drag-to-adjust. No separate province/locality
          inputs; the autocomplete (or the map drag) fills them via the
          hidden inputs below. */}
      {isL2 && (
        <>
          <div className="space-y-1.5">
            <label htmlFor={addressInputName} className="block text-sm font-medium text-ln-ink">
              Dirección o referencia
            </label>
            <div className="relative">
              <LnInput
                id={addressInputName}
                name={addressInputName}
                type="text"
                value={addressText}
                onChange={(e) => setAddressText(e.target.value)}
                placeholder="Empezá a tipear: calle y altura, esquina, plaza…"
                aria-busy={geocodeLoading !== "none"}
              />
              {geocodeLoading !== "none" && (
                <span
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ln-mute "
                  aria-live="polite"
                >
                  {geocodeLoading === "forward" ? "Buscando…" : "Identificando…"}
                </span>
              )}
            </div>
            {geocodeResults.length > 0 && (
              <ul className="border border-ln-line  rounded-lg divide-y divide-ln-line  bg-ln-card  text-sm overflow-hidden">
                {geocodeResults.map((r) => (
                  <li key={`${r.lat}-${r.lng}-${r.display_name}`}>
                    <button
                      type="button"
                      onClick={() => pickResult(r)}
                      className="block w-full text-left px-3 py-2 hover:bg-ln-stripe  text-ln-ink "
                    >
                      {r.display_name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {geocodeFoundLabel && geocodeMessage === null && (
              <output className="block text-xs text-ln-ok">
                Encontramos: {geocodeFoundLabel}. Ajustá el pin si no es el punto exacto.
              </output>
            )}
            {geocodeMessage === "empty" && (
              <p className="text-xs text-ln-mute ">
                No encontramos esa dirección. Podés moverte por el mapa para ajustarla.
              </p>
            )}
            {geocodeMessage === "failed" && (
              <p className="text-xs text-ln-warn ">
                No pudimos buscar la dirección ahora. Tipeá lo que sepas y movete por el mapa.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <p className="block text-sm font-medium text-ln-ink">Ajuste fino</p>
            <p className="text-xs text-ln-mute ">
              Tocá el mapa para marcar el punto o arrastrá el pin para ajustarlo.
            </p>
            <LocationPicker
              value={point}
              onChange={handlePointChange}
              defaultCenter={defaultCenter}
            />
            {point && (
              <p className="text-xs text-ln-mute  font-ln-mono">
                {point.lat.toFixed(6)}, {point.lng.toFixed(6)}
              </p>
            )}
          </div>

          {candidates.length > 0 && (
            <fieldset className="space-y-2" aria-describedby="place-candidates-hint">
              <legend className="block text-sm font-medium text-ln-ink">
                ¿En qué localidad fue?
              </legend>
              <p id="place-candidates-hint" className="text-xs text-ln-mute ">
                Con el punto del mapa no alcanza para saberlo. Elegí la localidad que corresponde.
              </p>
              <div role="radiogroup" aria-label="¿En qué localidad fue?" className="space-y-1.5">
                {candidates.map((c) => (
                  <label
                    key={`${c.provinceCode}-${c.localityIndecId ?? c.localityName}-${c.departmentName ?? ""}`}
                    className="flex items-center gap-2 text-sm text-ln-ink"
                  >
                    <input
                      type="radio"
                      name="placeCandidate"
                      checked={pickedRow === c}
                      onChange={() => pickCandidate(c)}
                    />
                    {candidateLabel(c)}
                  </label>
                ))}
                <label className="flex items-center gap-2 text-sm text-ln-ink">
                  <input
                    type="radio"
                    name="placeCandidate"
                    checked={pickedCandidate === "none"}
                    onChange={() => pickCandidate("none")}
                  />
                  {NONE_OF_THESE}
                </label>
              </div>
            </fieldset>
          )}

          {/* L2 hidden inputs — jurisdiction derived from autocomplete pick
              or map-drag reverse-geocoding; lat/lng from the pin. */}
          <input type="hidden" name="provinceCode" value={pickedProvince?.code ?? ""} />
          <input type="hidden" name="provinceName" value={pickedProvince?.name ?? ""} />
          <input type="hidden" name="localityName" value={pickedLocality ?? ""} />
          <input
            type="hidden"
            name="localityNameIndecId"
            value={pickedRow?.localityIndecId ?? ""}
          />
          <input type="hidden" name="localityPicked" value={pickedRow ? "1" : ""} />
          <input type="hidden" name={latInputName} value={point ? String(point.lat) : ""} />
          <input type="hidden" name={lngInputName} value={point ? String(point.lng) : ""} />
          {/* panorama-event-points Slice 1: coordinate-capture origin. Only
              emitted alongside a real point; consumers that don't read it ignore it. */}
          <input
            type="hidden"
            name="locationSource"
            value={point && locationSource ? locationSource : ""}
          />
        </>
      )}
    </div>
  );
}
