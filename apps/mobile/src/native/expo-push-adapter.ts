// THE REAL NOTIFICATIONS MODULE, bound to the seam `push-port.ts` declares.
//
// WHY THIS BINDING IS ITS OWN FILE, and why nothing but `app/_layout.tsx` may
// import it: `expo-notifications` is a NATIVE module whose JS entry point is not
// inert — it registers listeners and touches the native runtime at import time,
// which throws in a process without one. That is the same argument
// `expo-image-picker-adapter.ts` records, and the same arrangement: the port's
// TYPE and every decision made from it stay in native-free modules, and the one
// file that touches the native import lives alone, so importing it is an
// explicit opt-in to the native dependency.
//
// AND HERE THAT IS NOT THEORETICAL. The build on Play today was cut on
// 2026-09-11 WITHOUT this module. Every device in the closed test runs a binary
// where this file is absent and `moduleMissingPush` is the only answer — which
// is exactly why the default had to be honest rather than optimistic.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE DELIBERATELY DOES NOT DO
// ---------------------------------------------------------------------------
// Two of the three absences this header used to record are now PRESENT, and the
// paragraphs are kept rather than deleted because what they argued is still the
// reason each one has the shape it has.
//
//   · `setNotificationHandler` IS HERE NOW. It used to be absent because "a
//     display decision about an app the person is already looking at" was out of
//     that unit's scope. It is in scope now, and leaving it out was not neutral:
//     without a handler, expo-notifications draws NOTHING in the foreground, so
//     an urgent notification that arrived while somebody had the app open
//     vanished. See `FOREGROUND_PRESENTATION` for what it answers and why.
//   · THE ANDROID CHANNEL IS HERE NOW, and the old paragraph's objection was
//     correct and has been answered rather than overruled. It said a channel
//     "would be decoration unless the server addressed it" — so the server
//     addresses it: `expo-push.ts` sets `channelId` to the same
//     `PUSH_ANDROID_CHANNEL_ID` this file creates, from one constant in
//     `@dim/contract/input`. Its second objection — that importance is IMMUTABLE
//     once created, so the choice is a product call — is answered by making the
//     conservative choice (DEFAULT, matching the deliberate absence of
//     `priority` on the server side) and by versioning the id, so raising it
//     later is a new channel rather than a silent no-op.
//   · NO `expo-device` check for "is this a simulator". This one stands. It is a
//     fourth native module, and the question it answers arrives anyway as a
//     rejection from the registration path below.
//
// ---------------------------------------------------------------------------
// WHAT THIS ADAPTER PROMISES — the contract restated from the port's header
// ---------------------------------------------------------------------------
//   · `denied` means a decision was made and must not be retried or re-asked.
//   · `unavailable` means no token is obtainable here and nothing is wrong.
//   · `failed.detail` is DIAGNOSTIC, never shown to a person. It carries the
//     module's error CODE when there is one, because that code is the only
//     thing that tells a reader of a breadcrumb which of the module's many
//     refusals actually happened.

import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import {
  EXPO_PUSH_TOKEN_PREFIX,
  PUSH_ANDROID_CHANNEL_ID,
  PUSH_ANDROID_HEALTH_CHANNEL_ID,
} from "@dim/contract/input";

import type { PushPermissionResult, PushPort, PushTap, PushTokenResult } from "./push-port";

