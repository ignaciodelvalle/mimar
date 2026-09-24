// What a client may SEND to `POST /api/v1/me/push-targets`.
//
// TWO COMMANDS, AND THE SECOND IS NOT A DELETE
// ---------------------------------------------------------------------------
// `register` and `revoke`. There is no third, and `revoke` is deliberately not
// spelled `delete`: the row is soft-revoked and the table carries no DELETE
// policy at all (migration 0222), so a command named for deletion would name an
// operation the database refuses. A person signing out stops receiving pushes;
// the row stays until the nightly purge or an art. 16 erasure removes it.
//
// THIS IS NOT A TRANSCRIPTION OF A WEB CONTRACT, because there is no web
// equivalent to transcribe. Web push registers a browser PushSubscription
// through `app/actions/`, whose shape (endpoint + two Web Crypto keys) has
// nothing in common with a device token. The two channels are siblings, not a
// migration path, and this file describes only the native one.
//
// NO `Idempotency-Key`, AND THE ENDPOINT ASKS FOR NONE. Both commands are
// idempotent on the STATE: `register` upserts on `device_id`, so sending it
// twice leaves one row with the last token; `revoke` sets a timestamp that is
// already set. This matches `/api/v1/me/notifications`, whose commands carry no
// key for the same reason, and NOT `/api/v1/pets/{token}/events`, which requires
// one because it appends to an immutable log. Making a phone manufacture a key
// for an operation whose repeat is harmless would be a client believing it holds
// a promise nobody made.

import { z } from "zod";

/**
 * The per-field codes a client can act on locally.
 *
 * SCREAMING_SNAKE, like every other input module here, and deliberately NOT the
 * `lowercase_snake` of `@dim/contract/api`'s error vocabulary: these are refusals
 * a client computes for ITSELF before any round trip, and the two casings are how
 * a reader tells "the server said no" from "the form did".
 */
export const PUSH_REGISTRATION_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "DEVICE_ID_REQUIRED",
  "DEVICE_ID_TOO_LONG",
  "EXPO_PUSH_TOKEN_REQUIRED",
  "EXPO_PUSH_TOKEN_MALFORMED",
  "PLATFORM_REQUIRED",
  "APP_VERSION_TOO_LONG",
] as const;

export type PushRegistrationInputCode = (typeof PUSH_REGISTRATION_INPUT_CODES)[number];

/**
 * The two stores Expo brokers to. Frozen here rather than inlined so the schema,
 * the database CHECK (migration 0222) and any client that renders a device list
 * are describing one set.
 */
export const PUSH_PLATFORMS = ["ios", "android"] as const;

export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/**
 * A cap on `app_version`, which is triage metadata and nothing else.
 *
 * It exists because the column is free text the client fills, and an unbounded
 * string a client controls is a row a client controls the size of. Sixty-four
 * characters is far above any real version string (`1.0.0`, `1.0.0-beta.3+ci`)
 * and far below anything worth storing by accident.
 */
export const PUSH_APP_VERSION_MAX_LENGTH = 64;

/**
 * The install identity, as the endpoint receives it.
 *
 * SHAPE ONLY, NEVER EXISTENCE, and never a format assertion either. The app
 * mints this once and keeps it in `expo-secure-store`; the server's only
 * interest is that it is a stable non-empty string to conflict on. Demanding a
 * uuid here would break the first client that changed how it mints one, for no
 * gain — the column is unique and the write is scoped to the caller, so a
 * device_id belonging to somebody else flips a row the caller then owns, which
 * is the documented behaviour rather than an attack.
 *
 * IT IS CAPPED FOR THE REASON `PUSH_APP_VERSION_MAX_LENGTH` IS CAPPED — a
 * string a client controls is a row a client controls the size of, and "shape
 * only" was never an argument for "any length at all". Two hundred characters
 * is an order of magnitude above any install identity a client could sanely
 * mint (a uuid is 36) and far below anything worth storing by accident. The cap
 * is on LENGTH and still not on FORMAT: this rejects a megabyte, not a spelling.
 */
export const PUSH_DEVICE_ID_MAX_LENGTH = 200;

const deviceId = z
  .string({ error: "DEVICE_ID_REQUIRED" })
  .trim()
  .min(1, { error: "DEVICE_ID_REQUIRED" })
  .max(PUSH_DEVICE_ID_MAX_LENGTH, { error: "DEVICE_ID_TOO_LONG" });

/**
 * The Expo push token.
 *
 * THE PREFIX IS CHECKED AND THE REST IS NOT, which is the honest amount of
 * validation available here. `ExponentPushToken[...]` is the shape Expo's SDK
 * returns and the shape `expo-server-sdk` will accept; a string without it is a
 * client bug the phone can catch before spending a round trip, and telling it so
 * locally is the whole point of this package. What the server CANNOT know is
 * whether a well-formed token is live — only Expo answers that, and it answers
 * at send time with `DeviceNotRegistered`, which soft-revokes the row. A regex
 * that tried to look more thorough would be asserting a liveness it cannot see.
 */
/**
 * The prefix, as a constant rather than a literal in one refine.
 *
 * EXPORTED BECAUSE THE PHONE NEEDS THE SAME STRING. The mobile adapter checks
 * the shape of what `expo-notifications` handed it before spending a round trip
 * on a registration this schema would refuse — and a second copy of the literal
 * in `apps/mobile` would be a rule enforced in two places that can only ever
 * drift apart. One string, one package, both sides.
 */
