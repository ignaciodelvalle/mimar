// The "Acerca de miMAR" block, held to the three ways it answers
// "¿qué versión tenés?": a real OTA update running, the build's own embedded
// code with no hotfix applied yet, and the dev client where expo-updates has
// nothing to say at all. Not "does it render" — a wrong answer here is a
// support reply that trusts a version nobody is actually running.
//
// Since 2026-09-07 it also answers two more (OTA-4, OBS-8): which native
// fingerprint this install is on — the field that decides whether an OTA
// update can reach the phone AT ALL — and whether crash reporting actually
// started on this launch. And it carries the manual update check (OTA-6).

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import type { UpdatesPort } from "./update-check";

let mockExpoConfig: { version?: string } | null;
let mockUpdateId: string | null;
let mockChannel: string | null;
let mockIsEmbeddedLaunch: boolean;
let mockRuntimeVersion: string | null;
let mockReportingActive: boolean;

// Getters, not plain values — the same reason sentry.test.ts's expo-constants
// mock uses one for `expoConfig`: `import * as Updates from "expo-updates"`
// reads these fresh on every property access, so each test below can move
// the variables without re-importing the module under test.
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return mockExpoConfig;
    },
  },
}));
jest.mock("expo-updates", () => ({
  __esModule: true,
  get updateId() {
    return mockUpdateId;
  },
  get channel() {
    return mockChannel;
  },
  get isEmbeddedLaunch() {
    return mockIsEmbeddedLaunch;
  },
  get runtimeVersion() {
    return mockRuntimeVersion;
  },
  isEnabled: true,
  checkForUpdateAsync: async () => ({ isAvailable: false }),
  fetchUpdateAsync: async () => ({ isNew: false }),
  reloadAsync: async () => undefined,
}));
// The real module pulls in the Sentry SDK to answer one boolean. Mocked so the
// row under test is driven by the variable above rather than by whether some
// other test in this file happened to init the SDK first.
jest.mock("../observability/sentry", () => ({
  __esModule: true,
  crashReportingActive: () => mockReportingActive,
}));

import { AboutSection } from "./AboutSection";
import { setUpdateStaged } from "./foreground-update";

/**
 * The port, defaulted to the SUCCESS shape of each call.
 *
 * `fetchUpdateAsync` used to default to `{ isNew: false }` — the FAILURE arm of
 * `UpdateFetchResult`, the one that resolves having staged nothing — and the
 * "downloads what it finds" test below asserted "Hay una versión nueva lista"
 * against it. The test encoded the bug (finding H2, review 2026-09-07): a fake
 * whose defaults are failures teaches every test written against it that the
 * failure is the normal answer.
 */
function fakeUpdates(overrides: Partial<UpdatesPort> = {}): UpdatesPort {
  return {
    isEnabled: true,
    isEmbeddedLaunch: false,
    updateId: "11111111-1111-4111-8111-111111111111",
    checkForUpdateAsync: async () => ({ isAvailable: false }),
    fetchUpdateAsync: async () => ({ isNew: true }),
    reloadAsync: async () => undefined,
    ...overrides,
  };
}

// MODULE STATE, so it has to be put back. `stagedThisSession` outlives a
// render on purpose — a bundle staged in the background is a fact about the
// session, not about a card — and a test that left it set would seed every
// later one with "Reiniciar ahora".
beforeEach(() => {
  setUpdateStaged(false);
});

