// "Buscar actualización" — the manual half of the OTA channel (OTA-6).
//
// WHY A BUTTON WHEN UPDATES ARE AUTOMATIC. `app.config.ts` leaves
// `checkAutomatically` at its default, so expo-updates looks for a new bundle
// ON LAUNCH and applies it on the launch AFTER that. For a fleet of fourteen
// testers who keep the app resident for days, "restart it twice" is the whole
// distribution mechanism — and `docs/mobile/ota-policy.md` requires a hotfix to
// be "installed and opened twice, and confirmed" on a device before it goes to
// production. That confirmation was a WhatsApp instruction; this makes it a
// control the person can press, with the answer written on the screen.
//
// WHY A PORT AND A PURE FUNCTION. `expo-updates` is a native module: under Jest
// its check throws, and a screen that owns the sequence inline is a screen
// whose four outcomes are untestable. The port is the same shape
// `api/client.ts` uses for the session, and for the same reason.
//
// EVERY ANSWER ENDS IN A SENTENCE, AND "NO HAY NADA" IS NOT AN ERROR. A person
// who taps this and reads nothing assumes it is broken. Every arm below ends in
// a sentence, including the boring one — and, since the 2026-09-07 review,
// including the two that used to end in silence: a fetch that resolved having
// staged nothing (H2) and a reload that rejected (M2).

import { reportHandledFailure } from "../observability/report";

/**
 * What `expo-updates` gives this screen, as a port.
 *
 * `isEnabled` is false in a dev client and in an emulator run built without the
 * updates module — where `checkForUpdateAsync` REJECTS rather than answering
 * "no". Asking first is what keeps that from reading as a failure.
 */
export type UpdatesPort = {
  isEnabled: boolean;
  /**
   * True while the running bundle is the one baked into the binary
   * (`Updates.isEmbeddedLaunch`, expo-updates 57). The first launch of a fresh
   * install is ALWAYS an embedded launch — the bundle that shipped with the
   * build, however old — and `launch-update-gate.ts` is the one consumer. It
   * stays true forever on an install that never receives an update, which is
   * why that gate does not fire on this flag alone.
   */
  isEmbeddedLaunch: boolean;
  /**
   * The id of the running update, or `null` where updates are disabled. On an
   * embedded launch it is the embedded manifest's id, which is different for
   * every build — the launch gate keys its one-time marker on it so a NEW
   * binary from Play (whose embedded bundle is also as old as its build) gets
   * its own first-launch check instead of inheriting the previous one's.
   */
  updateId: string | null;
  checkForUpdateAsync(): Promise<{ isAvailable: boolean; isRollBackToEmbedded?: boolean }>;
  /**
   * `isRollBackToEmbedded` IS PART OF THE ANSWER AND WAS MISSING FROM THIS TYPE
   * (finding H2, review 2026-09-07). `expo-updates`' own `UpdateFetchResult` is
   * a union with a FAILURE arm that RESOLVES: `{ isNew: false,
   * isRollBackToEmbedded: false }` means the fetch staged nothing at all
   * (node_modules/expo-updates/build/Updates.types.d.ts). The port declared only
   * `isNew` and `downloadUpdate` read neither, so a fetch that staged nothing
   * was reported to the person as "Hay una versión nueva lista. Reiniciá la
   * app" — and the restart then changed nothing, which is the one outcome this
   * whole button exists to make impossible.
   *
   * The flag is load-bearing rather than decorative: a legitimate ROLL BACK to
   * the embedded bundle also answers `isNew: false`, so `isNew` alone cannot
   * tell "nothing was staged" from "the recall was staged".
   */
  fetchUpdateAsync(): Promise<{ isNew: boolean; isRollBackToEmbedded?: boolean }>;
  reloadAsync(): Promise<void>;
};

export type UpdateCheckState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date" }
  | { phase: "downloading" }
  /** Downloaded and staged. Nothing changes until the app restarts. */
  | { phase: "ready" }
  /** `reloadAsync` is in flight. See `restartForUpdate` for why this exists. */
  | { phase: "restarting" }
  | { phase: "failed"; message: string; correlationId?: string }
  /** No updates module in this install. Not a failure — a different build. */
  | { phase: "unsupported" };