export const EXPO_PUSH_TOKEN_PREFIX = "ExponentPushToken[";

/**
 * The Android notification channel every native push is addressed to.
 *
 * WHY IT IS IN THE CONTRACT AND NOT IN EITHER APP. Android draws a notification
 * through a CHANNEL, and the channel is named twice: the app creates it
 * (`setNotificationChannelAsync`) and the SERVER addresses it (`channelId` on
 * the Expo message). The two strings have to be the same string or the message
 * lands in expo-notifications' unnamed fallback channel — which still shows
 * something, so the mismatch does not fail, it just quietly ignores everything
 * the app declared about how loud this is allowed to be. That is the exact shape
 * of bug a shared constant exists to make impossible: two literals, two
 * packages, no compiler between them.
 *
 * THE ID IS VERSIONED, and the `v1` is load-bearing rather than decorative. An
 * Android channel's IMPORTANCE IS IMMUTABLE once created — the app can never
 * raise it afterwards, only the person can, from system settings. So the day
 * this project decides these notifications should interrupt rather than wait on
 * the shade, the only honest way to ship it is a NEW channel, and a name that
 * already carries a number is one that can be succeeded without reading like a
 * typo. The old channel is then deleted by the app, and people who had lowered
 * it keep that preference exactly as long as they keep the old channel.
 *
 * iOS IGNORES IT COMPLETELY. Channels are an Android concept; the field rides
 * on every message because the message is one payload for both stores.
 */
export const PUSH_ANDROID_CHANNEL_ID = "avisos-v1";

/**
 * The second channel: public-health urgencies, and nothing else.
 *
 * WHY TWO (PO decision 2026-09-16). On Android the CHANNEL is the unit a person
 * silences, so one channel for everything means one switch for everything:
 * somebody tired of sighting notices can only turn off the lot, and takes the
 * rabies alerts with them. That is the wrong trade to force on anybody, and it
 * was not a trade anyone chose — it fell out of there being a single channel.
 *
 * IT IS THE ONE PLACE `HIGH` IS JUSTIFIED. The argument in this file's sibling
 * (`lib/infra/expo-push.ts`) for leaving everything at DEFAULT is that two legs
 * disagreeing about what is urgent is worse than both being conservative. That
 * argument holds for the notices, and it stops holding for a rabies observation
 * escalating: a message whose whole content is "a health authority needs you to
 * act now" that waits politely on the shade is a message that failed. So this
 * channel peeks and the other does not, and the difference is legible to the
 * person in their own system settings rather than buried in a payload.
 *
 * SAME VERSIONING RULE, for the same reason: importance is immutable once the
 * channel exists, so a future change of mind ships as `salud-v2` and the app
 * deletes this one.
 */
export const PUSH_ANDROID_HEALTH_CHANNEL_ID = "salud-v1";

/**
 * The longest token this endpoint will take.
 *
 * SAME DISCIPLINE AS `PUSH_APP_VERSION_MAX_LENGTH`, and for the same one-line
 * reason: a string a client controls is a row a client controls the size of.
 * The prefix check above already refuses most rubbish, but `ExponentPushToken[`
 * followed by a megabyte passes it — a prefix says nothing about a tail. Real
 * tokens are well under a hundred characters; 512 is generous enough that a
 * format change at Expo does not become an outage here, and small enough that
 * the column cannot be used as storage.
 */
export const EXPO_PUSH_TOKEN_MAX_LENGTH = 512;

const expoPushToken = z
  .string({ error: "EXPO_PUSH_TOKEN_REQUIRED" })
  .trim()
  .min(1, { error: "EXPO_PUSH_TOKEN_REQUIRED" })
  .max(EXPO_PUSH_TOKEN_MAX_LENGTH, { error: "EXPO_PUSH_TOKEN_MALFORMED" })
  .refine((value) => value.startsWith(EXPO_PUSH_TOKEN_PREFIX), {
    error: "EXPO_PUSH_TOKEN_MALFORMED",
  });

/** REGISTER OR REFRESH this install. Upserts on `device_id`; see the header. */
const register = z.object({
  command: z.literal("register"),
  deviceId,
  expoPushToken,
  platform: z.enum(PUSH_PLATFORMS, { error: "PLATFORM_REQUIRED" }),
  appVersion: z
    .string()
    .trim()
    .max(PUSH_APP_VERSION_MAX_LENGTH, { error: "APP_VERSION_TOO_LONG" })
    .optional(),
});

/**
 * STOP DELIVERING TO THIS INSTALL. Sign-out, or the person turning push off.
 *
 * Takes only the device, never the token: a phone signing out may hold a token
 * that has already rotated, and requiring the current one would make the
 * unregister fail exactly when it matters most — the row would keep receiving
 * for somebody who has left.
 */
const revoke = z.object({
  command: z.literal("revoke"),
  deviceId,
});

export const pushRegistrationInputSchema = z.discriminatedUnion("command", [register, revoke]);

export type PushRegistrationInput = z.infer<typeof pushRegistrationInputSchema>;
export type PushRegistrationCommand = PushRegistrationInput["command"];

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstNotificationCommandInputCode` — same shape, same reason.
 */
export function firstPushRegistrationInputCode(
  error: z.ZodError<unknown>,
): PushRegistrationInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((PUSH_REGISTRATION_INPUT_CODES as readonly string[]).includes(code)) {
      return code as PushRegistrationInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