describe("the about block", () => {
  it("shows the real version, the running update's id, and its channel", () => {
    mockExpoConfig = { version: "0.4.12" };
    mockIsEmbeddedLaunch = false;
    mockUpdateId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    mockChannel = "production";
    mockRuntimeVersion = "9f3c1a77b0de4455aa1200cc3390ffee11223344";
    mockReportingActive = true;

    render(<AboutSection updates={fakeUpdates()} />);

    expect(screen.getByText("0.4.12")).toBeTruthy();
    expect(screen.getByText("a1b2c3d4")).toBeTruthy();
    expect(screen.getByText("production")).toBeTruthy();
  });

  it("names the native fingerprint this install is on, truncated (OTA-4)", () => {
    // THE FIELD THAT ANSWERS "no me llegó la actualización". runtimeVersion is
    // the fingerprint policy's output, and two installs on the same `version`
    // and `channel` with different fingerprints never see each other's updates.
    // Before this row the only place to read it was an EAS dashboard.
    mockExpoConfig = { version: "0.4.12" };
    mockIsEmbeddedLaunch = false;
    mockUpdateId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    mockChannel = "preview";
    mockRuntimeVersion = "9f3c1a77b0de4455aa1200cc3390ffee11223344";
    mockReportingActive = true;

    render(<AboutSection updates={fakeUpdates()} />);

    expect(screen.getByText("9f3c1a77")).toBeTruthy();
    // The whole fingerprint is NOT on screen: forty hex characters is not a
    // thing anybody reads out over WhatsApp, which is what this card is for.
    expect(screen.queryByText("9f3c1a77b0de4455aa1200cc3390ffee11223344")).toBeNull();
  });

  it("says whether crash reporting actually started on THIS launch (OBS-8)", () => {
    mockExpoConfig = { version: "0.4.12" };
    mockIsEmbeddedLaunch = true;
    mockUpdateId = null;
    mockChannel = "preview";
    mockRuntimeVersion = "9f3c1a77";
    mockReportingActive = false;

    render(<AboutSection updates={fakeUpdates()} />);
    expect(screen.getByText("inactivo")).toBeTruthy();

    mockReportingActive = true;
    render(<AboutSection updates={fakeUpdates()} />);
    expect(screen.getByText("activo")).toBeTruthy();
  });

  it("says 'integrada' for the build's own embedded code, not a truncated id", () => {
    // isEmbeddedLaunch wins even when expo-updates hands back a real UUID —
    // that UUID names the embedded update itself, and eight hex characters
    // for "no hotfix has ever applied" would be technically true and useless
    // to a tester reading it out loud.
    mockExpoConfig = { version: "0.4.12" };
    mockIsEmbeddedLaunch = true;
    mockUpdateId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    mockChannel = "preview";
    mockRuntimeVersion = "9f3c1a77";
    mockReportingActive = true;

    render(<AboutSection updates={fakeUpdates()} />);

    expect(screen.getByText("integrada")).toBeTruthy();
    expect(screen.getByText("preview")).toBeTruthy();
  });

  it("falls back to em dashes and 'integrada' in the dev client, where expo-updates has nothing", () => {
    mockExpoConfig = null;
    mockIsEmbeddedLaunch = false;
    mockUpdateId = null;
    mockChannel = null;
    mockRuntimeVersion = null;
    mockReportingActive = false;

    render(<AboutSection updates={fakeUpdates()} />);

    // The version, the channel and the runtime version all fall back to the
    // SAME em dash, so the three absences are asserted together rather than
    // with a `getByText` that would throw on finding more than one match.
    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(screen.getByText("integrada")).toBeTruthy();
  });
});