/**
 * WHAT HAPPENS WHEN A NOTIFICATION ARRIVES WHILE THE APP IS OPEN.
 *
 * THE DEFAULT IS THE ONE OUTCOME THAT IS DEFINITELY WRONG. With no handler
 * installed, expo-notifications draws NOTHING in the foreground — the payload
 * reaches the JS runtime, nothing is presented, and the notification is gone. So
 * an urgent sighting of somebody's lost animal, arriving in the five minutes
 * they spend staring at this app because their animal is lost, is the one that
 * does not get shown. Silence is not the conservative choice here; it is the
 * failure.
 *
 * SO IT IS DRAWN, AND THE BANNER IS THE PART THAT IS NOT OPTIONAL. A banner is
 * transient and non-modal on both platforms: it occupies the top of the screen
 * for a few seconds and never takes a tap the person meant for what is
 * underneath. `shouldShowList` puts the same notification in the tray, which is
 * what makes it recoverable — somebody mid-form who lets the banner pass has not
 * lost anything.
 *
 * AND THE SOUND IS NOT NEGOTIABLE ON ANDROID, WHICH IS WHY IT IS `true`.
 *
 * The obvious middle — draw the banner, stay quiet — does not exist, and the
 * module's own type documentation is where that was measured rather than
 * guessed: "On Android, setting `shouldPlaySound: false` will result in the
 * drop-down notification alert NOT showing, no matter what the priority is"
 * (expo-notifications, Notifications.types.d.ts, NotificationBehavior). So on
 * Android the two are one switch, and a `false` written to spare somebody a
 * chime would have silently taken the banner with it — the vanishing this
 * handler exists to stop, reintroduced by the line meant to be considerate about
 * it.
 *
 * Given the choice is banner-with-sound or neither, it is banner-with-sound, and
 * the eligibility filter is what makes that defensible: this channel carries
 * `severity === "urgent"` and `pet_sighting`, and nothing else. It is not a feed.
 * A person who is looking at this app while somebody reports having seen their
 * animal is exactly the person who should be interrupted.
 *
 * `shouldSetBadge: false` matches the app, which has no badge and no unread
 * count anywhere. A number on the icon that nothing inside the app ever clears
 * is a number that only grows.
 *
 * WHAT THE WEB LEG DOES, SINCE THAT IS THE COMPARISON THAT SETTLES TIES: its
 * service worker calls `showNotification` unconditionally (public/sw.js), with
 * no check for whether a tab is focused. So the web also draws in the
 * foreground, and this matches it rather than inventing a second posture for the
 * same rows.
 */
export const FOREGROUND_PRESENTATION = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
} as const;

/**
 * Installed at MODULE SCOPE, which is what the module's own contract asks for:
 * the handler has to be in place before the first notification is delivered, and
 * this file is imported once, from `app/_layout.tsx`, before the first render.
 * An install inside an effect would have a window — small, and exactly as long
 * as a cold start, which is when a push is most likely to arrive.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => FOREGROUND_PRESENTATION,
});

/**
 * The iOS authorization this app asks for.
 *
 * ALERT, BADGE AND SOUND — the three an ordinary notification needs, and no
 * more. Two omissions are deliberate:
 *
 *   · NO `allowProvisional`. Provisional authorization skips the prompt and
 *     delivers QUIETLY, straight to Notification Center with no banner and no
 *     sound. For the one thing this channel carries — an urgent sighting of
 *     somebody's lost animal — silent delivery is the failure mode, not the
 *     considerate option. It would also make the port's `granted` mean two very
 *     different things.
 *   · NO `allowCriticalAlerts`. It breaks through Do Not Disturb and needs an
 *     entitlement Apple grants case by case. Neither is ours to assume.
 *
 * Android ignores this block entirely — there the permission is the single
 * `POST_NOTIFICATIONS` runtime grant, and the module asks for it with no
 * options of its own.
 */
export const IOS_PERMISSION_REQUEST = {
  ios: { allowAlert: true, allowBadge: true, allowSound: true },
} as const;

/**
 * The real module, as a port.
 *
 * `available: true` is a claim about the BUILD, not about the moment: this
 * module is only ever installed by `app/_layout.tsx`, which only exists in a
 * binary compiled with the native module linked in. A build without it never
 * runs this file at all — it keeps the honest default.
 */
export const expoPush: PushPort = {
  name: "expo-notifications",
  available: true,
  requestPermission,
  getExpoPushToken,
  lastTap,
  onTap,
  ensureNotificationChannel,
};

/**
 * The channel's user-visible name and description — es-AR, because these are
 * the two strings Android shows in the system settings screen where a person
 * turns this category off. They are UI copy that happens to live in a native
 * call, and the project's rule about which language UI copy is in does not stop
 * at the app's own screens.
 *
 * The name is what appears under "Notificaciones" in the OS settings, so it
 * names the CATEGORY rather than the product: the person is already inside an
 * app called miMAR and does not need to be told so again.
 */
