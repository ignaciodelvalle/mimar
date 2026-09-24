"use server";

// geocoding.ts — thin shim (strangler migration 47/61).
//
// Business logic moved to:
//   src/modules/localities/application/geocoding/
//
// This file re-exports the types and provides thin Action wrappers so all
// existing UI importers keep working unchanged.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import {
  geocodeAddressAction as _geocodeAddressAction,
  geocodeAddressPublicAction as _geocodeAddressPublicAction,
  reverseGeocodeAction as _reverseGeocodeAction,
  reverseGeocodePublicAction as _reverseGeocodePublicAction,
} from "@/src/modules/localities/application/geocoding/geocoding";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { GeocodeBias, GeocodeResult, ReverseGeocodeResult } from "@/lib/infra/geocoding";

// ---------------------------------------------------------------------------
// Action wrappers — auth-gated variants: guard here, module does the work
// ---------------------------------------------------------------------------

export async function geocodeAddressAction(
  ...args: Parameters<typeof _geocodeAddressAction>
): Promise<Awaited<ReturnType<typeof _geocodeAddressAction>>> {
  await requireUserOrRedirect();
  return _geocodeAddressAction(...args);
}

export async function reverseGeocodeAction(
  ...args: Parameters<typeof _reverseGeocodeAction>
): Promise<Awaited<ReturnType<typeof _reverseGeocodeAction>>> {
  await requireUserOrRedirect();
  return _reverseGeocodeAction(...args);
}

// ---------------------------------------------------------------------------
// Action wrappers — anonymous variants: no auth required, IP rate-limited
// ---------------------------------------------------------------------------

// @no-auth-required: anonymous geocoding autocomplete on public surfaces
// (PetSightingForm, DenunciaWizard). IP rate-limited via enforceRateLimit;
// the pure helper at lib/geocoding.ts never logs the query string (spec D10).
export async function geocodeAddressPublicAction(
  ...args: Parameters<typeof _geocodeAddressPublicAction>
): Promise<Awaited<ReturnType<typeof _geocodeAddressPublicAction>>> {
  return _geocodeAddressPublicAction(...args);
}

// @no-auth-required: anonymous reverse-geocoding on public surfaces. Returns
// null on rate-limit so the caller falls back to plain lat/lng without errors.
export async function reverseGeocodePublicAction(
  ...args: Parameters<typeof _reverseGeocodePublicAction>
): Promise<Awaited<ReturnType<typeof _reverseGeocodePublicAction>>> {
  return _reverseGeocodePublicAction(...args);
}