describe("the manual update check (OTA-6)", () => {
  function baseline() {
    mockExpoConfig = { version: "0.4.12" };
    mockIsEmbeddedLaunch = false;
    mockUpdateId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    mockChannel = "preview";
    mockRuntimeVersion = "9f3c1a77";
    mockReportingActive = true;
  }

  it("says so when there is nothing new — an answer, not silence", async () => {
    baseline();
    render(<AboutSection updates={fakeUpdates()} />);

    fireEvent.press(screen.getByText("Buscar actualización"));

    await waitFor(() => expect(screen.getByText("Ya tenés la última versión.")).toBeTruthy());
  });

  it("opens on the RESTART when the foreground check already staged one (A6-cuenta-resiliencia-08)", () => {
    // `useForegroundUpdateCheck` downloads silently while the app is resident.
    // Without this the card would offer "Buscar actualización" over a bundle
    // already on the device, and pressing it answers "Ya tenés la última
    // versión" — true of what was DOWNLOADED and false of what is RUNNING,
    // which is the sentence that left support with nothing to say.
    baseline();
    setUpdateStaged(true);
    render(<AboutSection updates={fakeUpdates()} />);

    expect(screen.getByText("Reiniciar ahora")).toBeTruthy();
    expect(screen.getByText(/Hay una versión nueva lista/)).toBeTruthy();
    expect(screen.queryByText("Buscar actualización")).toBeNull();
  });

  it("opens on the CHECK when nothing was staged", () => {
    baseline();
    render(<AboutSection updates={fakeUpdates()} />);
    expect(screen.getByText("Buscar actualización")).toBeTruthy();
  });

  it("flips to the RESTART when a bundle is staged while the card is open (F8)", () => {
    // The case above arranges the flag BEFORE the render, which is the only
    // moment a `useState` initializer reads it. Ajustes is three taps down and
    // people leave it open; the foreground check runs on its own while they do.
    // Without a subscription the card sits on "Buscar actualización" over a
    // bundle already on the device, and pressing it answers "Ya tenés la última
    // versión" — the sentence this whole feature exists to eliminate, produced
    // by the feature itself.
    baseline();
    render(<AboutSection updates={fakeUpdates()} />);
    expect(screen.getByText("Buscar actualización")).toBeTruthy();

    act(() => setUpdateStaged(true));

    expect(screen.getByText("Reiniciar ahora")).toBeTruthy();
    expect(screen.getByText(/Hay una versión nueva lista/)).toBeTruthy();
  });

  it("replaces 'Ya tenés la última versión' when a bundle lands after the check said so", async () => {
    // The worst version of the same defect, and the one that names the sentence:
    // the person taps, is told they are up to date, and the background stage
    // lands a second later. The card kept the answer that had just become false.
    baseline();
    render(
      <AboutSection
        updates={fakeUpdates({ checkForUpdateAsync: async () => ({ isAvailable: false }) })}
      />,
    );
    fireEvent.press(screen.getByText("Buscar actualización"));
    await waitFor(() => expect(screen.getByText("Ya tenés la última versión.")).toBeTruthy());

    act(() => setUpdateStaged(true));

    expect(screen.queryByText("Ya tenés la última versión.")).toBeNull();
    expect(screen.getByText("Reiniciar ahora")).toBeTruthy();
  });

  it("does NOT let a staged bundle paint over a restart that FAILED (M2 stays closed)", async () => {
    // The control on the override. A background flag that replaced "No pudimos
    // reiniciar la app" with "Reiniciá la app para empezar a usarla" would
    // re-open finding M2 from the other side: the person taps, it fails, and the
    // screen answers by looking exactly as it did before the tap.
    baseline();
    setUpdateStaged(true);
    render(
      <AboutSection
        updates={fakeUpdates({
          reloadAsync: async () => {
            throw new Error("no");
          },
        })}
      />,
    );
    fireEvent.press(screen.getByText("Reiniciar ahora"));

    await waitFor(() => expect(screen.getByText(/No pudimos reiniciar la app/)).toBeTruthy());
    expect(screen.queryByText(/Hay una versión nueva lista/)).toBeNull();
  });

  it("downloads what it finds and asks for a restart, without restarting by itself", async () => {
    // NOT an automatic reload: the person may be mid-form, and expo-updates
    // applies a staged bundle on the NEXT launch anyway. The button turns into
    // the restart so the choice stays theirs.
    baseline();
    let reloads = 0;
    render(
      <AboutSection
        updates={fakeUpdates({
          checkForUpdateAsync: async () => ({ isAvailable: true }),
          // STATED, not defaulted: this test is the one that says what a
          // download which actually staged a bundle looks like, so the shape it
          // asserts against may not come from somewhere else in the file.
          fetchUpdateAsync: async () => ({ isNew: true, isRollBackToEmbedded: false }),
          reloadAsync: async () => {
            reloads += 1;
          },
        })}
      />,
    );

    fireEvent.press(screen.getByText("Buscar actualización"));

    await waitFor(() =>
      expect(
        screen.getByText("Hay una versión nueva lista. Reiniciá la app para empezar a usarla."),
      ).toBeTruthy(),
    );
    expect(reloads).toBe(0);

    fireEvent.press(screen.getByText("Reiniciar ahora"));
    await waitFor(() => expect(reloads).toBe(1));
  });

  it("does NOT say a bundle is ready when the fetch staged nothing (H2)", async () => {
    // `UpdateFetchResult` has a failure arm that RESOLVES:
    // `{ isNew: false, isRollBackToEmbedded: false }`. `downloadUpdate` used to
    // treat "did not throw" as "staged", so this phone was told to restart for a
    // bundle it had not got — and the restart then changed nothing, which is the
    // one outcome this button exists to make impossible.
    baseline();
    render(
      <AboutSection
        updates={fakeUpdates({
          checkForUpdateAsync: async () => ({ isAvailable: true }),
          fetchUpdateAsync: async () => ({ isNew: false, isRollBackToEmbedded: false }),
        })}
      />,
    );

    fireEvent.press(screen.getByText("Buscar actualización"));

    await waitFor(() =>
      expect(
        screen.getByText(
          "Encontramos una versión nueva pero no pudimos descargarla. Volvé a intentar.",
        ),
      ).toBeTruthy(),
    );
    // And the button did not become the restart, because there is nothing to
    // restart INTO.
    expect(screen.queryByText("Reiniciar ahora")).toBeNull();
  });

  it("treats a roll-back to the embedded bundle as staged, though it is also isNew:false", async () => {
    // The flag is load-bearing rather than decorative. A recall of a bad OTA is
    // the single moment this button matters most, and it answers `isNew: false`
    // exactly like the failure above — so a fix that read `isNew` alone would
    // tell the person holding the broken bundle that the recall failed.
    baseline();
    render(
      <AboutSection
        updates={fakeUpdates({
          checkForUpdateAsync: async () => ({ isAvailable: false, isRollBackToEmbedded: true }),
          fetchUpdateAsync: async () => ({ isNew: false, isRollBackToEmbedded: true }),
        })}
      />,
    );

    fireEvent.press(screen.getByText("Buscar actualización"));

    await waitFor(() =>
      expect(
        screen.getByText("Hay una versión nueva lista. Reiniciá la app para empezar a usarla."),
      ).toBeTruthy(),
    );
  });

  it("says what happened when the check itself fails", async () => {
    baseline();
    render(
      <AboutSection
        updates={fakeUpdates({
          checkForUpdateAsync: async () => {
            throw new Error("no signal");
          },
        })}
      />,
    );

    fireEvent.press(screen.getByText("Buscar actualización"));

    await waitFor(() =>
      expect(
        screen.getByText(
          "No pudimos fijarnos si hay una versión nueva. Revisá tu conexión y volvé a intentar.",
        ),
      ).toBeTruthy(),
    );
  });

  it("does not call an install with no updates module a failure", async () => {
    baseline();
    render(<AboutSection updates={fakeUpdates({ isEnabled: false })} />);

    fireEvent.press(screen.getByText("Buscar actualización"));

    await waitFor(() =>
      expect(
        screen.getByText(
          "Esta instalación no recibe actualizaciones automáticas. Instalá la app desde Play para recibirlas.",
        ),
      ).toBeTruthy(),
    );
  });
});

