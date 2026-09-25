// `POST /api/v1/geocoding` — find an address, or name the point under a pin.
//
// THE APP'S MAP NEEDS BOTH HALVES OF WHAT THE WEB'S MAP HAS (M17). The web's
// `LocationFields` calls `geocodeAddressPublicAction` as somebody types and
// `reverseGeocodePublicAction` when the pin is dropped; a phone cannot call a
// server action, so this door exposes the SAME two helpers, on the SAME shared
// `geocode_public` budget. Server-side Nominatim: the person's IP never reaches
// the geocoder, and no device location is involved anywhere — the point is one
// the person placed (PO decision, 2026-09-24: no GPS in this product).
//
// A POST AND NOT A GET, because an address in a query string lands in every
// access log between the phone and the server, and spec D10 forbids logging
// what somebody typed as an address.

import { z } from "zod";

export const GEOCODING_QUERY_MIN_LENGTH = 3;
export const GEOCODING_QUERY_MAX_LENGTH = 300;

export const GEOCODING_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "QUERY_REQUIRED",
  "COORDS_INVALID",
  "COORDS_OUT_OF_RANGE",
] as const;
export type GeocodingInputCode = (typeof GEOCODING_INPUT_CODES)[number];

const search = z.object({
  command: z.literal("search"),
  query: z
    .string({ error: "QUERY_REQUIRED" })
    .trim()
    .min(GEOCODING_QUERY_MIN_LENGTH, { error: "QUERY_REQUIRED" })
    .max(GEOCODING_QUERY_MAX_LENGTH, { error: "QUERY_REQUIRED" }),
});

const reverse = z.object({
  command: z.literal("reverse"),
  lat: z
    .number({ error: "COORDS_INVALID" })
    .min(-90, { error: "COORDS_OUT_OF_RANGE" })
    .max(90, { error: "COORDS_OUT_OF_RANGE" }),
  lng: z
    .number({ error: "COORDS_INVALID" })
    .min(-180, { error: "COORDS_OUT_OF_RANGE" })
    .max(180, { error: "COORDS_OUT_OF_RANGE" }),
});

export const geocodingCommandInputSchema = z.discriminatedUnion("command", [search, reverse]);
export type GeocodingCommandInput = z.infer<typeof geocodingCommandInputSchema>;

/** The first input code in a failed parse, for a client that shows one message. */
export function firstGeocodingInputCode(error: z.ZodError<unknown>): GeocodingInputCode | null {
  for (const issue of error.issues) {
    if ((GEOCODING_INPUT_CODES as readonly string[]).includes(issue.message)) {
      return issue.message as GeocodingInputCode;
    }
    if (issue.path[0] === "command") return "COMMAND_REQUIRED";
  }
  return null;
}
