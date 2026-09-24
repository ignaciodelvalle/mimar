// Pure server-side proxy to Nominatim/OSM for forward and reverse geocoding.
//
// This module holds the testable core: rate limiter + fetch + parser. The
// "use server" boundary (auth gating) lives in app/actions/geocoding.ts,
// which delegates here. Mirrors the writer/wrapper pattern from booking.ts.
//
// CRITICAL (spec D10): never log user-supplied query strings. Log only error
// type and rate-limit hits.
//
// Bias strategy: we DO NOT append the pet's jurisdiction to the q= string.
// That was the v1 approach and it actively broke common queries —
// "Florida y Lavalle, CABA, Ciudad Autónoma de Buenos Aires" is parsed by
// Nominatim as a strict address chain and returns zero results. Instead we
// pass viewbox+bounded=0 when the pet's province has a known bbox (see
// lib/ar-viewboxes.ts). bounded=0 is a soft priority, not a hard filter, so
// addresses outside the box (cross-jurisdiction incidents) still resolve.
//
// ---------------------------------------------------------------------------
// Endpoint, timeout and failure semantics (P3.1, 2026-07-31)
// ---------------------------------------------------------------------------
//
// ENDPOINT — `GEOCODING_BASE_URL` overrides the provider host. It is read at
// CALL time, not at module load, so a deploy/env change takes effect without a
// cold start and tests can point it at a stub. The public Nominatim instance
// stays the default; a shared GitHub-Actions egress IP is exactly the case
// where it gets 403/429'd, and there is no reason a third-party host should be
// the only reachable option. Any self-hosted Nominatim-compatible instance
// (the OSM docker image) works unchanged.
//
// TIMEOUT — `GEOCODING_TIMEOUT_MS` (default 8000, clamped to 1000..30000)
// bounds EACH provider request via AbortController. The forward path can issue
// up to three sequential requests (the typed query plus two corner-syntax
// retries), so `geocodeAddress` also carries a wall-clock BUDGET of the same
// size: once it is spent, remaining retry candidates are skipped instead of
// stacking another full timeout. Worst case is therefore ~2x the timeout (a
// retry that starts just under the deadline), not 3x.
//
// FAILURE SEMANTICS — a timeout is indistinguishable from any other transport
// failure on purpose: both raise `fetch_failed` on the forward path and return
// `null` on the reverse path. NOTHING in the intake blocks on this. Geocoding
// runs from the browser's debounced autocomplete, never inside the submit
// handler, so a slow or dead provider degrades the address field and leaves the
// citizen able to drop a map pin and send. The jurisdiction that would have
// come from the geocoder is then recovered server-side from the form text and
// marked NOT VERIFIED (PO decision D.11) — see lib/infra/jurisdiction-from-text.ts.
//
// CACHING — deliberately NONE, and this is a decision, not an omission. The
// repo does have a cross-request cache primitive (`unstable_cache` behind
// src/modules/panorama/application/data-cache.ts) and it would fit the shape of
// this call. It is not used here because the cache KEY would be the citizen's
// typed incident address on an anonymous maltrato form, and the module contract
// three paragraphs up (spec D10) is that user-supplied query strings are never
// persisted anywhere by us. A shared Data Cache entry is persistence. The
// per-instance token bucket below remains the provider-courtesy guard. If the
// PO ever trades that privacy posture for provider load, the primitive is
// already there — see also spec D4 (2026-05-17), which deferred caching for the
// same reason plus premature-optimization.

import { provinceViewbox } from "@/lib/reference/ar-viewboxes";
import { CONTACT_EMAILS, PRIMARY_MAIL_DOMAIN } from "@/lib/ui/contact";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
// dim-codename-ok: machine-to-machine header sent to Nominatim — no human
// reader, so this is not the "two issuers on one document" failure Rule 2
// exists to catch.
//
// EL DOMINIO SE FUE, EL CONTACTO SE QUEDA (2026-08-18). Esta cadena anunciaba
// `https://dim.ar`, un dominio que NO EXISTE — confirmado por el PO. La política
// de uso de OSM pide un contacto genuinamente monitoreado, y anunciar un sitio
// inexistente es lo contrario de eso: si alguien de OSM necesitara avisarnos de
// un abuso, seguiría un enlace muerto. El mail sí está monitoreado, así que
// queda como el contacto real y se cae la URL falsa.
//
// EL DOMINIO LLEGÓ (2026-09-09), y esta cadena cumple lo que se prometió arriba:
// vuelve a llevar su URL, ya con la marca pública, y el contacto pasa de una
// casilla personal a una de ROL.
//
// LA DIFERENCIA NO ES COSMÉTICA. La política de uso de OSM pide un contacto por
// el cual AVISARNOS de un abuso — es una dirección para RECIBIR, que es
// exactamente lo contrario de un `noreply`. `hola@` ya es una casilla que el
// producto publica en /privacidad, /terminos y el selector de localidades, sobre
// un dominio con MX verificado; y sobrevive a que una persona en particular no
// esté, que es medio punto de una dirección de rol.
//
// COMPUESTA DESDE `CONTACT_EMAILS` y no escrita a mano, por la razón que ese
// módulo documenta: el dominio se deletrea UNA vez en el repositorio. La versión
// anterior de esta constante anunciaba `https://dim.ar`, un dominio inexistente,
// durante meses.
const USER_AGENT = `miMAR/1.0 (+https://www.${PRIMARY_MAIL_DOMAIN}; contact: ${CONTACT_EMAILS.general})`;
const RATE_LIMIT_PER_SECOND = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 8000;
const MIN_REQUEST_TIMEOUT_MS = 1000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Provider base URL. `GEOCODING_BASE_URL` wins; trailing slashes are stripped so
 * `${base}/search` never produces a double slash. An empty/whitespace value is
 * treated as unset (the NEXT_PUBLIC_SITE_URL empty-string trap, same fix shape).
 */
