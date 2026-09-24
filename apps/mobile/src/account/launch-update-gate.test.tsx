// `useLaunchUpdateGate` / `runLaunchUpdateGate` — the first launch of a fresh
// install applies a pending OTA before the app is usable (2026-09-09).
//
// WHAT THESE HAVE TO PROVE
// ---------------------------------------------------------------------------
//   1. EMBEDDED + FIRST TIME + UPDATE AVAILABLE → fetch, then reload. This is
//      the tester who installed from Play and saw a screen deleted two days
//      earlier.
//   2. EMBEDDED + FIRST TIME + NOTHING AVAILABLE → proceed, and the marker is
//      written, so the next launch of this build never asks again.
//   3. EMBEDDED + MARKER PRESENT → no network call at all. `isEmbeddedLaunch`
//      stays true forever on an install that never gets an update, and this is
//      what keeps that install's every launch from paying a network wait.
//   4. NOT EMBEDDED → no check. A launch already running an OTA has nothing
//      this gate could add.
//   5. TIMEOUT → proceed. Nobody is left on a spinner because the update
//      server did not answer.
//   6. A FETCH THAT STAGES NOTHING → proceed without reload (finding H2's
//      resolving failure arm), because a restart over nothing changes nothing.
//   7. THE MARKER IS WRITTEN EVEN WHEN THE ATTEMPT FAILS, so a dead spot on
//      the first open cannot make every later open slow.
//   8. THE FOREGROUND HOOK STAYS QUIET WHILE THE GATE HOLDS THE LAUNCH.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, waitFor } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";

jest.mock("@sentry/react-native", () => ({
  captureException: () => undefined,
  addBreadcrumb: () => undefined,
}));

import { isUpdateStaged, setUpdateStaged, useForegroundUpdateCheck } from "./foreground-update";
import {
  type LaunchGateMarkerStore,
  type LaunchGatePhase,
  launchGateMarkerKey,
  runLaunchUpdateGate,
  shouldRunLaunchGate,
  useLaunchUpdateGate,
} from "./launch-update-gate";
import type { UpdatesPort } from "./update-check";

const EMBEDDED_ID = "22222222-2222-4222-8222-222222222222";

/** The port, defaulted to the SHAPE OF THE INCIDENT: embedded, update waiting. */
function fakeUpdates(over: Partial<UpdatesPort> = {}): UpdatesPort {
  return {
    isEnabled: true,
    isEmbeddedLaunch: true,
    updateId: EMBEDDED_ID,
    checkForUpdateAsync: async () => ({ isAvailable: true }),
    fetchUpdateAsync: async () => ({ isNew: true }),
    reloadAsync: async () => undefined,
    ...over,
  };
}

type FakeStore = LaunchGateMarkerStore & { keys: Set<string> };

function fakeStore(seed: string[] = []): FakeStore {
  const keys = new Set(seed);
  return {
    keys,
    has: async (key) => keys.has(key),
    write: async (key) => {
      keys.add(key);
    },
  };
}

/** A promise that never settles — the update server that does not answer. */
const never = <T,>() => new Promise<T>(() => undefined);

beforeEach(() => {
  setUpdateStaged(false);
});

describe("shouldRunLaunchGate — the decision, without a device", () => {
  const base = { isEnabled: true, isEmbeddedLaunch: true, hasRunBefore: false };

  it("runs on an embedded launch that has never run it", () => {
    expect(shouldRunLaunchGate(base)).toBe(true);
  });

  it("does NOT run once the marker is present — `isEmbeddedLaunch` stays true forever otherwise", () => {
    expect(shouldRunLaunchGate({ ...base, hasRunBefore: true })).toBe(false);
  });

  it("does NOT run when the launch is already an OTA", () => {
    expect(shouldRunLaunchGate({ ...base, isEmbeddedLaunch: false })).toBe(false);
  });

  it("does NOT run in a build with no updates module", () => {
    // `checkForUpdateAsync` REJECTS there. Seven seconds waiting on a rejection
    // would be the tax this gate exists not to pay.
    expect(shouldRunLaunchGate({ ...base, isEnabled: false })).toBe(false);
  });
});

