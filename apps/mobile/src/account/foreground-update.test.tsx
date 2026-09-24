// `useForegroundUpdateCheck` — the half of OTA distribution that reaches a
// phone nobody restarts (A6-cuenta-resiliencia-08).
//
// WHAT THESE HAVE TO PROVE, beyond "it calls the module"
// ---------------------------------------------------------------------------
//   1. IT FIRES ON THE EDGE INTO `active`, not on the level. iOS emits
//      `inactive` for the control centre and an incoming-call banner, so a rule
//      that asked "is it active now" would run on the way back from each one.
//   2. IT DOES NOT DOUBLE THE LAUNCH CHECK. `checkAutomatically: ON_LOAD`
//      already looks on start; a second request on every cold start is a cost
//      with no answer behind it.
//   3. IT NEVER RELOADS. Replacing the running JS context under somebody's
//      thumb — mid-form, mid-search for a lost animal — is worse than the
//      staleness this fixes.
//   4. A DISABLED INSTALL IS ASKED NOTHING. `checkForUpdateAsync` REJECTS in a
//      dev client, and a rejection reported once per app switch is noise that
//      would bury the real one.
//   5. AND NEITHER IS SENTRY (finding F3). Point 4 was written about the
//      REQUEST and the code honoured it; the REPORT was a separate side effect
//      of the same two functions and nobody had turned it off.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";

type CapturedTags = Record<string, string>;
/** Every Sentry event written during a case. See the F3 block below. */
const captured: CapturedTags[] = [];

jest.mock("@sentry/react-native", () => ({
  captureException: (_error: unknown, context: { tags: CapturedTags }) => {
    captured.push(context.tags);
  },
  addBreadcrumb: () => undefined,
}));

import {
  FOREGROUND_CHECK_MIN_INTERVAL_MS,
  isUpdateStaged,
  setUpdateStaged,
  shouldCheckOnForeground,
  useForegroundUpdateCheck,
} from "./foreground-update";
import { type UpdatesPort, checkForUpdate } from "./update-check";

/**
 * SPIED ON THE PUBLIC API rather than mocked by internal file path — the rule
 * `SharesScreen.test.tsx` states, and it matters more here: a path mock that
 * stops matching turns into "the check never ran", which is the defect.
 */
const addEventListener = jest.spyOn(AppState, "addEventListener");
const remove = jest.fn();

/** The listener the hook registered, so a test can drive the platform. */
function emit(next: AppStateStatus): void {
  const listener = addEventListener.mock.calls.at(-1)?.[1] as
    | ((state: AppStateStatus) => void)
    | undefined;
  if (listener === undefined) throw new Error("the hook registered no AppState listener");
  listener(next);
}

function fakeUpdates(over: Partial<UpdatesPort> = {}): UpdatesPort {
  return {
    isEnabled: true,
    isEmbeddedLaunch: false,
    updateId: "11111111-1111-4111-8111-111111111111",
    checkForUpdateAsync: async () => ({ isAvailable: true }),
    fetchUpdateAsync: async () => ({ isNew: true }),
    reloadAsync: async () => {},
    ...over,
  };
}

function Harness({ updates }: { updates: UpdatesPort }) {
  useForegroundUpdateCheck(updates);
  return null;
}