// RENAMED 2026-09-16, and a rename is honoured by Android where a change of
// importance is not: this channel stopped carrying the health urgencies, so
// calling it "Avisos urgentes" would have left the person a switch whose label
// promised the one thing it no longer controls.
const ANDROID_CHANNEL_NAME = "Avisos de tus mascotas";
const ANDROID_CHANNEL_DESCRIPTION =
  "Hallazgos, avistajes, transferencias y cuidados. Suenan una vez y esperan en la bandeja.";

const ANDROID_HEALTH_CHANNEL_NAME = "Urgencias sanitarias";
const ANDROID_HEALTH_CHANNEL_DESCRIPTION =
  "Rabia y brotes. Interrumpen porque hay un plazo legal corriendo.";

/**
 * Create (or converge) the Android channel every message is addressed to.
 *
 * IDEMPOTENT BY DESIGN — `setNotificationChannelAsync` is an upsert, so calling
 * it on every launch is how the channel's copy gets corrected after an update
 * rather than being frozen at whatever the first install wrote. Everything
 * except the IMPORTANCE converges; Android refuses to let an app raise that, and
 * refuses just as firmly to let it lower one the person raised.
 *
 * IMPORTANCE IS `DEFAULT`, AND THAT IS THE ONE DECISION IN THIS FUNCTION.
 * `DEFAULT` means the notification makes a sound and appears in the shade and
 * the status bar; `HIGH` means it additionally peeks over whatever is on screen.
 * It is `DEFAULT` for the same reason `expo-push.ts` sets no `priority`: how
 * loud this channel is allowed to be is a product decision taken once for both
 * legs, and the web leg sets no urgency header either. Two channels disagreeing
 * about what is urgent is worse than both being conservative.
 *
 * Raising it later is possible and is deliberately NOT a one-line edit here: the
 * id carries a version (`PUSH_ANDROID_CHANNEL_ID`) precisely so that the change
 * ships as a new channel, which is the only thing Android will honour.
 *
 * ANDROID ONLY, checked here rather than left to the module. The function exists
 * on iOS and resolves to `null`, which would work — but a reader of this file
 * should be able to see that nothing happens on iOS without knowing that.
 */
async function ensureNotificationChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(PUSH_ANDROID_CHANNEL_ID, {
    name: ANDROID_CHANNEL_NAME,
    description: ANDROID_CHANNEL_DESCRIPTION,
    importance: Notifications.AndroidImportance.DEFAULT,
  });
  // THE SECOND CHANNEL, AND THE ONE PLACE `HIGH` IS SPENT. Everything in the
  // docblock above about importance being immutable applies here too, which is
  // why this one is born at the level it needs rather than raised later: a
  // rabies observation escalating has a legal clock running, and a message that
  // waits politely on the shade is a message that failed.
  //
  // Two channels is also what gives the person a real choice. With one, somebody
  // tired of sighting notices could only silence everything, health alerts
  // included — a trade nobody chose, which fell out of there being one switch.
  await Notifications.setNotificationChannelAsync(PUSH_ANDROID_HEALTH_CHANNEL_ID, {
    name: ANDROID_HEALTH_CHANNEL_NAME,
    description: ANDROID_HEALTH_CHANNEL_DESCRIPTION,
    importance: Notifications.AndroidImportance.HIGH,
  });
}

/**
 * The deep link a notification response carried, read off the payload the server
 * wrote — or `null`.
 *
 * EXPORTED, AND `unknown` RATHER THAN THE MODULE'S TYPE, because this is the one
 * place in the seam where data from OUTSIDE the app is read. `content.data` is
 * typed `Record<string, any>` by expo-notifications, which is to say it is typed
 * as nothing: it travelled through Expo, through APNs or FCM, and through the
 * OS. `messageFor` in `lib/infra/expo-push.ts` puts a `url` string there and
 * every other shape is somebody else's notification, an older server, or a
 * payload that lost a field on the way. All of them answer `null` here rather
 * than reaching the router as a non-string.
 *
 * It does NOT resolve the route. That belongs to `push-tap.ts`, which is
 * native-free and therefore testable without a device.
 */