// ---------------------------------------------------------------------------
// M2 — A RESTART THAT FAILS MAY NOT LOOK LIKE A RESTART NOBODY PRESSED
// ---------------------------------------------------------------------------

describe("the restart (M2)", () => {
  function baseline() {
    mockExpoConfig = { version: "0.4.12" };
    mockIsEmbeddedLaunch = false;
    mockUpdateId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    mockChannel = "preview";
    mockRuntimeVersion = "9f3c1a77";
    mockReportingActive = true;
  }

  /** Get the screen to `ready`, which is the only state the restart exists in. */
  async function readyToRestart(overrides: Partial<UpdatesPort>) {
    baseline();
    render(
      <AboutSection
        updates={fakeUpdates({
          checkForUpdateAsync: async () => ({ isAvailable: true }),
          fetchUpdateAsync: async () => ({ isNew: true }),
          ...overrides,
        })}
      />,
    );
    fireEvent.press(screen.getByText("Buscar actualización"));
    await waitFor(() => expect(screen.getByText("Reiniciar ahora")).toBeTruthy());
  }

  it("says the restart failed instead of redrawing the sentence it already showed", async () => {
    // THE DEFECT: `reloadAsync().catch(() => setState({ phase: "ready" }))`. The
    // person taps "Reiniciar ahora", it rejects, and the screen answers with the
    // exact sentence it was already showing — which reads as "nothing happened",
    // i.e. as a broken button rather than a failed restart.
    await readyToRestart({
      reloadAsync: async () => {
        throw new Error("no puedo");
      },
    });

    fireEvent.press(screen.getByText("Reiniciar ahora"));

    await waitFor(() =>
      expect(
        screen.getByText("No pudimos reiniciar la app. Cerrala y volvé a abrirla."),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByText("Hay una versión nueva lista. Reiniciá la app para empezar a usarla."),
    ).toBeNull();
  });

  it("disables the button while the reload is in flight, so a second tap cannot fire a second one", async () => {
    // Nothing stopped one. Two `reloadAsync` calls racing each other are two
    // attempts to replace the running app, and the person tapping twice is the
    // person who was given no feedback for the first tap.
    let reloads = 0;
    let release = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    await readyToRestart({
      reloadAsync: async () => {
        reloads += 1;
        await inFlight;
      },
    });

    fireEvent.press(screen.getByText("Reiniciar ahora"));
    await waitFor(() => expect(screen.getByText("Reiniciando la app…")).toBeTruthy());

    // The label stays the restart — flipping back to "Buscar actualización"
    // mid-reload would rename the control under the finger that pressed it.
    fireEvent.press(screen.getByText("Reiniciar ahora"));
    expect(reloads).toBe(1);

    // Let the reload settle inside `act`, so the state it writes belongs to this
    // test rather than leaking past it as an open handle.
    await act(async () => {
      release();
    });
  });
});