/** Let the hook's detached async chain settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  addEventListener.mockReset();
  addEventListener.mockReturnValue({ remove } as ReturnType<typeof AppState.addEventListener>);
  remove.mockReset();
  setUpdateStaged(false);
  captured.length = 0;
});

describe("shouldCheckOnForeground — the decision, without a platform", () => {
  const base = {
    previous: "background" as AppStateStatus,
    next: "active" as AppStateStatus,
    isEnabled: true,
    lastCheckedAt: null,
    now: 1_000_000,
  };

  it("checks on the transition from background to active", () => {
    expect(shouldCheckOnForeground(base)).toBe(true);
  });

  it("does NOT check when the app was already active", () => {
    // The level, not the edge. Without this every re-render that re-read the
    // state would be a request.
    expect(shouldCheckOnForeground({ ...base, previous: "active" })).toBe(false);
  });

  it("does NOT check on the way OUT of the foreground", () => {
    expect(shouldCheckOnForeground({ ...base, next: "background" })).toBe(false);
  });

  it("does NOT check before anything has been observed", () => {
    // That is the launch, which `checkAutomatically: ON_LOAD` already covers.
    expect(shouldCheckOnForeground({ ...base, previous: null })).toBe(false);
  });

  it("does NOT ask a build with no updates module", () => {
    expect(shouldCheckOnForeground({ ...base, isEnabled: false })).toBe(false);
  });

  it("throttles two foregrounds inside the window, and allows one after it", () => {
    // Somebody answering a WhatsApp message produces an `active` transition
    // every few seconds, on a phone plan they pay for.
    const lastCheckedAt = base.now - 1_000;
    expect(shouldCheckOnForeground({ ...base, lastCheckedAt })).toBe(false);
    expect(
      shouldCheckOnForeground({
        ...base,
        lastCheckedAt,
        now: lastCheckedAt + FOREGROUND_CHECK_MIN_INTERVAL_MS,
      }),
    ).toBe(true);
  });

  it("still counts `inactive` as having left the foreground", () => {
    // iOS's transient state. A person who pulled down the control centre and
    // let it go has genuinely been away, and this is the cheap case to allow.
    expect(shouldCheckOnForeground({ ...base, previous: "inactive" })).toBe(true);
  });
});

describe("useForegroundUpdateCheck — wired to the platform", () => {
  it("stages a bundle when the app comes back, and never reloads", async () => {
    const reloadAsync = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const fetchUpdateAsync = jest
      .fn<() => Promise<{ isNew: boolean }>>()
      .mockResolvedValue({ isNew: true });
    render(<Harness updates={fakeUpdates({ reloadAsync, fetchUpdateAsync })} />);

    emit("background");
    emit("active");
    await settle();

    expect(fetchUpdateAsync).toHaveBeenCalledTimes(1);
    // THE LINE THIS HOOK MAY NOT CROSS. Restarting the app on its own would
    // take a person out of a form they were filling in.
    expect(reloadAsync).not.toHaveBeenCalled();
    // And the card can now say so instead of offering to look for it.
    expect(isUpdateStaged()).toBe(true);
  });

  it("asks NOTHING on the first state the platform reports", async () => {
    const checkForUpdateAsync = jest
      .fn<() => Promise<{ isAvailable: boolean }>>()
      .mockResolvedValue({ isAvailable: false });
    render(<Harness updates={fakeUpdates({ checkForUpdateAsync })} />);
    await settle();
    expect(checkForUpdateAsync).not.toHaveBeenCalled();
  });

  it("does not report a bundle as staged when the fetch staged nothing", async () => {
    // `UpdateFetchResult`'s failure arm RESOLVES (`{ isNew: false }`), which is
    // finding H2's whole subject. A card opening on "Reiniciar ahora" over
    // nothing would send somebody to restart for a bundle that is not there.
    render(<Harness updates={fakeUpdates({ fetchUpdateAsync: async () => ({ isNew: false }) })} />);
    emit("background");
    emit("active");
    await settle();
    expect(isUpdateStaged()).toBe(false);
  });

  it("does not touch the module at all in a build without updates", async () => {
    const checkForUpdateAsync = jest
      .fn<() => Promise<{ isAvailable: boolean }>>()
      .mockRejectedValue(new Error("not enabled"));
    render(<Harness updates={fakeUpdates({ isEnabled: false, checkForUpdateAsync })} />);
    emit("background");
    emit("active");
    await settle();
    expect(checkForUpdateAsync).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", () => {
    const view = render(<Harness updates={fakeUpdates()} />);
    view.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("the background probe is SILENT to Sentry (finding F3)", () => {
  const rejecting = () =>
    jest.fn<() => Promise<{ isAvailable: boolean }>>().mockRejectedValue(new Error("no signal"));

  it("writes no event when the unattended check fails", async () => {
    // `checkForUpdate` reports every failure arm because it was written for a
    // TAP: one event, rare, intentional, and OBS-2's "a check that fails on
    // every phone is a broken update URL" reads it. Unattended on every
    // foreground edge, throttled to five minutes, one dead spot on the way to
    // the office is up to twelve `update-check-failed` events an hour PER
    // DEVICE — buffered offline and flushed in a burst — and that tag stops
    // meaning "the update URL is broken" and starts meaning "Argentina".
    const checkForUpdateAsync = rejecting();
    render(<Harness updates={fakeUpdates({ checkForUpdateAsync })} />);

    emit("background");
    emit("active");
    await settle();

    // The probe DID run — this is about the report, not about skipping the work.
    expect(checkForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(captured).toEqual([]);
  });

  it("writes no event when the unattended DOWNLOAD fails", async () => {
    // The second half. `downloadUpdate` reports on both of its failure arms —
    // the throw and the fetch that resolved having staged nothing — and the hook
    // reaches both.
    render(
      <Harness
        updates={fakeUpdates({
          fetchUpdateAsync: async () => {
            throw new Error("no signal");
          },
        })}
      />,
    );

    emit("background");
    emit("active");
    await settle();

    expect(captured).toEqual([]);
  });

  it("still reports the DELIBERATE tap — OBS-2 is not being switched off", async () => {
    // The control. Silencing the probe by silencing the function would delete
    // the only signal that says the update URL is broken.
    const state = await checkForUpdate(fakeUpdates({ checkForUpdateAsync: rejecting() }));

    expect(state.phase).toBe("failed");
    expect(captured.map((tags) => tags.failure)).toEqual(["update-check-failed"]);
  });
});
