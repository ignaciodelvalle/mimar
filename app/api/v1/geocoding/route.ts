// `POST /api/v1/geocoding` — the app's map, server side (M17).
//
// Two commands, both a READ wearing a POST (an address must not ride in a URL;
// see `packages/contract/src/input/geocoding.ts`):
//
//   · `search`  — address text → up to five candidate points;
//   · `reverse` — the point under the pin → a readable address.
//
// THE WEB'S OWN HELPERS, ON THE WEB'S OWN BUDGET. `geocodeAddressPublicOrThrow`
// and `reverseGeocodePublicAction` are what `components/LocationFields.tsx` and
// the denuncia door already call; both spend the shared per-IP `geocode_public`
// bucket, so the phone gets no allowance of its own. Nominatim is called from
// the server: the person's IP never reaches it.
//
// NO DEVICE LOCATION. The point is one a person placed on a map (PO,
// 2026-09-24). This door never receives a GPS fix because the app never reads
// one, and it stores nothing: nothing here writes a row.
//
// THE JURISDICTION IS DERIVED HERE, as the web's map derives it: the geocoder's
// province name to its ISO code, the locality against the INDEC catalogue.
// A pair that does not resolve is `null`, not a guess.
//
// ITS IP BUCKET IS IN THE WRITE FAMILY, and not because it writes: this repo
// files every POST handler under a write family (the direction check in
// `api-v1-rate-limit-families.test.ts`), and the welfare door's
// `resolve_location` — the same act — already lives there. The ceiling that
// actually binds is the shared `geocode_public` one (60/min per IP), well
// under this family's.
//
// AUTHENTICATED, like every `/api/v1` door: the app has no signed-out screen,
// and an anonymous `/api/v1` read would be a different rate-limit derivation.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { API_V1_AUTHENTICATED_WRITE_IP_LIMIT } from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import type { ReverseGeocodeResult } from "@/lib/infra/geocoding";
import { resolveCanonicalJurisdiction } from "@/lib/infra/jurisdiction-validation";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import {
  geocodeAddressPublicOrThrow,
  reverseGeocodePublicAction,
} from "@/src/modules/localities/application/geocoding/geocoding";
import {
  GEOCODING_PAYLOAD_VERSION,
  type GeocodingJurisdictionV1,
  type GeocodingReverseV1,
  type GeocodingSearchV1,
} from "@dim/contract/api";
import { geocodingCommandInputSchema } from "@dim/contract/input";

export const dynamic = "force-dynamic";

const AUTH_BUDGET_MS = 5_000;
const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;
const MAX_MATCHES = 5;

// AUTHORIZED, not opted out: this handler calls requireLiveUser in its own body,
// and a signed-in person is the whole authorization — an address lookup is
// about no animal and no record.
export async function POST(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  try {
    await enforceRateLimit(
      "api_v1_geocoding_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    // Fail open, like every sibling read: `geocode_public` below still bounds
    // what reaches Nominatim.
    reportError("api-v1-geocoding/ip-limiter", err);
  }

  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-geocoding-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiV1Error("invalid_request", 400);
  }
  const parsed = geocodingCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);
  const input = parsed.data;

  if (input.command === "search") {
    let matches: Awaited<ReturnType<typeof geocodeAddressPublicOrThrow>>;
    try {
      matches = await geocodeAddressPublicOrThrow(input.query);
    } catch (err) {
      // A spent shared budget is the limiter working; anything else is the
      // geocoder failing — which must not read as "that street does not exist"
      // (the denuncia door's A5-ciudadanas-04 lesson). No query in the sink.
      if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
      reportError("api-v1-geocoding/search", err);
      return unavailable();
    }
    const payload: GeocodingSearchV1 = {
      command: "search",
      version: GEOCODING_PAYLOAD_VERSION,
      matches: await Promise.all(
        matches.slice(0, MAX_MATCHES).map(async (match) => ({
          label: match.display_name,
          lat: match.lat,
          lng: match.lng,
          jurisdiction: await deriveJurisdiction(match.province, match.locality),
        })),
      ),
    };
    return apiV1Json(payload, { status: 200 });
  }

  let reversed: ReverseGeocodeResult | null;
  try {
    reversed = await reverseGeocodePublicAction(input.lat, input.lng);
  } catch (err) {
    reportError("api-v1-geocoding/reverse", err);
    return unavailable();
  }
  const payload: GeocodingReverseV1 = {
    command: "reverse",
    version: GEOCODING_PAYLOAD_VERSION,
    label: reversed?.display_name ?? null,
    jurisdiction: reversed ? await deriveJurisdiction(reversed.province, reversed.locality) : null,
  };
  return apiV1Json(payload, { status: 200 });
}

/** Province name + locality name → ISO code + INDEC row, or `null`. */
async function deriveJurisdiction(
  province: string | null,
  locality: string | null,
): Promise<GeocodingJurisdictionV1 | null> {
  if (!province || !locality) return null;
  try {
    const resolved = await resolveCanonicalJurisdiction({
      rawProvince: province,
      rawLocality: locality,
    });
    return {
      provinceCode: resolved.province.code,
      provinceName: resolved.province.name,
      localityName: resolved.locality.localityName,
      localityIndecId: resolved.locality.indecId,
    };
  } catch {
    return null;
  }
}

function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

function liveUserRefusal(reason: LiveUserFailureReason) {
  switch (reason) {
    case "NO_SESSION":
      return apiV1Error("auth_expired", 401);
    case "ACCOUNT_ERASED":
      return apiV1Error("account_erased", 403);
    case "DEACTIVATED":
      return apiV1Error("account_deactivated", 403);
    case "SHIFT_EXPIRED":
      return apiV1Error("session_shift_expired", 401);
    case "MAINTENANCE":
      return unavailable();
    default: {
      const unhandled: never = reason;
      throw new Error(`Unhandled liveness refusal: ${JSON.stringify(unhandled)}`);
    }
  }
}
