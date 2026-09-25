// geocoding.ts — use-cases moved verbatim from app/actions/geocoding.ts
// (strangler 47/61). Auth-gated and public variants, IP rate-limiting for
// anonymous callers.
//
// Two pairs of actions:
//   - geocodeAddressAction / reverseGeocodeAction       — auth check is
//     enforced by the caller (shim). These run the Nominatim fetch only.
//   - geocodeAddressPublicAction / reverseGeocodePublicAction — NO auth,
//     IP rate-limited. Used by anonymous public flows (PetSightingForm,
//     DenunciaWizard) where the user has no session by definition. The
//     critique-direcciones-2026-05-27 marks this as the pre-requisite for the
//     unified-location refactor: anonymous typing must not redirect to /login.
//
// Pure logic (Nominatim fetch + parser + per-instance token bucket) lives in
// lib/geocoding.ts.

import { headers } from "next/headers";

import {
  type GeocodeBias,
  type GeocodeResult,
  type ReverseGeocodeResult,
  geocodeAddress,
  reverseGeocode,
} from "@/lib/infra/geocoding";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { placeForClient } from "@/lib/place/place-for-client";
import { resolveGeocodedPin } from "@/lib/place/resolve-place";
import type { GeocodingPlaceV1 } from "@dim/contract/api";

/**
 * The web map's reverse answer: the geocoder's, plus how the point resolves
 * against the catalogue (localidades-por-id B6). When nothing names ONE row —
 * a name two rows share, or no name — `place` carries the candidate rows for
 * the person to pick ("¿Es acá?"); nothing is picked for them.
 */
export type ReversePinAnswer = ReverseGeocodeResult & { place: GeocodingPlaceV1 };

async function withPlace(
  lat: number,
  lng: number,
  reversed: ReverseGeocodeResult | null,
): Promise<ReversePinAnswer | null> {
  if (!reversed) return null;
  const place = await resolveGeocodedPin({ lat, lng }, reversed);
  return { ...reversed, place: placeForClient(place) };
}

// ---------------------------------------------------------------------------
// Authed variants — auth guard enforced by the calling shim
// ---------------------------------------------------------------------------

export async function geocodeAddressAction(
  query: string,
  bias?: GeocodeBias,
): Promise<GeocodeResult[]> {
  return geocodeAddress(query, bias);
}

export async function reverseGeocodeAction(
  lat: number,
  lng: number,
): Promise<ReversePinAnswer | null> {
  return withPlace(lat, lng, await reverseGeocode(lat, lng));
}

// ---------------------------------------------------------------------------
// Anonymous variants — IP rate-limited
// ---------------------------------------------------------------------------
//
// Limits picked to comfortably support real interactive use (autocomplete is
// 600ms-debounced client-side; a typical sighting flow does <10 lookups) while
// rejecting abuse:
//
//   60 requests per minute per IP — covers bursty typing
//   400 requests per hour per IP  — caps sustained automated abuse
//
// Both the persistent bucket AND the per-instance token bucket in
// lib/geocoding.ts protect Nominatim quota: the token bucket caps RPS across
// every caller in the worker, the persistent bucket caps each IP across all
// workers / cold starts.

const PUBLIC_GEOCODING_LIMIT = { maxPerMinute: 60, maxPerHour: 400 } as const;

async function callerIpAddress(): Promise<string> {
  const reqHeaders = await headers();
  return callerIp(reqHeaders);
}

// @no-auth-required: anonymous geocoding autocomplete on public surfaces
// (PetSightingForm, DenunciaWizard). IP rate-limited via enforceRateLimit;
// the pure helper at lib/geocoding.ts never logs the query string (spec D10).
export async function geocodeAddressPublicAction(
  query: string,
  bias?: GeocodeBias,
): Promise<GeocodeResult[]> {
  const ip = await callerIpAddress();
  try {
    await enforceRateLimit("geocode_public", ip, PUBLIC_GEOCODING_LIMIT);
  } catch (err) {
    if (err instanceof RateLimitError) return [];
    throw err;
  }
  return geocodeAddress(query, bias);
}

/**
 * The same act and the SAME bucket as `geocodeAddressPublicAction`, except that
 * a spent budget THROWS `RateLimitError` instead of coming back as `[]`.
 *
 * WHY BOTH SHAPES EXIST (A5-ciudadanas-04, and CANON-433's own reasoning one
 * door further along). The empty-list shape is right for the WEB's autocomplete:
 * `components/LocationFields.tsx` debounces a keystroke into this, and a
 * throwing helper there would turn typing into an exception path. It is wrong
 * for `POST /api/v1/welfare-reports` `resolve_location`, which is a REQUEST a
 * person made once and is waiting on: `matches: []` renders on the phone as "No
 * pudimos encontrar esa dirección. Probá escribirla de otra forma", so behind a
 * carrier gateway where the neighbours are filing web sightings, a tester types
 * "Av. Bustillo 1200", is told the street does not exist, retypes it three ways
 * — each attempt spending more of the same shared budget — and never files the
 * denuncia. That is an infrastructure refusal wearing the costume of a user
 * error, which is exactly what CANON-433 refused for the nominatim outage on
 * this very call; the limiter arm above was the half that got missed.
 *
 * THE BUCKET IS SHARED ON PURPOSE. Same endpoint name, same limit constant, same
 * IP: the point is not to give the phone its own allowance — it is to tell the
 * truth about the one it shares.
 */
// @no-auth-required: anonymous geocoding on public surfaces, same bucket as
// `geocodeAddressPublicAction`; the caller maps the refusal to a status code.
export async function geocodeAddressPublicOrThrow(
  query: string,
  bias?: GeocodeBias,
): Promise<GeocodeResult[]> {
  const ip = await callerIpAddress();
  await enforceRateLimit("geocode_public", ip, PUBLIC_GEOCODING_LIMIT);
  return geocodeAddress(query, bias);
}

/**
 * The reverse twin of `geocodeAddressPublicOrThrow`, for the same reason (M17
 * security review): the app's map asks "what is at this pin?" as a request a
 * person is waiting on, and a spent budget answered as `null` reads on the
 * phone as "no address here" — an infrastructure refusal in the costume of an
 * answer about the place. Same act, same bucket, same IP; a spent budget
 * THROWS `RateLimitError` and the route answers 429.
 *
 * Residual, stated: `reverseGeocode` itself still answers `null` when its own
 * per-instance token bucket (the Nominatim courtesy limit) is empty; that arm
 * cannot be told apart from "no address" without changing the shared helper.
 */
// @no-auth-required: anonymous reverse geocoding, same bucket as
// `reverseGeocodePublicAction`; the caller maps the refusal to a status code.
export async function reverseGeocodePublicOrThrow(
  lat: number,
  lng: number,
): Promise<ReverseGeocodeResult | null> {
  const ip = await callerIpAddress();
  await enforceRateLimit("geocode_public", ip, PUBLIC_GEOCODING_LIMIT);
  return reverseGeocode(lat, lng);
}

// @no-auth-required: anonymous reverse-geocoding on public surfaces. Returns
// null on rate-limit so the caller falls back to plain lat/lng without errors.
export async function reverseGeocodePublicAction(
  lat: number,
  lng: number,
): Promise<ReversePinAnswer | null> {
  const ip = await callerIpAddress();
  try {
    await enforceRateLimit("geocode_public", ip, PUBLIC_GEOCODING_LIMIT);
  } catch (err) {
    if (err instanceof RateLimitError) return null;
    throw err;
  }
  return withPlace(lat, lng, await reverseGeocode(lat, lng));
}