export function deepLinkFromNotificationData(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const url = (data as { url?: unknown }).url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/** One module response, as the port's `PushTap`. Exported for its own test. */
export function tapFromResponse(response: {
  notification?: { request?: { content?: { data?: unknown } } };
}): PushTap {
  return { url: deepLinkFromNotificationData(response.notification?.request?.content?.data) };
}

/**
 * The tap that STARTED this process, if one did.
 *
 * `getLastNotificationResponseAsync` is the module's answer to a problem no
 * listener can solve: a person tapping a notification for an app that is not
 * running gets the response before the JS runtime exists. The module holds it
 * and hands it over here.
 *
 * IT IS NOT DEDUPLICATED HERE, and the caller must know that: the module keeps
 * answering the same response for the life of the process, so asking twice
 * answers twice. `push-tap.ts` handles the launch tap exactly once; this stays a
 * plain read of what the module holds.
 */
async function lastTap(): Promise<PushTap | null> {
  const response = await Notifications.getLastNotificationResponseAsync();
  return response === null || response === undefined ? null : tapFromResponse(response);
}

/**
 * Taps while this process is alive — from the background, and from the
 * foreground banner the handler above draws.
 *
 * THE SUBSCRIPTION IS RETURNED AS A PLAIN FUNCTION rather than the module's
 * `EventSubscription`, so the port's type owes nothing to expo-notifications and
 * a fake in a test is one arrow instead of an object with a `remove`.
 */
function onTap(listener: (tap: PushTap) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    listener(tapFromResponse(response));
  });
  return () => subscription.remove();
}

/**
 * The EAS project this install belongs to, or `null`.
 *
 * WHY IT IS PASSED EXPLICITLY rather than left for the module to infer.
 * `getExpoPushTokenAsync` infers it from the manifest and throws
 * `ERR_NOTIFICATIONS_NO_EXPERIENCE_ID` when it cannot — which is a rejection
 * carrying a sentence about the bare workflow, three layers from anything a
 * reader of this repo would recognise. Reading it here turns that into one
 * named condition with a detail that says which key was missing.
 *
 * `extra.eas.projectId` and not `easConfig`: that is the key `app.config.ts`
 * actually writes (and the one `eas build` reads), so this looks where this
 * repo puts it rather than where a second mechanism might also have put it.
 */
