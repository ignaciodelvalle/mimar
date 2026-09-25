// LA UBICACIÓN, EN UN MAPA — the one component every "¿dónde fue?" uses (M17).
//
// WHAT IT REPLACES. Lost last-seen, the denuncia and the bite report took an
// address as free text (the denuncia added a tap-a-candidate list). The web has
// had a map all along (`components/LocationFields.tsx`, "L2"): search an
// address, confirm the point on a map, adjust it, and the jurisdiction is
// derived from the point. This is that, for a phone, in one component.
//
// NO DEVICE LOCATION, BY DECISION (PO, 2026-09-24). The point is where the
// EVENT happened, not where the reporter stands — "la mordedura cuenta donde
// ocurrió" — and a GPS prefill produces confidently wrong points nobody
// corrects. So there is no "usar mi ubicación": the map starts on the place the
// screen knows (the animal's or the case's locality, by search) and the person
// puts the pin where it happened. Nothing here imports `expo-location`, and a
// fence test keeps it that way.
//
// THE STEPS, and why each is a step:
//   1. Search the address (server-side Nominatim, `POST /api/v1/geocoding`).
//   2. Tap a result: the map flies there and the pin sits on it.
//   3. Drag the MAP under the pin to adjust — the address under the map is
//      re-read from the point (reverse geocoding) every time it settles.
//   4. "¿Es acá?" → "Sí, es acá". Nothing reaches the form before this tap:
//      an unconfirmed point is a guess, and a guess routes a case.
//      When the point names no locality with certainty — no name, or a name
//      two rows of the province share (Mechita: partido Alberti and partido
//      Bragado) — the server sends the candidate rows and the PERSON picks
//      one, each labelled with its department (localidades-por-id B6). Nothing
//      is picked for them; "Ninguna de estas" keeps the point with no locality.
//
// LAZY AND SINGLE. The native map VIEW mounts only while the step is open (the
// JS module is imported normally; it is the GL surface that costs), and one
// screen shows one picker at a time: on a J7 (2 GB, Exynos 7580) a GL surface
// is the most expensive thing this app draws.
//
// THE FALLBACK. If the map cannot load (tiles blocked, style error), the search
// list still works — tapping a result places the point without the map — and
// the screen's own free-text field stays for when there is no connection at
// all.

import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type {
  GeocodingCandidateV1,
  GeocodingJurisdictionV1,
  GeocodingMatchV1,
} from "@dim/contract/api";