describe("runLaunchUpdateGate — the sequence, with a fake port and store", () => {
  it("embedded + first time + update available → fetches and reloads", async () => {
    const fetchUpdateAsync = jest
      .fn<UpdatesPort["fetchUpdateAsync"]>()
      .mockResolvedValue({ isNew: true });
    const reloadAsync = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const store = fakeStore();

    const result = await runLaunchUpdateGate(fakeUpdates({ fetchUpdateAsync, reloadAsync }), store);

    expect(result).toEqual({ outcome: "reloading" });
    expect(fetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(reloadAsync).toHaveBeenCalledTimes(1);
    expect(store.keys.has(launchGateMarkerKey(EMBEDDED_ID))).toBe(true);
  });

  it("embedded + first time + nothing available → proceeds, and the marker is written", async () => {
    const fetchUpdateAsync = jest.fn<UpdatesPort["fetchUpdateAsync"]>();
    const reloadAsync = jest.fn<() => Promise<void>>();
    const store = fakeStore();

    const result = await runLaunchUpdateGate(
      fakeUpdates({
        checkForUpdateAsync: async () => ({ isAvailable: false }),
        fetchUpdateAsync,
        reloadAsync,
      }),
      store,
    );

    expect(result).toEqual({ outcome: "proceed", reason: "up-to-date" });
    expect(fetchUpdateAsync).not.toHaveBeenCalled();
    expect(reloadAsync).not.toHaveBeenCalled();
    expect(store.keys.has(launchGateMarkerKey(EMBEDDED_ID))).toBe(true);
  });

  it("embedded + marker already present → no check at all", async () => {
    const checkForUpdateAsync = jest.fn<UpdatesPort["checkForUpdateAsync"]>();
    const store = fakeStore([launchGateMarkerKey(EMBEDDED_ID)]);

    const result = await runLaunchUpdateGate(fakeUpdates({ checkForUpdateAsync }), store);

    expect(result).toEqual({ outcome: "skipped" });
    expect(checkForUpdateAsync).not.toHaveBeenCalled();
  });

  it("a NEW binary gets its own first-launch check — the marker is per embedded update id", async () => {
    // A Play upgrade to the next versionCode ships an embedded bundle as old
    // as its build. Keying the marker on the embedded id is what makes that
    // install ask once too, instead of inheriting the old binary's marker.
    const checkForUpdateAsync = jest
      .fn<UpdatesPort["checkForUpdateAsync"]>()
      .mockResolvedValue({ isAvailable: false });
    const store = fakeStore([launchGateMarkerKey("00000000-0000-4000-8000-000000000000")]);

    await runLaunchUpdateGate(fakeUpdates({ checkForUpdateAsync }), store);

    expect(checkForUpdateAsync).toHaveBeenCalledTimes(1);
  });

  it("not embedded → no check", async () => {
    const checkForUpdateAsync = jest.fn<UpdatesPort["checkForUpdateAsync"]>();
    const store = fakeStore();

    const result = await runLaunchUpdateGate(
      fakeUpdates({ isEmbeddedLaunch: false, checkForUpdateAsync }),
      store,
    );

    expect(result).toEqual({ outcome: "skipped" });
    expect(checkForUpdateAsync).not.toHaveBeenCalled();
    // And no marker either: nothing ran, nothing to remember.
    expect(store.keys.size).toBe(0);
  });

  it("timeout on the check → proceeds", async () => {
    const reloadAsync = jest.fn<() => Promise<void>>();
    const result = await runLaunchUpdateGate(
      fakeUpdates({ checkForUpdateAsync: never, reloadAsync }),
      fakeStore(),
      { timeoutMs: 5 },
    );

    expect(result).toEqual({ outcome: "proceed", reason: "timeout" });
    expect(reloadAsync).not.toHaveBeenCalled();
  });

  it("timeout on the FETCH → proceeds, and a late landing still marks the bundle staged", async () => {
    // The deadline is for the WHOLE sequence, not per call. And the native
    // fetch does not stop when the race is lost: when it lands, the bundle is
    // on the device and `AboutSection` should offer "Reiniciar ahora" instead
    // of looking for it.
    let landFetch: (value: { isNew: boolean }) => void = () => undefined;
    const fetchUpdateAsync = () =>
      new Promise<{ isNew: boolean }>((resolve) => {
        landFetch = resolve;
      });
    const reloadAsync = jest.fn<() => Promise<void>>();

    const result = await runLaunchUpdateGate(
      fakeUpdates({ fetchUpdateAsync, reloadAsync }),
      fakeStore(),
      { timeoutMs: 5 },
    );

    expect(result).toEqual({ outcome: "proceed", reason: "timeout" });
    expect(reloadAsync).not.toHaveBeenCalled();
    expect(isUpdateStaged()).toBe(false);

    landFetch({ isNew: true });
    await waitFor(() => expect(isUpdateStaged()).toBe(true));
  });

  it("a fetch that stages nothing → proceeds without reload", async () => {
    // `UpdateFetchResult`'s failure arm RESOLVES (`{ isNew: false }`, finding
    // H2). A reload over it would be a restart that changes nothing.
    const reloadAsync = jest.fn<() => Promise<void>>();
    const result = await runLaunchUpdateGate(
      fakeUpdates({ fetchUpdateAsync: async () => ({ isNew: false }), reloadAsync }),
      fakeStore(),
    );

    expect(result).toEqual({ outcome: "proceed", reason: "nothing-staged" });
    expect(reloadAsync).not.toHaveBeenCalled();
    expect(isUpdateStaged()).toBe(false);
  });

  it("a roll-back to embedded IS a staged outcome, and reloads", async () => {
    // The recall path `update-check.ts` is careful about: `isNew: false` with
    // `isRollBackToEmbedded: true` is a real staged bundle.
    const reloadAsync = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const result = await runLaunchUpdateGate(
      fakeUpdates({
        checkForUpdateAsync: async () => ({ isAvailable: false, isRollBackToEmbedded: true }),
        fetchUpdateAsync: async () => ({ isNew: false, isRollBackToEmbedded: true }),
        reloadAsync,
      }),
      fakeStore(),
    );

    expect(result).toEqual({ outcome: "reloading" });
    expect(reloadAsync).toHaveBeenCalledTimes(1);
  });

  it("writes the marker even when the check throws, so a dead spot costs ONE slow launch", async () => {
    const store = fakeStore();
    const result = await runLaunchUpdateGate(
      fakeUpdates({
        checkForUpdateAsync: async () => {
          throw new Error("no signal");
        },
      }),
      store,
    );

    expect(result).toEqual({ outcome: "proceed", reason: "failed" });
    expect(store.keys.has(launchGateMarkerKey(EMBEDDED_ID))).toBe(true);
  });

  it("a reload that rejects → proceeds, with the bundle reported as staged", async () => {
    const result = await runLaunchUpdateGate(
      fakeUpdates({
        reloadAsync: async () => {
          throw new Error("could not reload");
        },
      }),
      fakeStore(),
    );

    expect(result).toEqual({ outcome: "proceed", reason: "reload-failed" });
    // Truthful bookkeeping: the bytes ARE on the device, and the card should
    // offer the restart rather than look for a bundle already there.
    expect(isUpdateStaged()).toBe(true);
  });

  it("an unreadable store is treated as 'never ran' — one slow launch, not a crash", async () => {
    const checkForUpdateAsync = jest
      .fn<UpdatesPort["checkForUpdateAsync"]>()
      .mockResolvedValue({ isAvailable: false });
    const result = await runLaunchUpdateGate(fakeUpdates({ checkForUpdateAsync }), {
      has: async () => {
        throw new Error("storage unavailable");
      },
      write: async () => {
        throw new Error("storage unavailable");
      },
    });

    expect(result).toEqual({ outcome: "proceed", reason: "up-to-date" });
    expect(checkForUpdateAsync).toHaveBeenCalledTimes(1);
  });
});

describe("useLaunchUpdateGate — the phases the root layout renders", () => {
  const phases: LaunchGatePhase[] = [];

  function Harness({ updates, store }: { updates: UpdatesPort; store: LaunchGateMarkerStore }) {
    const phase = useLaunchUpdateGate(updates, store);
    phases.push(phase);
    return null;
  }

  beforeEach(() => {
    phases.length = 0;
  });

  it("answers `done` on the FIRST render when the launch is not embedded", () => {
    render(<Harness updates={fakeUpdates({ isEmbeddedLaunch: false })} store={fakeStore()} />);
    expect(phases[0]).toBe("done");
  });

  it("answers `done` on the FIRST render when updates are disabled", () => {
    render(<Harness updates={fakeUpdates({ isEnabled: false })} store={fakeStore()} />);
    expect(phases[0]).toBe("done");
  });

  it("goes deciding → updating → done around a check that finds nothing", async () => {
    // The check is held open so the `updating` frame — the one that carries
    // "Actualizando la app…" — is observable while the network is pending. A
    // check that resolved in the same flush would be batched with `done` and
    // prove nothing about what the person sees.
    let answerCheck: (value: { isAvailable: boolean }) => void = () => undefined;
    const checkForUpdateAsync = () =>
      new Promise<{ isAvailable: boolean }>((resolve) => {
        answerCheck = resolve;
      });
    render(<Harness updates={fakeUpdates({ checkForUpdateAsync })} store={fakeStore()} />);
    expect(phases[0]).toBe("deciding");
    await waitFor(() => expect(phases.at(-1)).toBe("updating"));

    answerCheck({ isAvailable: false });
    await waitFor(() => expect(phases.at(-1)).toBe("done"));
  });

  it("goes deciding → done, never `updating`, when the marker is already there", async () => {
    const checkForUpdateAsync = jest.fn<UpdatesPort["checkForUpdateAsync"]>();
    render(
      <Harness
        updates={fakeUpdates({ checkForUpdateAsync })}
        store={fakeStore([launchGateMarkerKey(EMBEDDED_ID)])}
      />,
    );
    await waitFor(() => expect(phases.at(-1)).toBe("done"));
    expect(phases).not.toContain("updating");
    expect(checkForUpdateAsync).not.toHaveBeenCalled();
  });

  it("releases the launch on a timeout instead of holding the spinner", async () => {
    // The hook takes the module default of 7 s; the sequence is proven bounded
    // above with an injected timeout. This proves the HOOK lands on `done`
    // after a failure rather than staying on `updating`.
    render(
      <Harness
        updates={fakeUpdates({
          checkForUpdateAsync: async () => {
            throw new Error("no signal");
          },
        })}
        store={fakeStore()}
      />,
    );
    await waitFor(() => expect(phases.at(-1)).toBe("done"));
  });
});

describe("the foreground hook stays quiet while the gate holds the launch", () => {
  const addEventListener = jest.spyOn(AppState, "addEventListener");
  const remove = jest.fn();

  function emit(next: AppStateStatus): void {
    const listener = addEventListener.mock.calls.at(-1)?.[1] as
      | ((state: AppStateStatus) => void)
      | undefined;
    if (listener === undefined) throw new Error("the hook registered no AppState listener");
    listener(next);
  }

  function Foreground({ updates, suspended }: { updates: UpdatesPort; suspended: boolean }) {
    useForegroundUpdateCheck(updates, { suspended });
    return null;
  }

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    addEventListener.mockReset();
    addEventListener.mockReturnValue({ remove } as ReturnType<typeof AppState.addEventListener>);
  });

  it("drops a foreground edge while suspended, and takes the next one once released", async () => {
    const checkForUpdateAsync = jest
      .fn<UpdatesPort["checkForUpdateAsync"]>()
      .mockResolvedValue({ isAvailable: false });
    const updates = fakeUpdates({ isEmbeddedLaunch: false, checkForUpdateAsync });
    const view = render(<Foreground updates={updates} suspended={true} />);

    emit("background");
    emit("active");
    await settle();
    // Two fetches into one staging directory is the overlap this exists to stop.
    expect(checkForUpdateAsync).not.toHaveBeenCalled();

    view.rerender(<Foreground updates={updates} suspended={false} />);
    emit("background");
    emit("active");
    await settle();
    expect(checkForUpdateAsync).toHaveBeenCalledTimes(1);
  });
});