/**
 * Whether THIS call may write a Sentry event (finding F3, review 2026-09-07).
 *
 * EVERY ARM BELOW REPORTS BECAUSE EVERY ARM WAS A DELIBERATE TAP. "A check that
 * fails on every phone is a broken update URL and nothing else would say so"
 * (OBS-2) is a statement about a person pressing a button: one event per tap,
 * and a tap is rare and intentional.
 *
 * `useForegroundUpdateCheck` then began calling the same two functions
 * UNATTENDED, on every foreground edge, throttled only to five minutes. On
 * Argentine mobile data that is up to twelve events per hour per device, across
 * fourteen testers, buffered offline and flushed in a burst when signal returns
 * — and every one of them says `update-check-failed`, which is the exact tag
 * OBS-2 exists to make legible. The signal would have become indistinguishable
 * from ordinary connectivity, and the quota would have gone to it.
 *
 * So the BUTTON keeps reporting (default `true`, unchanged) and the background
 * probe does not. A background failure is not evidence of anything: nobody was
 * waiting for it, and the next tap on "Buscar actualización" reports it anyway.
 */
export type UpdateCallOptions = {
  report?: boolean;
};

export const UPDATE_CHECK_LABEL = "Buscar actualización";
export const UPDATE_RESTART_LABEL = "Reiniciar ahora";
export const UPDATE_CHECKING_MESSAGE = "Buscando una versión nueva…";
export const UPDATE_UP_TO_DATE_MESSAGE = "Ya tenés la última versión.";
export const UPDATE_DOWNLOADING_MESSAGE = "Descargando la versión nueva…";
export const UPDATE_READY_MESSAGE =
  "Hay una versión nueva lista. Reiniciá la app para empezar a usarla.";
export const UPDATE_UNSUPPORTED_MESSAGE =
  "Esta instalación no recibe actualizaciones automáticas. Instalá la app desde Play para recibirlas.";
export const UPDATE_CHECK_FAILED_MESSAGE =
  "No pudimos fijarnos si hay una versión nueva. Revisá tu conexión y volvé a intentar.";
export const UPDATE_DOWNLOAD_FAILED_MESSAGE =
  "Encontramos una versión nueva pero no pudimos descargarla. Volvé a intentar.";
export const UPDATE_RESTARTING_MESSAGE = "Reiniciando la app…";
export const UPDATE_RESTART_FAILED_MESSAGE =
  "No pudimos reiniciar la app. Cerrala y volvé a abrirla.";

/** The sentence under the button for each state. `null` only while idle. */
export function updateCheckMessage(state: UpdateCheckState): string | null {
  switch (state.phase) {
    case "idle":
      return null;
    case "checking":
      return UPDATE_CHECKING_MESSAGE;
    case "up-to-date":
      return UPDATE_UP_TO_DATE_MESSAGE;
    case "downloading":
      return UPDATE_DOWNLOADING_MESSAGE;
    case "ready":
      return UPDATE_READY_MESSAGE;
    case "restarting":
      return UPDATE_RESTARTING_MESSAGE;
    case "unsupported":
      return UPDATE_UNSUPPORTED_MESSAGE;
    case "failed":
      return state.message;
  }
}

/**
 * Look for a new bundle. Answers the state to render; never throws.
 *
 * A ROLL BACK TO THE EMBEDDED BUNDLE COUNTS AS AN UPDATE, and missing that is
 * how a bad OTA becomes unrecallable in practice: `isAvailable` is `false` for
 * a roll-back (expo-updates' own typings say so) while `fetchUpdateAsync` would
 * fetch it. Reading only `isAvailable` would tell a tester holding the broken
 * bundle that they already have the latest version — the one moment this
 * button exists for.
 */