export function geocodingBaseUrl(): string {
  const raw = (process.env.GEOCODING_BASE_URL ?? "").trim();
  return (raw || NOMINATIM_BASE).replace(/\/+$/, "");
}

/**
 * Per-request timeout in ms. `GEOCODING_TIMEOUT_MS` wins when it parses to a
 * finite number; the value is clamped so a typo ("0", "999999") cannot turn the
 * abort guard off or make it useless.
 */
export function geocodingTimeoutMs(): number {
  const parsed = Number.parseInt((process.env.GEOCODING_TIMEOUT_MS ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, parsed));
}

export type GeocodeResult = {
  lat: number;
  lng: number;
  display_name: string;
  province: string | null;
  locality: string | null;
};

export type ReverseGeocodeResult = {
  display_name: string;
  province: string | null;
  locality: string | null;
};

export type GeocodeBias = {
  province?: string | null;
  locality?: string | null;
};

// Token bucket — per-instance module state. In serverless, that's per warm
// instance. With debounced clients + Nominatim's 1 req/sec sustained policy,
// 5 tokens/sec is comfortable headroom.
let bucketTokens = RATE_LIMIT_PER_SECOND;
let bucketLastRefill = Date.now();

function consumeToken(): boolean {
  const now = Date.now();
  const elapsedSec = (now - bucketLastRefill) / 1000;
  bucketTokens = Math.min(RATE_LIMIT_PER_SECOND, bucketTokens + elapsedSec * RATE_LIMIT_PER_SECOND);
  bucketLastRefill = now;
  if (bucketTokens >= 1) {
    bucketTokens -= 1;
    return true;
  }
  return false;
}

// Test-only: reset bucket state between tests so they don't bleed into each other.
// Not part of the public surface; importers in production code must not call this.
export function __resetRateLimitForTests(): void {
  bucketTokens = RATE_LIMIT_PER_SECOND;
  bucketLastRefill = Date.now();
}