import { apiFailureMessage } from "../api/client";
import { sendGeocodingCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body } from "./components";
import { FONTS } from "./fonts";
import { Callout, FieldLabel, LinkText, PrimaryButton, SecondaryButton, TextField } from "./kit";
import { LocationMap, type MapPoint } from "./location-map";
import { COLORS, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "./theme";

/** What a confirmed pick hands the screen. */
export type PickedLocation = {
  lat: number;
  lng: number;
  /** The readable address, or `null` when the geocoder had none for the point. */
  address: string | null;
  /** `pin_manual` = moved by hand; `geocodificada` = a search result as is. */
  source: "pin_manual" | "geocodificada";
  /** Derived on the server from the point, as the web derives it. */
  jurisdiction: GeocodingJurisdictionV1 | null;
  /** True when the person picked `jurisdiction` from the candidates (B6). */
  localityPicked?: boolean;
};

/** "Mechita (Bragado), Buenos Aires" — the department tells two homonyms apart. */
export function candidateLabel(c: GeocodingCandidateV1): string {
  const department = c.departmentName ? ` (${c.departmentName})` : "";
  return `${c.localityName}${department}, ${c.provinceName}`;
}

/** Argentina, whole — where the map opens when the screen knows nothing. */
const COUNTRY_CENTER: MapPoint = { lat: -38.4, lng: -63.6 };
const COUNTRY_ZOOM = 4;

export const LOCATION_PICKER_COPY = {
  open: "Marcar el lugar en el mapa",
  change: "Cambiar el lugar",
  searchLabel: "Buscar la dirección",
  searchButton: "Buscar",
  searching: "Buscando…",
  noMatches:
    "No encontramos esa dirección. Probá escribirla de otra forma, por ejemplo calle y número, o una esquina.",
  moveHint: "Mové el mapa hasta que la punta del pin quede justo en el lugar.",
  resolving: "Buscando la dirección de ese punto…",
  noAddress: "No encontramos una dirección para ese punto, pero el lugar queda marcado.",
  confirmQuestion: "¿Es acá?",
  whichLocality: "¿En qué localidad fue? Con el punto no alcanza para saberlo.",
  noneOfThese: "Ninguna de estas / no sé",
  confirm: "Sí, es acá",
  cancel: "Cancelar",
  mapFailed:
    "No pudimos cargar el mapa. Elegí la dirección de la lista: el lugar queda marcado igual.",
} as const;

export function LocationPicker({
  label,
  required = false,
  value,
  onChange,
  startQuery = null,
  disabled = false,
}: {
  label: string;
  required?: boolean;
  value: PickedLocation | null;
  onChange: (value: PickedLocation | null) => void;
  /** Text to centre the map on when it opens (the animal's or case's locality). */
  startQuery?: string | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <View style={styles.field}>
      <FieldLabel required={required}>{label}</FieldLabel>
      {value !== null && !open ? (
        <View style={styles.summary}>
          <Text style={styles.summaryText}>{value.address ?? "Lugar marcado en el mapa"}</Text>
          {value.jurisdiction ? (
            <Text style={styles.summaryMeta}>
              {value.jurisdiction.localityName}, {value.jurisdiction.provinceName}
            </Text>
          ) : null}
        </View>
      ) : null}
      {open ? (
        <PickerStep
          value={value}
          startQuery={startQuery}
          onConfirm={(picked) => {
            onChange(picked);
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      ) : (
        <SecondaryButton
          label={value === null ? LOCATION_PICKER_COPY.open : LOCATION_PICKER_COPY.change}
          disabled={disabled}
          onPress={() => setOpen(true)}
        />
      )}
    </View>
  );
}

/**
 * `failure`: why the address of the point could not be read (a rate limit, no
 * connection) — shown INSTEAD of "no address here", which is a claim about the
 * place the server never made. The point itself stays placed and confirmable.
 */
type Pending = PickedLocation & {
  resolving: boolean;
  failure?: string | null;
  /** The rows the point could be in, when it named none with certainty. */
  candidates?: GeocodingCandidateV1[];
};

function PickerStep({
  value,
  startQuery,
  onConfirm,
  onCancel,
}: {
  value: PickedLocation | null;
  startQuery: string | null;
  onConfirm: (picked: PickedLocation) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<GeocodingMatchV1[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const [pending, setPending] = useState<Pending | null>(
    value === null ? null : { ...value, resolving: false },
  );
  const [moveTo, setMoveTo] = useState<{ point: MapPoint; zoom: number; key: number } | null>(null);
  // The answer to the LATEST reverse request only: a slow answer for a point the
  // person already dragged past must not overwrite the newer one.
  const reverseSeq = useRef(0);
  const startedFrom = useRef(startQuery);

  const search = useCallback(async (text: string, quiet: boolean) => {
    if (!quiet) {
      setSearching(true);
      setError(null);
    }
    const result = await sendGeocodingCommand(sessionPort, { command: "search", query: text });
    if (!quiet) setSearching(false);
    if (result.outcome !== "ok" || result.payload.command !== "search") {
      if (!quiet) {
        setError(
          result.outcome === "ok"
            ? LOCATION_PICKER_COPY.noMatches
            : (apiFailureMessage(result) ?? LOCATION_PICKER_COPY.noMatches),
        );
      }
      return null;
    }
    return result.payload.matches;
  }, []);

  // Where the map opens: the confirmed point, else the screen's locality found
  // by a quiet search, else the whole country. Never the device.
  const [initial] = useState(() =>
    value !== null
      ? { center: { lat: value.lat, lng: value.lng }, zoom: 17 }
      : { center: COUNTRY_CENTER, zoom: COUNTRY_ZOOM },
  );
  const startsConfirmed = value !== null;
  useEffect(() => {
    const text = startedFrom.current;
    if (startsConfirmed || !text) return;
    let alive = true;
    void search(text, true).then((found) => {
      const first = found?.[0];
      if (alive && first) {
        // A LOCALITY, not a street: open wide enough to find the block.
        setMoveTo({ point: { lat: first.lat, lng: first.lng }, zoom: 13, key: Date.now() });
      }
    });
    return () => {
      alive = false;
    };
  }, [search, startsConfirmed]);

  const runSearch = async () => {
    if (query.trim().length < 3) return;
    const found = await search(query.trim(), false);
    if (found === null) return;
    setMatches(found);
    if (found.length === 0) setError(LOCATION_PICKER_COPY.noMatches);
  };

  const pickMatch = (match: GeocodingMatchV1) => {
    reverseSeq.current += 1;
    setPending({
      lat: match.lat,
      lng: match.lng,
      address: match.label,
      source: "geocodificada",
      jurisdiction: match.jurisdiction,
      resolving: false,
    });
    setMoveTo({ point: { lat: match.lat, lng: match.lng }, zoom: 17, key: Date.now() });
  };

  const onCenterChange = async (point: MapPoint, byHand: boolean) => {
    // A camera move the app made (flying to a result) is not the person moving
    // the pin; the result's own address stays.
    if (!byHand) return;
    const seq = ++reverseSeq.current;
    setPending({
      lat: point.lat,
      lng: point.lng,
      address: null,
      source: "pin_manual",
      jurisdiction: null,
      resolving: true,
    });
    const result = await sendGeocodingCommand(sessionPort, {
      command: "reverse",
      lat: point.lat,
      lng: point.lng,
    });
    if (seq !== reverseSeq.current) return;
    const answer =
      result.outcome === "ok" && result.payload.command === "reverse" ? result.payload : null;
    const failure = result.outcome === "ok" ? null : apiFailureMessage(result);
    const place = answer?.place;
    setPending({
      lat: point.lat,
      lng: point.lng,
      address: answer?.label ?? null,
      source: "pin_manual",
      jurisdiction: answer?.jurisdiction ?? null,
      resolving: false,
      failure,
      candidates: place && place.status !== "resolved" ? place.candidates : [],
    });
  };

  /** The person's answer to "¿en qué localidad fue?": a row, or none. */
  const pickCandidate = (c: GeocodingCandidateV1 | null) => {
    setPending((current) => {
      if (current === null) return current;
      const { localityPicked: _was, ...rest } = current;
      return c === null
        ? { ...rest, jurisdiction: null }
        : {
            ...rest,
            jurisdiction: {
              provinceCode: c.provinceCode,
              provinceName: c.provinceName,
              localityName: c.localityName,
              localityIndecId: c.localityIndecId,
            },
            localityPicked: true,
          };
    });
  };

  return (
    <View style={styles.step}>
      <TextField
        label={LOCATION_PICKER_COPY.searchLabel}
        placeholder="Calle y número, o una esquina"
        value={query}
        onChangeText={setQuery}
        returnKeyType="search"
        onSubmitEditing={() => void runSearch()}
      />
      <SecondaryButton
        label={searching ? LOCATION_PICKER_COPY.searching : LOCATION_PICKER_COPY.searchButton}
        disabled={searching || query.trim().length < 3}
        onPress={() => void runSearch()}
      />
      {error !== null ? (
        <Callout tone="warn">
          <Body>{error}</Body>
        </Callout>
      ) : null}
      {matches !== null && matches.length > 0 ? (
        <View style={styles.matches} accessibilityRole="radiogroup">
          {matches.map((match) => {
            const active =
              pending !== null &&
              pending.source === "geocodificada" &&
              pending.lat === match.lat &&
              pending.lng === match.lng;
            return (
              <Pressable
                key={`${match.lat},${match.lng},${match.label}`}
                accessibilityRole="radio"
                accessibilityState={{ checked: active }}
                onPress={() => pickMatch(match)}
                style={[styles.match, active ? styles.matchActive : null]}
              >
                <Text style={styles.matchLabel}>{match.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {mapFailed ? (
        <Callout tone="warn">
          <Body>{LOCATION_PICKER_COPY.mapFailed}</Body>
        </Callout>
      ) : (
        <>
          <LocationMap
            initialCenter={initial.center}
            initialZoom={initial.zoom}
            moveTo={moveTo}
            onCenterChange={(point, byHand) => void onCenterChange(point, byHand)}
            onFail={() => setMapFailed(true)}
          />
          <Text style={styles.hint}>{LOCATION_PICKER_COPY.moveHint}</Text>
        </>
      )}

      {pending !== null ? (
        <View style={styles.confirm}>
          <Text style={styles.question}>{LOCATION_PICKER_COPY.confirmQuestion}</Text>
          <Text style={styles.address} accessibilityLiveRegion="polite">
            {pending.resolving
              ? LOCATION_PICKER_COPY.resolving
              : (pending.address ?? pending.failure ?? LOCATION_PICKER_COPY.noAddress)}
          </Text>
          {pending.candidates && pending.candidates.length > 0 ? (
            <View style={styles.matches} accessibilityRole="radiogroup">
              <Text style={styles.hint}>{LOCATION_PICKER_COPY.whichLocality}</Text>
              {pending.candidates.map((c) => {
                const label = candidateLabel(c);
                const checked =
                  pending.localityPicked === true &&
                  pending.jurisdiction?.localityName === c.localityName &&
                  pending.jurisdiction?.localityIndecId === c.localityIndecId &&
                  pending.jurisdiction?.provinceCode === c.provinceCode;
                return (
                  <Pressable
                    key={`${c.provinceCode},${c.localityIndecId ?? c.localityName},${c.departmentName ?? ""}`}
                    accessibilityRole="radio"
                    accessibilityLabel={label}
                    accessibilityState={{ checked }}
                    onPress={() => pickCandidate(c)}
                    style={[styles.match, checked ? styles.matchActive : null]}
                  >
                    <Text style={styles.matchLabel}>{label}</Text>
                  </Pressable>
                );
              })}
              <Pressable
                accessibilityRole="radio"
                accessibilityLabel={LOCATION_PICKER_COPY.noneOfThese}
                accessibilityState={{ checked: pending.localityPicked !== true }}
                onPress={() => pickCandidate(null)}
                style={styles.match}
              >
                <Text style={styles.matchLabel}>{LOCATION_PICKER_COPY.noneOfThese}</Text>
              </Pressable>
            </View>
          ) : pending.jurisdiction ? (
            <Text style={styles.summaryMeta}>
              {pending.jurisdiction.localityName}, {pending.jurisdiction.provinceName}
            </Text>
          ) : null}
          <PrimaryButton
            label={LOCATION_PICKER_COPY.confirm}
            disabled={pending.resolving}
            onPress={() => {
              const {
                resolving: _resolving,
                failure: _failure,
                candidates: _candidates,
                ...picked
              } = pending;
              onConfirm(picked);
            }}
          />
        </View>
      ) : null}
      <LinkText onPress={onCancel}>{LOCATION_PICKER_COPY.cancel}</LinkText>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { alignSelf: "stretch", gap: SPACE.sm },
  step: { gap: SPACE.sm },
  summary: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.control,
    padding: SPACE.md,
    backgroundColor: COLORS.surface,
  },
  summaryText: { fontFamily: FONTS.sans, fontSize: TYPE.md, color: COLORS.ink },
  summaryMeta: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkSoft },
  matches: { gap: SPACE.xs },
  match: {
    minHeight: TOUCH_TARGET,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.control,
    paddingVertical: SPACE.sm,
    paddingHorizontal: SPACE.md,
    backgroundColor: COLORS.surface,
  },
  matchActive: { borderColor: COLORS.accent, backgroundColor: COLORS.stripe },
  matchLabel: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.ink },
  hint: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkSoft },
  confirm: { gap: SPACE.xs },
  question: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.md, color: COLORS.ink },
  address: { fontFamily: FONTS.sans, fontSize: TYPE.md, color: COLORS.ink },
});