export async function checkForUpdate(
  port: UpdatesPort,
  { report = true }: UpdateCallOptions = {},
): Promise<UpdateCheckState> {
  if (!port.isEnabled) return { phase: "unsupported" };
  try {
    const result = await port.checkForUpdateAsync();
    if (!result.isAvailable && result.isRollBackToEmbedded !== true) {
      return { phase: "up-to-date" };
    }
    return { phase: "downloading" };
  } catch {
    // Reported, not swallowed: a check that fails on every phone is a broken
    // update URL, and nothing else in the app would ever say so (OBS-2). Unless
    // nobody asked — see `UpdateCallOptions`.
    const correlationId = report
      ? reportHandledFailure({ surface: "update", failure: "update-check-failed" })
      : undefined;
    return { phase: "failed", message: UPDATE_CHECK_FAILED_MESSAGE, correlationId };
  }
}

/**
 * Download the bundle the check found. Answers the state to render.
 *
 * A FETCH THAT RESOLVES IS NOT A FETCH THAT STAGED SOMETHING (finding H2). The
 * `try` used to be the whole rule: anything that did not throw became
 * `{ phase: "ready" }` and the person read "Hay una versión nueva lista.
 * Reiniciá la app para empezar a usarla." `UpdateFetchResult`'s failure arm
 * resolves, so a phone that fetched nothing was told to restart for nothing —
 * and the restart then changed nothing, which is precisely the "is it broken or
 * did it work?" this screen was built to end. See `UpdatesPort`.
 */
export async function downloadUpdate(
  port: UpdatesPort,
  { report = true }: UpdateCallOptions = {},
): Promise<UpdateCheckState> {
  const failed = (): UpdateCheckState => ({
    phase: "failed",
    message: UPDATE_DOWNLOAD_FAILED_MESSAGE,
    correlationId: report
      ? reportHandledFailure({ surface: "update", failure: "update-download-failed" })
      : undefined,
  });
  try {
    const fetched = await port.fetchUpdateAsync();
    // A ROLL BACK TO EMBEDDED IS ALSO `isNew: false`, and it is a real staged
    // outcome — the recall path `checkForUpdate`'s docblock is about. Reading
    // `isNew` alone here would answer "no pudimos descargarla" to the one person
    // whose broken bundle was just successfully recalled.
    if (!fetched.isNew && fetched.isRollBackToEmbedded !== true) return failed();
    return { phase: "ready" };
  } catch {
    return failed();
  }
}

/**
 * Apply the staged bundle. Answers the state to render; never throws.
 *
 * WHY A REJECTION MAY NOT LAND BACK ON `ready` (finding M2, review 2026-09-07).
 * The screen used to write `reloadAsync().catch(() => setState({ phase: "ready" }))`,
 * so a person who tapped "Reiniciar ahora" and had it fail read the SAME
 * sentence as before the tap — the screen's answer to "did that do anything?"
 * was to look exactly as it had. A failure gets its own sentence and its own
 * correlation id, like every other handled failure in this app.
 *
 * The success arm is unreachable in practice — `reloadAsync` replaces the JS
 * context — and it is written anyway: a promise that resolves into no state at
 * all is how a button ends up permanently mid-flight.
 */
export async function restartForUpdate(port: UpdatesPort): Promise<UpdateCheckState> {
  try {
    await port.reloadAsync();
    return { phase: "restarting" };
  } catch {
    const correlationId = reportHandledFailure({
      surface: "update",
      failure: "update-restart-failed",
    });
    return { phase: "failed", message: UPDATE_RESTART_FAILED_MESSAGE, correlationId };
  }
}

/** Whether the button is a check or a restart, and whether it is pressable. */
export function updateActionLabel(state: UpdateCheckState): string {
  return state.phase === "ready" || state.phase === "restarting"
    ? UPDATE_RESTART_LABEL
    : UPDATE_CHECK_LABEL;
}

export function updateActionBusy(state: UpdateCheckState): boolean {
  // `restarting` is in the list because NOTHING else stopped a second tap while
  // the first `reloadAsync` was in flight (finding M2), and two of those is a
  // race between two attempts to replace the running app.
  return (
    state.phase === "checking" || state.phase === "downloading" || state.phase === "restarting"
  );
}