function pickLocality(address: Record<string, string | undefined> | undefined): string | null {
  if (!address) return null;
  // CABA special case: OSM returns the city-level name ("Buenos Aires") in
  // `address.city` for every point inside CABA, but the INDEC catalog holds CABA
  // as its 48 *barrios* (Palermo, Caballito, …), not "Buenos Aires". Prefer the
  // barrio (`suburb` / `city_district`) so the locality matches the catalog
  // instead of failing canonical validation on the denuncia/lost forms.
  const state = address.state ?? "";
  if (/ciudad aut[oó]noma de buenos aires|^\s*caba\s*$/i.test(state)) {
    return (
      address.suburb ??
      address.city_district ??
      address.city ??
      address.town ??
      address.village ??
      address.hamlet ??
      null
    );
  }
  return (
    address.city ?? address.town ?? address.suburb ?? address.village ?? address.hamlet ?? null
  );
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), geocodingTimeoutMs());
  try {
    return await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Corner ("esquina") query normalization — ciclo-perdido tester fix #4
// ---------------------------------------------------------------------------
//
// The sighting form's placeholder promises corners ("calle y altura, esquina,
// plaza…") but Nominatim does not parse the Spanish conjunction: "Gorriti y
// Serrano" returns zero results, while the provider's intersection syntax
// "Gorriti & Serrano" resolves. Detect "X y Z" / "X e Z" queries ("e" is the
// conjunction before i/hi words: "Callao e Hipólito Yrigoyen") and build
// "&"-joined candidates in BOTH street orders — Nominatim's intersection
// matching is order-sensitive on some data. Any ", locality" suffix the user
// typed is preserved on each candidate.
//
// "X entre Y y Z" is a between-streets reference, not a corner — left alone.
// Pure and exported for unit tests.
export function intersectionQueryCandidates(query: string): string[] {
  const trimmed = query.trim();
  const commaIdx = trimmed.indexOf(",");
  const head = (commaIdx === -1 ? trimmed : trimmed.slice(0, commaIdx)).trim();
  const suffix = commaIdx === -1 ? "" : trimmed.slice(commaIdx);
  if (/\bentre\b/i.test(head)) return [];
  const m = head.match(/^(.+?)\s+(?:y|e)\s+(.+)$/i);
  if (!m) return [];
  const a = m[1].trim();
  const b = m[2].trim();
  if (a.length < 2 || b.length < 2) return [];
  return [`${a} & ${b}${suffix}`, `${b} & ${a}${suffix}`];
}

/**
 * Forward geocode. Sends the user's query as typed; when that yields ZERO
 * results and the query looks like a street corner ("Gorriti y Serrano"),
 * retries with the provider's intersection syntax in both orderings
 * (best-effort: a failure or rate-limit during the retries returns the
 * original empty answer instead of surfacing an error).
 *
 * The retries share ONE wall-clock budget with the first request (see the
 * timeout note in the module header): once `geocodingTimeoutMs()` of real time
 * has elapsed, remaining candidates are abandoned rather than each starting a
 * fresh full-length timeout. A dead provider therefore costs ~1 timeout, not 3.
 */
export async function geocodeAddress(query: string, bias?: GeocodeBias): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const startedAt = Date.now();
  const budgetMs = geocodingTimeoutMs();

  const results = await geocodeQuery(trimmed, bias);
  if (results.length > 0) return results;

  for (const candidate of intersectionQueryCandidates(trimmed)) {
    if (Date.now() - startedAt >= budgetMs) {
      console.warn("[geocoding] retry budget exhausted; skipping corner candidates");
      break;
    }
    try {
      const alt = await geocodeQuery(candidate, bias);
      if (alt.length > 0) return alt;
    } catch {
      // Best-effort fallback: the original query already answered (empty).
      break;
    }
  }
  return results;
}

async function geocodeQuery(trimmed: string, bias?: GeocodeBias): Promise<GeocodeResult[]> {
  if (!consumeToken()) {
    console.warn("[geocoding] rate limit hit (forward)");
    throw new Error("rate_limited");
  }

  const url = new URL(`${geocodingBaseUrl()}/search`);
  url.searchParams.set("q", trimmed);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", "ar");
  url.searchParams.set("accept-language", "es");

  // Soft priority bias by province bbox when known. bounded=0 means the box
  // is a hint — Nominatim still returns results outside it (lower-ranked).
  const viewbox = provinceViewbox(bias?.province ?? null);
  if (viewbox) {
    url.searchParams.set("viewbox", viewbox.join(","));
    url.searchParams.set("bounded", "0");
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(url.toString());
  } catch (err) {
    console.error(
      "[geocoding] fetch failed (forward):",
      err instanceof Error ? err.name : "unknown",
    );
    throw new Error("fetch_failed");
  }

  if (!response.ok) {
    console.error("[geocoding] non-2xx (forward):", response.status);
    throw new Error("provider_error");
  }

  const raw = (await response.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
    address?: Record<string, string | undefined>;
  }>;

  return raw
    .map((r) => ({
      lat: Number.parseFloat(r.lat),
      lng: Number.parseFloat(r.lon),
      display_name: r.display_name,
      province: r.address?.state ?? null,
      locality: pickLocality(r.address),
    }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<ReverseGeocodeResult | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  if (!consumeToken()) {
    console.warn("[geocoding] rate limit hit (reverse)");
    return null;
  }

  const url = new URL(`${geocodingBaseUrl()}/reverse`);
  url.searchParams.set("lat", lat.toFixed(7));
  url.searchParams.set("lon", lng.toFixed(7));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "es");

  let response: Response;
  try {
    response = await fetchWithTimeout(url.toString());
  } catch (err) {
    console.error(
      "[geocoding] fetch failed (reverse):",
      err instanceof Error ? err.name : "unknown",
    );
    return null;
  }

  if (!response.ok) {
    if (response.status === 404) return null;
    console.error("[geocoding] non-2xx (reverse):", response.status);
    return null;
  }

  const raw = (await response.json()) as {
    display_name?: string;
    address?: Record<string, string | undefined>;
  };

  if (!raw.display_name) return null;

  return {
    display_name: raw.display_name,
    province: raw.address?.state ?? null,
    locality: pickLocality(raw.address),
  };
}