export function expoProjectId(): string | null {
  const raw: unknown = Constants.expoConfig?.extra?.eas?.projectId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * Ask for notification permission — or answer from what is already known.
 *
 * IT READS BEFORE IT ASKS, and that is not an optimisation. `canAskAgain:
 * false` means the OS will no longer show the dialog: iOS asks once ever, and
 * Android 13+ stops after a refusal. Calling `requestPermissionsAsync` in that
 * state returns the same refusal without showing anything, so reading first
 * changes no outcome — it changes what this app KNOWS about the outcome, which
 * is the difference between a caller that stops asking and one that retries a
 * dialog nobody will ever see.
 */
async function requestPermission(): Promise<PushPermissionResult> {
  let current: Notifications.NotificationPermissionsStatus;
  try {
    current = await Notifications.getPermissionsAsync();
  } catch (error) {
    return { outcome: "failed", detail: `getPermissions: ${failureDetail(error)}` };
  }

  // Already settled in our favour. Asking again would be a second prompt on
  // Android for a grant that is already held.
  if (current.granted) return { outcome: "granted" };

  // Settled against us, permanently. No dialog left to show.
  if (!current.canAskAgain) return { outcome: "denied" };

  let answered: Notifications.NotificationPermissionsStatus;
  try {
    answered = await Notifications.requestPermissionsAsync(IOS_PERMISSION_REQUEST);
  } catch (error) {
    return { outcome: "failed", detail: `requestPermissions: ${failureDetail(error)}` };
  }

  return interpretPermission(answered);
}

/**
 * One permissions status, as a member of the port's union.
 *
 * EXPORTED SO THE MAPPING CAN BE TESTED AS A MAPPING — §7 item 6 asks for every
 * shape the module can return, and enumerating them through two mocked async
 * calls each would test the plumbing far more than the translation.
 *
 * `granted` IS READ AND `status` IS NOT, deliberately. The module computes
 * `granted` per platform, and on iOS that includes PROVISIONAL and EPHEMERAL
 * authorizations whose `status` string is not `"granted"`. Those DO deliver, so
 * a token is real and registration is correct; switching on `status` would
 * discard a working install for failing a string comparison.
 */
export function interpretPermission(
  status: Notifications.NotificationPermissionsStatus,
): PushPermissionResult {
  if (status.granted) return { outcome: "granted" };

  // A refusal the person made, or one a device policy made for them. Either
  // way it is a decision, and the port's header forbids offering a retry.
  if (!status.canAskAgain) return { outcome: "denied" };

  // UNDECIDED AFTER BEING ASKED, and this member is the one worth arguing
  // about. It is reachable: iOS defers the prompt when the request is made
  // while the app is not foregrounded, and answers `undetermined` without
  // showing anything. That is NOT `denied` — nobody said no, and mapping it
  // there would permanently stop asking somebody who was never asked. It is
  // not `granted` and it is not `unavailable` either. `failed` is the only
  // member left that means "no answer this time, and the state is worth
  // reading in a breadcrumb"; it shows nothing to anybody, which is right,
  // because nothing happened to them.
  return { outcome: "failed", detail: `permission undecided after request (${status.status})` };
}

/**
 * Read this install's Expo push token.
 *
 * PERMISSION IS CHECKED FIRST because the token call is a NETWORK ROUND TRIP to
 * Expo's servers — it is not a local read. Making it without permission spends
 * a request to learn something the local permissions state already knew, and on
 * iOS the underlying remote-notification registration fails anyway.
 */
async function getExpoPushToken(): Promise<PushTokenResult> {
  let permission: Notifications.NotificationPermissionsStatus;
  try {
    permission = await Notifications.getPermissionsAsync();
  } catch (error) {
    return { outcome: "failed", detail: `getPermissions: ${failureDetail(error)}` };
  }
  if (!permission.granted) return { outcome: "denied" };

  const projectId = expoProjectId();
  if (projectId === null) {
    // Not retryable and not reportable as an incident: this build was
    // assembled without the key, and no amount of asking again will add one.
    return { outcome: "unavailable" };
  }

  let token: Notifications.ExpoPushToken;
  try {
    token = await Notifications.getExpoPushTokenAsync({ projectId });
  } catch (error) {
    return interpretTokenFailure(error);
  }

  // THE SHAPE IS CHECKED HERE so the round trip is not spent on a registration
  // the server would refuse. `push-registration.ts` rejects anything without
  // this prefix with `EXPO_PUSH_TOKEN_MALFORMED`, which would reach the phone
  // as a 400 it can do nothing with. A string that is not an Expo token means
  // the module changed under us, and that belongs in a breadcrumb.
  if (!token.data.startsWith(EXPO_PUSH_TOKEN_PREFIX)) {
    return {
      outcome: "failed",
      // The token is NOT interpolated. It is a delivery address for this
      // person's device and `detail` is written to logs; its length is enough
      // to tell a malformed shape from an empty one.
      detail: `token did not start with ${EXPO_PUSH_TOKEN_PREFIX} (${token.data.length} chars)`,
    };
  }

  return { outcome: "token", expoPushToken: token.data };
}

/**
 * One rejection from the token path, as a member of the port's union.
 *
 * THE SPLIT IS BETWEEN "THIS BUILD CANNOT" AND "THIS ATTEMPT DID NOT", and the
 * only honest instrument for it is the error CODE. Exported for the same reason
 * `interpretPermission` is.
 */
export function interpretTokenFailure(error: unknown): PushTokenResult {
  const code = errorCode(error);

  // The project or the application id is missing from this build's config.
  // Permanent, silent, nothing to retry — the definition of `unavailable`.
  // (The first of these should be unreachable: `getExpoPushToken` passes the
  // project id explicitly and refuses earlier when it has none. It is mapped
  // anyway because the module can also raise it from the id it derives itself.)
  if (
    code === "ERR_NOTIFICATIONS_NO_EXPERIENCE_ID" ||
    code === "ERR_NOTIFICATIONS_NO_APPLICATION_ID"
  ) {
    return { outcome: "unavailable" };
  }

  // EVERYTHING ELSE IS `failed`, INCLUDING `E_REGISTRATION_FAILED`, AND THAT IS
  // THE DECISION IN THIS FILE MOST LIKELY TO BE ARGUED WITH.
  //
  // `E_REGISTRATION_FAILED` (android/.../PushTokenModule.kt) is what an
  // emulator without Play Services produces — and it is ALSO what a real phone
  // produces when the FCM configuration is broken. From JS the two are one
  // string; the Kotlin interpolates FCM's own message into it and nothing
  // more. Mapping it to `unavailable` would silence the emulator noise, which
  // is tempting, and would ALSO silence a production build that cannot obtain
  // a single token — a capability reported as working while only its plumbing
  // is. Of the two available wrong answers, the one that stays visible is the
  // better wrong answer. The cost is real and is stated rather than hidden:
  // every emulator launch produces one breadcrumb that means nothing.
  //
  // The network and server codes belong here on their own merits: Expo's own
  // documentation says to catch them and retry when the device is back online.
  //
  // AND ON ANDROID IT GETS THE SENTENCE, because a code is not an explanation.
  // See `FCM_CONFIGURATION_MISSING`.
  if (code === ANDROID_REGISTRATION_FAILED_CODE && Platform.OS === "android") {
    return { outcome: "failed", detail: `${code}: ${FCM_CONFIGURATION_MISSING}` };
  }

  return {
    outcome: "failed",
    detail: code === null ? failureDetail(error) : `${code}: ${messageOf(error)}`,
  };
}

/** The module's own code for "FCM would not give me a token". */
const ANDROID_REGISTRATION_FAILED_CODE = "E_REGISTRATION_FAILED";

/**
 * THE MISSING PIECE OF THIS BUILD, SPELLED OUT RATHER THAN CODED.
 *
 * Android cannot mint a push token without an FCM credential compiled into the
 * binary: `google-services.json`, referenced from `app.config.ts` as
 * `android.googleServicesFile`, and uploaded to Expo so its push service can
 * broker on this project's behalf. That file is NOT in this repository and is
 * not the kind of thing an agent can produce — it comes from the Firebase
 * console for the project that owns `ar.mimar.app`, and obtaining it is the
 * product owner's.
 *
 * WHAT HAPPENS WITHOUT IT, and why this string exists. The build compiles. The
 * app runs. The permission dialog appears and can be granted. And then
 * `getExpoPushTokenAsync` rejects with `E_REGISTRATION_FAILED` carrying whatever
 * FCM said, which from a breadcrumb reads like a transient network problem —
 * so the visible symptom of a missing credential is "push just does not work on
 * Android", with a diagnostic that points at the wrong thing. That is the
 * silent failure the handoff asked not to ship.
 *
 * So the detail NAMES THE FILE AND WHERE IT COMES FROM. It is diagnostic and is
 * never shown to a person — there is no screen for it and there should not be —
 * but it is what a developer or the product owner reads in a Sentry event or an
 * adb log, and it is the difference between an afternoon and a minute.
 *
 * IT IS DELIBERATELY NOT CONDITIONAL ON DETECTING THE FILE. There is no way to
 * ask, from JS, whether the native build carries a valid FCM configuration —
 * the only instrument is this failure. A guess that said "missing" when the real
 * cause was an emulator with no Play Services would be a second wrong
 * explanation, so the sentence says what to CHECK rather than asserting what
 * happened.
 */
const FCM_CONFIGURATION_MISSING = [
  "FCM refused to issue a token.",
  "Check that this build carries android.googleServicesFile (google-services.json,",
  "from the Firebase project that owns ar.mimar.app) and that the same credential",
  "is uploaded to Expo for this EAS project.",
  "On an emulator without Google Play Services this is expected and means nothing.",
].join(" ");

/** The `code` of an Expo `CodedError`, when there is one. */
function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A diagnostic line for `failed.detail` — never a sentence for a person.
 *
 * Expo's `CodedError` carries the part worth keeping (`ERR_NOTIFICATIONS_
 * NETWORK_ERROR`, and so on); its `message` alone is often the generic half.
 */
function failureDetail(error: unknown): string {
  const code = errorCode(error);
  const message = messageOf(error);
  return code === null ? message : `${code}: ${message}`;
}
