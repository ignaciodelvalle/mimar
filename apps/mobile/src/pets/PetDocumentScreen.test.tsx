// `PetDocumentScreen` — the two-faced document, rendered.
//
// WHAT A RENDER TEST ADDS that the view-model tests cannot: the view-model
// proves an unavailable section keeps its refusal copy, and proves nothing
// about whether the SCREEN prints it. These are the per-section honesty tests
// the recomposition had to keep alive, plus the fences the two-face rewrite
// added: both face labels exist, the turn button carries its toggle state,
// org/caretaker viewers keep their viewer line, the QR block actually
// navigates (it was inert before), and a control with no native destination
// is drawn disabled — never as a working-looking button, never omitted.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { BackHandler, RefreshControl, StyleSheet } from "react-native";

import type { OwnerPetDetailV1 } from "@dim/contract/api";

import { createNavigationFake } from "../ui/navigation-fake";
import { vaccineRemindersRoute } from "../ui/routes";
import { TOUCH_TARGET } from "../ui/theme";

const mockPush = jest.fn();
// `.mockResolvedValue` AND NOT A BARE `jest.fn()`, the hazard `components.test.tsx`
// documents: the two "Disponible en la web" rows call `.catch()` on what
// `openURL` returns, and an unmocked `jest.fn()` resolves that against
// `undefined` — a TypeError inside the press handler rather than a failed
// assertion.
const mockOpenURL = jest.fn<(url: string) => Promise<unknown>>().mockResolvedValue(undefined);
const mockFetchOwnerPetDetail = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockFetchFormerOwnerPetRead = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockFetchPetLibreta = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSendReminder = jest.fn<(...args: unknown[]) => Promise<unknown>>();

/** Every focus callback currently mounted, so a test can fire a RE-focus. */
const mockFocusCallbacks: Array<() => undefined | (() => void)> = [];

// For `VacunasScreen`'s draft-discard guard (`useNavigation`); the document
// screen itself never asks for one. See `ui/navigation-fake.ts`.
const mockNav = createNavigationFake();

// THE HARDWARE BACK BUTTON (T4-M2). SPIED ON THE PUBLIC API rather than
// mocked by internal file path — the same rule `use-qr-spotlight.test.tsx`
// states for `AppState`. `BackHandler.addEventListener` on iOS (which is what
// this suite runs under) is a stub that never actually calls its handler, so
// the real module has nothing to drive the assertions below; the spy is what
// makes the registered handler reachable from a test.
type BackPressHandler = () => boolean | null | undefined;
const mockBackHandlers: BackPressHandler[] = [];
const backHandlerAddEventListener = jest
  .spyOn(BackHandler, "addEventListener")
  .mockImplementation(((_eventName: string, handler: BackPressHandler) => {
    mockBackHandlers.push(handler);
    return {
      remove: () => {
        const at = mockBackHandlers.indexOf(handler);
        if (at >= 0) mockBackHandlers.splice(at, 1);
      },
    };
  }) as typeof BackHandler.addEventListener);

/**
 * Presses the hardware back button, as the LAST-registered listener sees it.
 * Wrapped in `act` because, unlike `fireEvent`, calling the handler directly
 * does not go through React Native Testing Library's own event dispatch.
 */
function pressHardwareBack(): boolean | null | undefined {
  const handler = mockBackHandlers.at(-1);
  if (handler === undefined) throw new Error("no hardwareBackPress listener registered");
  let result: boolean | null | undefined;
  act(() => {
    result = handler();
  });
  return result;
}

jest.mock("expo-linking", () => ({ openURL: (url: string) => mockOpenURL(url) }));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  useNavigation: () => mockNav.navigation,
  // The real one runs its callback when the screen gains focus. Under test
  // there is no navigator, so the stand-in runs it on mount AND keeps a handle
  // on it, because the F9 defect is about a screen that is ALREADY MOUNTED when
  // it regains focus — a mount-only stand-in can only be re-fired by remounting,
  // which is precisely the case that never had the bug.
  //
  // THE RETURNED CLEANUP IS CAPTURED AND RUN ON UNMOUNT (T4-M2). It used to be
  // dropped on the floor — the effect's OWN cleanup only removed `callback`
  // from `mockFocusCallbacks`, never called what `callback()` itself returned.
  // Every focus effect in this screen tree happened to return nothing, so the
  // gap was invisible, until the hardware-back listener became the first one
  // that does: without this, a `BackHandler` subscription registered by a focus
  // effect would outlive the unmounted screen in every test here, which is
  // exactly the leak T4-M2 exists to prevent in the app itself. `refocus()`
  // below still calls `callback()` directly and does not run a cleanup first —
  // that stays, because it is deliberately modelling a re-focus on an
  // ALREADY-MOUNTED screen (F9), not a blur.
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    const { useEffect, useRef } = require("react");
    const cleanupRef = useRef(undefined);
    useEffect(() => {
      mockFocusCallbacks.push(callback);
      cleanupRef.current = callback();
      return () => {
        const at = mockFocusCallbacks.indexOf(callback);
        if (at >= 0) mockFocusCallbacks.splice(at, 1);
        if (typeof cleanupRef.current === "function") cleanupRef.current();
      };
    }, [callback]);
  },
}));

jest.mock("../api/endpoints", () => ({
  fetchOwnerPetDetail: (...args: unknown[]) => mockFetchOwnerPetDetail(...args),
  fetchFormerOwnerPetRead: (...args: unknown[]) => mockFetchFormerOwnerPetRead(...args),
  fetchPetLibreta: (...args: unknown[]) => mockFetchPetLibreta(...args),
  sendVaccineReminderCommand: (...args: unknown[]) => mockSendReminder(...args),
}));

// The screen now re-reads when the network comes back (B-05, `useReconnect`),
// and the real NetInfo has no native module under jest — it crashes inside its
// own reachability timer, several frames from anything this file is about. The
// stand-in `MisMascotasFooter.test.tsx` already uses.
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));
jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import { BAND_MAX_FONT_SCALE, IDENTITY_POKE_OUT } from "./DocumentChromeNative";
import { ownerActionPanelStyles } from "./OwnerActionPanel";
import { PHOTO_SIZE, ownerFaceStyles } from "./OwnerFace";
import { PetDocumentScreen } from "./PetDocumentScreen";
import { VacunasScreen } from "./VacunasScreen";
import { TURN_PERSPECTIVE } from "./document-turn";

const TOKEN = "DIM-PAMP-0001";

// THE WIRING, READ OFF THE RENDERED TREE. `useDocumentTurn` and `TurningSheet`
// are two halves of one feature and only the hook leaves a trace in behaviour:
// with the `<TurningSheet turn={turn}>` wrapper deleted from this screen the
// faces still swap on their ~205ms delay, so every other test in this file —
// and every test in DocumentTurn.test.tsx, which mounts the sheet itself —
// stays green while the credential stops turning altogether. The only witness
// is the transform on the tree, so these helpers go and find it.

/** A node of the tree as `toJSON` hands it back. */
type RenderedNode = {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: readonly unknown[] | null;
};

function isNode(value: unknown): value is RenderedNode {
  return typeof value === "object" && value !== null && "props" in value && "children" in value;
}

/** The node's `transform` array, or null when it has no style with one. */
function transformOf(node: RenderedNode): readonly unknown[] | null {
  const { style } = node.props;
  if (typeof style !== "object" || style === null) return null;
  const { transform } = style as { transform?: unknown };
  return Array.isArray(transform) ? transform : null;
}

/** The stage the credential turns on: the one view carrying the web's
 *  perspective. Found by that value rather than by component type, so it is the
 *  rendered result being asserted and not the shape of the JSX. */
function stagesIn(node: unknown, found: RenderedNode[] = []): RenderedNode[] {
  if (Array.isArray(node)) {
    for (const child of node) stagesIn(child, found);
    return found;
  }
  if (!isNode(node)) return found;
  const isStage = transformOf(node)?.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { perspective?: unknown }).perspective === TURN_PERSPECTIVE,
  );
  if (isStage === true) found.push(node);
  if (node.children !== null) stagesIn(node.children, found);
  return found;
}

/** Every string rendered inside a node — what the reader sees on that sheet. */
function textUnder(node: unknown, found: string[] = []): string[] {
  if (typeof node === "string") {
    found.push(node);
    return found;
  }
  if (Array.isArray(node)) {
    for (const child of node) textUnder(child, found);
    return found;
  }
  if (isNode(node) && node.children !== null) textUnder(node.children, found);
  return found;
}

/** The single stage, or a failure that says what is missing rather than a
 *  `undefined` two assertions later. */
function theStage(): RenderedNode {
  const stages = stagesIn(screen.toJSON());
  expect(stages).toHaveLength(1);
  const stage = stages[0];
  if (stage === undefined) throw new Error("the document is not mounted on a turning sheet");
  return stage;
}

/**
 * The band carries two turn controls (the mark and the arrow both turn the
 * sheet), but only the arrow is named "Girar a …" and carries the toggle
 * state — the mark says "Marca miMAR: …". So this is a getBy: a second
 * "Girar a …" control is itself the regression.
 */
function firstTurnControl(label: "Girar a Libreta" | "Girar a Credencial") {
  return screen.getByLabelText(label);
}

const OK = <T,>(data: T) => ({ status: "ok", data }) as const;
const UNAVAILABLE = { status: "unavailable" } as const;

function payload(overrides: Partial<Record<string, unknown>> = {}): OwnerPetDetailV1 {
  return {
    payloadVersion: 1,
    publicToken: TOKEN,
    // Envelope field, and the issuing foot reads it from HERE rather than from
    // a section — so the foot survives an identity read that failed.
    issuedAt: "2026-09-03T08:00:00.000Z",
    viewer: { role: "owner", isTitular: true },
    identity: OK({
      name: "Pampa",
      // THE WIRE CODE, not the label: `identity.species` is `pet.species`
      // (`load-owner-pet-detail.ts`), and D3's "Perro de asistencia" gate reads
      // it as the code the web's own row compares against.
      species: "dog",
      sex: "female",
      breed: "Mestiza",
      breedLine: "Mestiza · Hembra · 2 años · Perro",
      photoUrl: null,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
      tags: [{ key: "loc", label: "Palermo, CABA" }],
    }),
    status: OK({
      petStatus: "active",
      ringStatus: "ok",
      situation: null,
      memorial: null,
      pregnancyStatus: null,
      rightCell: "qr",
    }),
    alerts: OK({ items: [] }),
    compliance: OK({
      cards: [{ key: "rabies", label: "Vacuna antirrábica", state: "Vigente" }],
      summary: { total: 1, ok: 1, label: "1 de 1 al día" },
      worstTone: "ok",
      worstIsUnknown: false,
    }),
    // ONE reminder, not zero, and the difference is load-bearing since
    // 2026-09-03. Sections below the document render nothing when they are
    // ok-and-empty, so a fixture with no reminders draws no "Recordatorios"
    // card — and two tests in this file use that card as their marker for
    // "the sections are BELOW the sheet, not on it". They test face scoping,
    // not emptiness; an empty fixture would have them passing for the wrong
    // reason or failing for one. The hide-when-empty rule has its own test.
    reminders: OK({
      items: [
        {
          reminderId: "rem-1",
          title: "Antirrábica anual",
          dueAt: "2026-10-01T12:00:00.000Z",
          daysUntilDue: 28,
          variant: "vacuna",
          isReportable: true,
        },
      ],
      total: 1,
      truncated: false,
    }),
    banners: OK({ caretaker: null, rehome: null, transit: null }),
    cases: OK({ openCount: 0, truncated: false, items: [] }),
    pregnancy: OK(null),
    carousel: OK({ items: [], total: 0 }),
    // `null` = THIS ANIMAL IS NOT UNDER THE PPP REGIME, which is the contract's
    // own reading of the field and the default a mestiza of 2 años deserves. The
    // attestation door's tests override it; every other test in this file is
    // about an animal that never sees it.
    pppRegistries: OK(null),
    ...overrides,
  } as unknown as OwnerPetDetailV1;
}

beforeEach(() => {
  mockPush.mockReset();
  // `mockClear` and not `mockReset`: the resolved-promise behaviour above is
  // the whole point of the mock and `mockReset` would strip it.
  mockOpenURL.mockClear();
  mockFetchOwnerPetDetail.mockReset();
  mockFetchFormerOwnerPetRead.mockReset();
  mockFetchFormerOwnerPetRead.mockResolvedValue({
    outcome: "api-error",
    code: "not_found",
    retryAfterSeconds: null,
  });
  mockFetchPetLibreta.mockReset();
  mockFocusCallbacks.length = 0;
  mockBackHandlers.length = 0;
  backHandlerAddEventListener.mockClear();
  mockFetchOwnerPetDetail.mockResolvedValue({ outcome: "ok", payload: payload() });
  mockFetchPetLibreta.mockResolvedValue({ outcome: "unreachable", detail: "not under test" });
});

/** Re-focus every mounted screen, the way popping back from "Editar datos" does. */
async function refocus(): Promise<void> {
  await act(async () => {
    for (const callback of [...mockFocusCallbacks]) callback();
  });
}

describe("PetDocumentScreen — two faces of one document", () => {
  it("opens on Credencial · frente, with the animal on it", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Pampa")).toBeOnTheScreen();
    expect(
      screen.getByText("Credencial · frente", { includeHiddenElements: true }),
    ).toBeOnTheScreen();
    expect(screen.getByText("Cumplimiento")).toBeOnTheScreen();
    expect(screen.getByText("AL DÍA")).toBeOnTheScreen();
    expect(screen.queryByText("Registrada")).toBeNull();
    expect(screen.queryByText("Registrado/a")).toBeNull();
  });

  it("opens on Libreta · dorso when the caller asked for that face", async () => {
    // D3 (native QA batch 1). The face is `useState`'s INITIAL value, so no turn
    // runs and the band names the back immediately — which is what makes this
    // assertion safe without the fake timers the turning tests need.
    //
    // The one caller is the writer's "Volver a la libreta": before this, saving
    // an asiento returned the reader to the FRONT of the document they had just
    // written into the back of.
    render(<PetDocumentScreen publicToken={TOKEN} initialFace="libreta" />);
    expect(
      await screen.findByText("Libreta · dorso", { includeHiddenElements: true }),
    ).toBeOnTheScreen();
    // And the turn button offers the OTHER face, so the reader is really there
    // rather than looking at a mislabelled front.
    expect(firstTurnControl("Girar a Credencial")).toBeOnTheScreen();
  });

  it("turns to Libreta · dorso and back, and the button carries the toggle state", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    const turn = firstTurnControl("Girar a Libreta");
    expect(turn.props.accessibilityState.selected).toBe(false);

    fireEvent.press(turn);
    // The toggle answers the press AT ONCE, off the requested face — while the
    // band, which names the face actually painted, is still on the front for
    // the ~205ms the sheet spends turning. The two disagreeing here is the
    // design (see DocumentChromeNative's header), not a lag.
    expect(firstTurnControl("Girar a Libreta").props.accessibilityState.selected).toBe(true);

    // Same 5s room as every other post-turn wait in this file: the turn is
    // ~485ms of real timers, and the default 1000ms is only ~2× that on a box
    // shared with every other agent's suite.
    await screen.findByText("Libreta · dorso", { includeHiddenElements: true }, { timeout: 5000 });
    const turnBack = firstTurnControl("Girar a Credencial");
    expect(turnBack.props.accessibilityState.selected).toBe(true);

    fireEvent.press(turnBack);
    expect(
      await screen.findByText(
        "Credencial · frente",
        { includeHiddenElements: true },
        {
          timeout: 5000,
        },
      ),
    ).toBeOnTheScreen();
  });

  it("draws mark and flip as dual 22px turn controls (web band parity)", async () => {
    // Web: `.pc-band-mark-hit` + `.pc-band-flip` — both 22×22 sunk hits; the
    // flip is named "Girar a …", the mark "Marca miMAR: …"; hitSlop expands
    // the thumb target. Asserted on the RENDERED controls so the style
    // reaches them.
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    const turns = [
      screen.getByLabelText("Girar a Libreta"),
      screen.getByLabelText("Marca miMAR: mostrar la libreta"),
    ];
    for (const turn of turns) {
      const style = StyleSheet.flatten(turn.props.style);
      expect(style.width).toBe(22);
      expect(style.height).toBe(22);
    }
  });

  it("centres the photo into the band — the QR left this face (PO 2026-10-05)", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    // No QR mount on the credential face — Compartir owns the bright public
    // credential. The photo is the only identity frame, and it rises into the band.
    expect(screen.queryByLabelText("Ver credencial pública")).toBeNull();
    expect(StyleSheet.flatten(ownerFaceStyles.photoMount)).toMatchObject({
      marginTop: -IDENTITY_POKE_OUT,
      width: PHOTO_SIZE,
      height: PHOTO_SIZE,
      zIndex: 3,
    });
    expect(screen.getByLabelText("Agregar una foto de Pampa")).toBeOnTheScreen();
  });

  it("opens the public credential from Compartir — not a second door on the card", async () => {
    // PO 2026-10-05: the face no longer draws a QR. Compartir is the door to
    // the bright public credential; the token caption under the name is not a tap.
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(screen.queryByLabelText("Ver credencial pública")).toBeNull();
    expect(screen.queryByText("Más")).toBeNull();
    fireEvent.press(screen.getByText("Compartir"));
    expect(mockPush).toHaveBeenCalledWith(`/mascotas/${TOKEN}/compartir`);
  });

  it("paints the server-decided situation on the band chip, on BOTH faces", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        status: OK({
          petStatus: "lost",
          ringStatus: "alerta",
          situation: { key: "perdida", tone: "alerta", icon: "perdida", label: "Perdida" },
          memorial: null,
          pregnancyStatus: null,
          rightCell: "qr",
        }),
      }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(screen.getByText("Perdida")).toBeOnTheScreen();
    // The chip must survive the flip — on the back face it is the only
    // textual carrier of the state. It must also survive the TURN itself: the
    // chip lives in the chrome, which rotates with the sheet rather than being
    // rebuilt at the swap.
    fireEvent.press(firstTurnControl("Girar a Libreta"));
    expect(screen.getByText("Perdida")).toBeOnTheScreen();
    await screen.findByText("Libreta · dorso", { includeHiddenElements: true }, { timeout: 5000 });
    expect(screen.getByText("Perdida")).toBeOnTheScreen();
  });
});

describe("PetDocumentScreen — the hardware back button turns the card back over (T4-M2)", () => {
  it("does nothing on the initial face — the press falls through unhandled", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    // `false` tells `BackHandler` this listener did not handle the press, so
    // it falls through to the gate's `<Redirect>` / the stack's own pop —
    // exactly as if the document had no listener at all.
    expect(pressHardwareBack()).toBe(false);
  });

  it("flips the card back to the initial face and reports the press handled", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    fireEvent.press(firstTurnControl("Girar a Libreta"));
    await screen.findByText("Libreta · dorso", { includeHiddenElements: true }, { timeout: 5000 });

    // `true`: the hardware key did the same thing the turn button does.
    expect(pressHardwareBack()).toBe(true);
    await screen.findByText(
      "Credencial · frente",
      { includeHiddenElements: true },
      { timeout: 5000 },
    );
    expect(firstTurnControl("Girar a Libreta").props.accessibilityState.selected).toBe(false);
  });

  it("does nothing when the document opened on Libreta and never turned — the initial face is not 'the front'", async () => {
    // The contract is `face !== initialFace`, not "face is credencial". A
    // caller that opens the document on the back (the writer's "Volver a la
    // libreta") must not have its own initial face treated as something to
    // turn away from.
    render(<PetDocumentScreen publicToken={TOKEN} initialFace="libreta" />);
    await screen.findByText("Libreta · dorso", { includeHiddenElements: true });

    expect(pressHardwareBack()).toBe(false);
  });

  it("unregisters the listener on unmount", async () => {
    const screenHandle = render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(mockBackHandlers.length).toBe(1);

    screenHandle.unmount();
    expect(mockBackHandlers.length).toBe(0);
  });
});

describe("PetDocumentScreen — the credential is mounted ON the sheet that turns", () => {
  it("puts the whole card on the stage, and leaves the sections below it off", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    const stage = theStage();
    // Flat and facing the reader at rest, on the web's perspective. The
    // perspective is what makes the turn read as a sheet standing up in space
    // rather than a horizontal squash, and it lives in the same transform
    // array as the rotation because that is where React Native reads it.
    expect(transformOf(stage)).toEqual([{ perspective: TURN_PERSPECTIVE }, { rotateY: "0deg" }]);

    // The band and the face are ON it: this is one document turning over, not a
    // decorated container next to one.
    const onTheSheet = textUnder(stage);
    expect(onTheSheet).toContain("Credencial · frente");
    expect(onTheSheet).toContain("Pampa");
    // And the footer sections are NOT: they belong to the face but are drawn
    // below the card, and a sheet that rotated them too would tip the whole
    // screen over instead of the credential.
    expect(onTheSheet).not.toContain("Recordatorios");
    expect(screen.getByText("Recordatorios")).toBeOnTheScreen();
    // NOR ARE THE ACTIONS, since owner-pet-actions (PO): "the buttons come out
    // of the card and sit below it, scrolling with the page". The credential
    // is a document; the panel is what a person does with it.
    for (const action of ["Anotar", "Compartir", "Modo perdida", "Editar datos"]) {
      expect(onTheSheet).not.toContain(action);
      expect(screen.getByText(action)).toBeOnTheScreen();
    }
  });

  it("keeps the libreta on that same stage once the document has turned", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    fireEvent.press(firstTurnControl("Girar a Libreta"));
    await screen.findByText("Libreta · dorso", { includeHiddenElements: true }, { timeout: 5000 });

    // Still exactly one stage, now carrying the other face — the sheet is the
    // thing that persists across the turn, and the libreta is on it rather
    // than beside it.
    //
    // NO ANGLE IS ASSERTED HERE, and the reason is worth writing down: the
    // libreta appears AT THE SWAP, with the sheet edge-on, and the tree reads
    // `-87deg` at this instant because the jump has just landed and phase 2
    // runs on the native driver without re-rendering. That is the choreography
    // working, but it is a fact about when this line runs rather than about
    // what the screen owes the reader, so it stays out of the assertion.
    const stage = theStage();
    expect(textUnder(stage)).toContain("Libreta · dorso");
  });
});

describe("PetDocumentScreen — the sheet and what sits under it turn together", () => {
  it("keeps the front face's footer until the document has actually turned", async () => {
    // "Recordatorios" and its siblings belong to the credencial face but are
    // drawn BELOW the card, outside the rotating sheet. If they keyed off the
    // requested face they would disappear ~205ms before the card showed the
    // libreta — one screen changing in two visible waves. ("Actualizar" cannot
    // be the marker here: BOTH faces offer one, so it never goes away.)
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    fireEvent.press(firstTurnControl("Girar a Libreta"));
    expect(screen.getByText("Recordatorios")).toBeOnTheScreen();
    // The action panel is the credential's too, and turns with it.
    expect(screen.getByText("Editar datos")).toBeOnTheScreen();

    await screen.findByText("Libreta · dorso", { includeHiddenElements: true }, { timeout: 5000 });
    expect(screen.queryByText("Recordatorios")).toBeNull();
    expect(screen.queryByText("Editar datos")).toBeNull();
  });
});

describe("PetDocumentScreen — a failure is never drawn as an absence", () => {
  it("renders every unavailable section as its refusal, not as an empty view", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        identity: UNAVAILABLE,
        status: UNAVAILABLE,
        alerts: UNAVAILABLE,
        compliance: UNAVAILABLE,
        reminders: UNAVAILABLE,
        banners: UNAVAILABLE,
        cases: UNAVAILABLE,
        pregnancy: UNAVAILABLE,
        carousel: UNAVAILABLE,
      }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    // One refusal per RENDERED section — eight sections, eight refusals, none
    // collapsed into a blank. (identity, status, compliance, alerts on the
    // face; reminders, arreglos, trámites, preñez below it.)
    //
    // Eight and not nine since 2026-09-03: `carousel` is still set to
    // UNAVAILABLE above ON PURPOSE, and this assertion is what proves the
    // section is GONE rather than merely hidden when empty. A section that
    // only skipped its empty arm would still print a refusal here, and this
    // count would still read nine. "Tus otras mascotas" does not belong on one
    // animal's credential in any state — see the note in OwnerFace.tsx.
    const refusals = await screen.findAllByText("No se pudo leer esta sección.");
    expect(refusals).toHaveLength(8);
    // The document is still a document: band, title, turn button.
    expect(
      screen.getByText("Credencial · frente", { includeHiddenElements: true }),
    ).toBeOnTheScreen();
    expect(firstTurnControl("Girar a Libreta")).toBeOnTheScreen();
    // Token caption left the face (PO annotate 2026-10-05); QR mount was
    // already gone (Compartir / the public route own that door).
    expect(screen.queryByText(TOKEN)).toBeNull();
    expect(screen.queryByLabelText("Ver credencial pública")).toBeNull();
  });

  it("ends the document after Avisos — no issuing foot repeating place or consult date", async () => {
    // PO annotate 2026-10-05: "Libreta Sanitaria · Belgrano, CABA" and
    // "Consultada el …" repeated the band, the locality chip and Cumplimiento.
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    expect(screen.queryByText("República Argentina")).toBeNull();
    expect(screen.queryByText(/Libreta Sanitaria/)).toBeNull();
    expect(screen.queryByText(/Consultada el/)).toBeNull();
    expect(screen.queryByText(/Emitida el/)).toBeNull();
  });

  it("does not invent an issuing foot when the identity read failed", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({ identity: UNAVAILABLE }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Identidad");

    expect(screen.queryByText("República Argentina")).toBeNull();
    expect(screen.queryByText(/Libreta Sanitaria/)).toBeNull();
    expect(screen.queryByText(/Consultada el/)).toBeNull();
  });

  it("caps the band's chrome text so it cannot overrun a fixed-height band (B-06)", async () => {
    // Letterhead cap (decision 17A): latent brand, doctype, and the situation
    // chip under the name. Body copy still scales without a ceiling.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        status: OK({
          petStatus: "lost",
          ringStatus: "alerta",
          situation: { key: "perdida", tone: "alerta", icon: "perdida", label: "Perdida" },
          memorial: null,
          pregnancyStatus: null,
          rightCell: "qr",
        }),
      }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    expect(BAND_MAX_FONT_SCALE).toBeLessThanOrEqual(1.3);
    for (const text of ["miMAR", "Credencial · frente", "Perdida"]) {
      const nodes = screen.getAllByText(text, { includeHiddenElements: true });
      expect(nodes.length).toBeGreaterThanOrEqual(1);
      for (const node of nodes) {
        if (node.props.maxFontSizeMultiplier != null) {
          expect(node.props.maxFontSizeMultiplier).toBeLessThanOrEqual(1.3);
        }
      }
    }
  });

  it("shows the identity refusal without a DIM token caption when the read failed", async () => {
    // Token + "Credencial pública" left the front (PO annotate 2026-10-05) —
    // they duplicated Cumplimiento / Compartir. A failed identity still names
    // the refusal; it does not invent a caption.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({ identity: UNAVAILABLE }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Identidad");
    expect(screen.queryByText(TOKEN)).toBeNull();
    expect(screen.queryByText(/Credencial pública/)).toBeNull();
    expect(screen.queryByLabelText("Ver credencial pública")).toBeNull();
    expect(screen.queryByLabelText("Agregar una foto de Pampa")).toBeNull();
  });

  it("draws nothing for a section that is ok and empty, and still draws its refusal", async () => {
    // The pair this file exists to keep apart. An EMPTY section and an
    // UNAVAILABLE one used to look identical — both a titled card with a
    // sentence in it — so a healthy animal's credential was followed by four
    // boxes announcing absences, drawn with the same weight as a real failure.
    //
    // Empty renders nothing. A refusal always renders. Asserting both in one
    // test is deliberate: either rule alone can be satisfied by a mistake that
    // breaks the other (hide everything, or show everything), and only the
    // pair pins the actual behaviour.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        reminders: OK({ items: [], total: 0, truncated: false }),
        cases: OK({ openCount: 0, truncated: false, items: [] }),
        pregnancy: OK(null),
        banners: UNAVAILABLE,
      }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    // Empty: gone entirely — not the title, not the sentence it used to carry.
    expect(screen.queryByText("Trámites")).toBeNull();
    expect(screen.queryByText("Preñez")).toBeNull();
    expect(screen.queryByText("No está preñada.")).toBeNull();
    expect(screen.queryByText("No tiene trámites abiertos.")).toBeNull();

    // THE EXCEPTION IS GONE (PO decision 2026-09-16). Reminders used to stay
    // when empty because the card carried the only door to `/vacunas`; the door
    // moved out of the card (today: the panel's Salud group), so this section
    // follows the same rule as its three siblings above. The door itself is
    // pinned further down, in the "reminders door, in the Salud group" block —
    // including that it survives a failed read, which is what the old
    // exception really protected.
    expect(screen.queryByText("Recordatorios")).toBeNull();
    expect(screen.queryByText("Sin próximas vacunas.")).toBeNull();

    // Unavailable: still there, still saying so. A server that could not
    // answer is not an animal with nothing to report.
    expect(screen.getByText("Arreglos")).toBeOnTheScreen();
    expect(screen.getByText("No se pudo leer esta sección.")).toBeOnTheScreen();
  });

  it("prints the CAS- code of every open case, not only how many there are", async () => {
    // THE REACHABILITY PROOF for the mordedura receipt. The payload carrying
    // `casePublicCode` is not the capability; a person being able to READ the
    // code off the screen is. Until 2026-09-10 this section could only say
    // "1 tramite abierto", so somebody who reported a bite and closed the app
    // had no way back to the code a sanitary authority would ask them for.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        cases: OK({
          openCount: 2,
          truncated: false,
          items: [
            { casePublicCode: "CAS-7788-9900", kind: "bite_incident", status: "open" },
            { casePublicCode: "CAS-1122-3344", kind: "custody_episode", status: "escalated" },
          ],
        }),
      }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    expect(screen.getByText("Trámites")).toBeOnTheScreen();
    expect(screen.getByText("2 trámites abiertos.")).toBeOnTheScreen();
    expect(
      screen.getByText("CAS-7788-9900 · Mordedura / observación rábica · Abierto"),
    ).toBeOnTheScreen();
    expect(screen.getByText("CAS-1122-3344 · Custodia temporal · Escalado")).toBeOnTheScreen();

    // M11 — each line opens the app's own case screen, the web's `/casos/{code}`.
    fireEvent.press(screen.getByText("CAS-7788-9900 · Mordedura / observación rábica · Abierto"));
    expect(mockPush).toHaveBeenCalledWith("/casos/CAS-7788-9900");
  });

  it("says the whole read failed inside the card, and keeps the turn usable", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "api-error",
      code: "temporarily_unavailable",
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/El servidor no pudo responder/)).toBeOnTheScreen();
    // The libreta face has its own read; a failed front face must not
    // imprison the reader on it.
    fireEvent.press(firstTurnControl("Girar a Libreta"));
    expect(
      await screen.findByText(
        "Libreta · dorso",
        { includeHiddenElements: true },
        {
          timeout: 5000,
        },
      ),
    ).toBeOnTheScreen();
  });
});

describe("PetDocumentScreen — the panel below the card (owner-pet-actions)", () => {
  // WHAT CHANGED, AND WHAT THESE PIN. The pill row and the ⋯ Más list used to
  // live INSIDE the credential, and Más was a door to fourteen unrelated rows.
  // The PO's layout (2026-10-01): the card carries no actions; below it sit a
  // primary row [Anotar][Compartir][Modo perdida], the sections that were
  // already below the card, and then the old Más rows in named groups — LA
  // MASCOTA, SALUD, VIAJES, CUSTODIA — with Reportar fallecimiento apart, last.
  // Who gets which row is the contract's catalogue (`derivePetActions`); these
  // tests pin that the screen DRAWS it, in that order, and that every door
  // opens the screen it names.

  it("draws the primary row as exactly Anotar, Compartir and Modo perdida", async () => {
    // Found by the style OBJECT it was built from, not by a testID (the mobile
    // convention: production stays a11y-only and the test reaches under it).
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    const primaryRow = screen.UNSAFE_getByProps({ style: ownerActionPanelStyles.primaryRow });
    const buttons = within(primaryRow).getAllByRole("button");
    expect(buttons).toHaveLength(3);
    expect(within(primaryRow).getByText("Anotar")).toBeOnTheScreen();
    expect(within(primaryRow).getByText("Compartir")).toBeOnTheScreen();
    expect(within(primaryRow).getByText("Modo perdida")).toBeOnTheScreen();
    // Every pill is a thumb-sized target (48dp, `TOUCH_TARGET`).
    expect(StyleSheet.flatten(ownerActionPanelStyles.primaryAction).minHeight).toBe(TOUCH_TARGET);
  });

  it("orders the screen: card, primary row, the existing sections, then the groups", async () => {
    // The plan's layout, read off the rendered text in reading order. A panel
    // mounted ABOVE the reminders — or inside the card again — reorders these.
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    const reading = textUnder(screen.toJSON());
    const at = (text: string) => {
      const index = reading.indexOf(text);
      if (index < 0) throw new Error(`"${text}" is not on the screen`);
      return index;
    };
    expect(at("Cumplimiento")).toBeLessThan(at("Anotar"));
    expect(at("Modo perdida")).toBeLessThan(at("Antirrábica anual"));
    expect(at("Antirrábica anual")).toBeLessThan(at("La mascota"));
    expect(at("La mascota")).toBeLessThan(at("Salud"));
    expect(at("Salud")).toBeLessThan(at("Viajes"));
    expect(at("Viajes")).toBeLessThan(at("Custodia"));
    expect(at("Custodia")).toBeLessThan(at("Reportar fallecimiento"));
  });

  it("announces each group heading as a heading, so TalkBack can walk the groups", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    for (const heading of ["La mascota", "Salud", "Viajes", "Custodia"]) {
      expect(screen.getByRole("header", { name: heading })).toBeOnTheScreen();
    }
  });

  it("takes Editar datos to the edit screen at the top, and Contactos to its own section", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    fireEvent.press(screen.getByText("Editar datos"));
    expect(mockPush).toHaveBeenLastCalledWith(`/mascotas/${TOKEN}/editar`);

    // ONE SCREEN, TWO PROMISES: the contacts row opens the same form ON its
    // section, which is what makes it a different door and not a duplicate.
    fireEvent.press(screen.getByText("Contactos de emergencia"));
    expect(mockPush).toHaveBeenLastCalledWith(`/mascotas/${TOKEN}/editar?seccion=contactos`);
  });

  it("opens every other row's own screen, and leaves a titular no web-only row", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    expect(screen.queryByText("Se hace desde la web")).toBeNull();
    expect(screen.queryByText("Próximamente")).toBeNull();
    const doors: Array<[string, unknown]> = [
      ["Foto", `/mascotas/${TOKEN}/foto`],
      ["Perro de asistencia", `/mascotas/${TOKEN}/asistencia`],
      ["Chapa física", `/mascotas/${TOKEN}/chapita`],
      ["Recordatorios de vacunas", `/mascotas/${TOKEN}/vacunas`],
      ["Viaje y movilidad", `/mascotas/${TOKEN}/viaje`],
      ["Devolución", `/mascotas/${TOKEN}/devolucion`],
      ["Acompañamiento de adopción", `/mascotas/${TOKEN}/buscar-hogar`],
      ["Cuidador temporal", { pathname: `/mascotas/${TOKEN}/cuidado`, params: { name: "Pampa" } }],
      [
        "Transferir la titularidad",
        { pathname: `/mascotas/${TOKEN}/transferir`, params: { name: "Pampa" } },
      ],
    ];
    for (const [label, target] of doors) {
      fireEvent.press(screen.getByText(label));
      expect([label, mockPush.mock.calls.at(-1)?.[0]]).toEqual([label, target]);
    }
    // And nothing left the app.
    expect(mockOpenURL).not.toHaveBeenCalled();
  });
});

describe("PetDocumentScreen — the photo frame is a door (owner-pet-actions)", () => {
  /** The identity section with a photo URL, or none. */
  function withPhoto(photoUrl: string | null) {
    return {
      identity: OK({
        name: "Pampa",
        species: "dog",
        sex: "female",
        breed: "Mestiza",
        breedLine: "Mestiza · Hembra · 2 años · Perro",
        photoUrl,
        jurisdictionProvince: "CABA",
        jurisdictionLocality: "Palermo",
        tags: [],
      }),
    };
  }

  it("asks for a FIRST photo where there is none, and opens the photo screen", async () => {
    // A first photo took four taps (Más, the row, then the picker) while the
    // frame showed a paw and did nothing.
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    expect(screen.getByText("Agregar foto")).toBeOnTheScreen();
    fireEvent.press(screen.getByLabelText("Agregar una foto de Pampa"));
    expect(mockPush).toHaveBeenCalledWith(`/mascotas/${TOKEN}/foto`);
  });

  it("changes an existing photo from the same frame", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload(withPhoto("https://cdn.example/pampa.jpg")),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    expect(screen.queryByText("Agregar foto")).toBeNull();
    fireEvent.press(screen.getByLabelText("Cambiar la foto de Pampa"));
    expect(mockPush).toHaveBeenCalledWith(`/mascotas/${TOKEN}/foto`);
  });

  it("keeps the photo door at least a thumb-sized target (48dp, A-1)", async () => {
    // The mount is the web phone's 116 box; `TOUCH_TARGET` on photoMount holds
    // the door at 48dp if that box is ever shrunk. The QR door left this face.
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(screen.queryByLabelText("Ver credencial pública")).toBeNull();
    const mount = StyleSheet.flatten(ownerFaceStyles.photoMount);
    expect(mount.minWidth).toBe(TOUCH_TARGET);
    expect(mount.minHeight).toBe(TOUCH_TARGET);
    expect(mount.width).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(screen.getByLabelText("Agregar una foto de Pampa")).toBeOnTheScreen();
  });

  it("is a door for a caretaker too — the Foto row's own gate — and for nobody on the org path", async () => {
    // `POST /pets/{token}/photo` takes any holder role: `titular-only.ts` lists
    // photos among what a caretaker MAY do.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({ viewer: { role: "caretaker", isTitular: false } }),
    });
    const caretaker = render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Sos su cuidador");
    expect(screen.getByLabelText("Agregar una foto de Pampa")).toBeOnTheScreen();
    caretaker.unmount();

    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({ viewer: { role: "org_member", isTitular: false } }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("La ves como miembro de la organización");
    // NON-VACUITY: the frame is still drawn — it is the door that is withheld.
    expect(screen.getByText("Pampa")).toBeOnTheScreen();
    expect(screen.queryByLabelText("Agregar una foto de Pampa")).toBeNull();
    expect(screen.queryByText("Agregar foto")).toBeNull();
  });
});

describe("PetDocumentScreen — the viewer line survives, per role", () => {
  it("tells an org member how they hold the animal, and narrows their panel to Compartir", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({ viewer: { role: "org_member", isTitular: false } }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    expect(await screen.findByText("La ves como miembro de la organización")).toBeOnTheScreen();
    // The web's org action row: Compartir, and nothing owner-only — an org
    // member acts from the org portal.
    expect(screen.getByText("Compartir")).toBeOnTheScreen();
    expect(screen.queryByText("Anotar")).toBeNull();
    expect(screen.queryByText("Editar datos")).toBeNull();
    expect(screen.queryByText("La mascota")).toBeNull();
  });

  it("tells a caretaker how they hold the animal, and greys what is not theirs WITH the reason", async () => {
    // THE PO'S RULE, BOTH PLATFORMS: a row that does not apply is drawn grey
    // with its reason, never silently missing — a caretaker looking for
    // "Editar datos" now learns it exists and why it is not theirs, instead of
    // concluding the app cannot do it.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({ viewer: { role: "caretaker", isTitular: false } }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Sos su cuidador")).toBeOnTheScreen();

    // Editar datos and the trip: the arrangement, named (`requireTitularAccess`
    // denies a caretaker; the trip is the family's).
    expect(screen.getAllByText("No disponible para cuidadores")).toHaveLength(2);
    // The titular's own acts, and the titular's own vet and phone.
    expect(screen.getByText("Transferir la titularidad")).toBeOnTheScreen();
    expect(screen.getByText("Contactos de emergencia")).toBeOnTheScreen();

    mockPush.mockClear();
    for (const grey of [
      "Editar datos",
      "Viaje y movilidad",
      "Contactos de emergencia",
      "Transferir la titularidad",
    ]) {
      fireEvent.press(screen.getByText(grey));
    }
    expect(mockPush).not.toHaveBeenCalled();

    // THE PHOTO STAYS A DOOR, and that mirrors the server's own gate rather
    // than the titular one: `POST /pets/{token}/photo` takes any holder role.
    fireEvent.press(screen.getByText("Foto"));
    expect(mockPush).toHaveBeenCalledWith(`/mascotas/${TOKEN}/foto`);
  });
});

describe("PetDocumentScreen — the panel reads petStatus and the role", () => {
  function withStatus(petStatus: string) {
    return {
      status: OK({
        petStatus,
        ringStatus: "ok",
        situation: null,
        memorial: null,
        pregnancyStatus: null,
        rightCell: petStatus === "deceased" ? "none" : "qr",
      }),
    };
  }

  it("paints the last-seen cell when the server said ping", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        status: OK({
          petStatus: "lost",
          ringStatus: "alerta",
          situation: { key: "perdida", tone: "alerta", icon: "perdida", label: "Perdida" },
          memorial: null,
          pregnancyStatus: null,
          rightCell: "ping",
        }),
      }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(screen.getByLabelText("Último lugar conocido")).toBeOnTheScreen();
    expect(screen.queryByLabelText("Ver credencial pública")).toBeNull();
  });

  it("keeps only Compartir, Editar datos, Foto and Contactos for a FALLECIDA animal (PO)", async () => {
    // The titular of a deceased animal used to be offered a red "Modo perdida"
    // and "Transferir la titularidad" — which answers 409 "Abrí su ficha para
    // ver por qué" while the person is standing in the ficha.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload(withStatus("deceased")),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(screen.queryByLabelText("Ver credencial pública")).toBeNull();

    for (const kept of ["Compartir", "Editar datos", "Foto", "Contactos de emergencia"]) {
      expect(screen.getByText(kept)).toBeOnTheScreen();
    }
    for (const gone of [
      "Anotar",
      "Modo perdida",
      "Transferir la titularidad",
      "Cuidador temporal",
      "Devolución",
      "Chapa física",
      "Perro de asistencia",
      "Acompañamiento de adopción",
      "Viaje y movilidad",
      "Recordatorios de vacunas",
      "Reportar fallecimiento",
    ]) {
      expect([gone, screen.queryByText(gone)]).toEqual([gone, null]);
    }
  });

  it("draws the titular-only rows INERT for a co-owner, each with the reason", async () => {
    // The co-owner used to fill in the whole transfer form — address, motivo,
    // comentario — before a refusal the web never lets them reach.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({ viewer: { role: "co_owner", isTitular: false } }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Sos cotitular");

    // The rows are still THERE — a co-owner reading a panel with a hole in it
    // cannot tell a missing feature from a missing permission. Five of them:
    // the contacts, the assistance dog, the caretaker, the adoption support and
    // the transfer.
    expect(screen.getAllByText("Solo el titular")).toHaveLength(5);

    mockPush.mockClear();
    fireEvent.press(screen.getByText("Transferir la titularidad"));
    fireEvent.press(screen.getByText("Cuidador temporal"));
    // FINDING F2, review 2026-09-07: `buscar-hogar/page.tsx` 404s a co-owner,
    // so the row may never be a live link for them — grey is the honest form.
    fireEvent.press(screen.getByText("Acompañamiento de adopción"));
    expect(mockPush).not.toHaveBeenCalled();

    // The control: what a co-owner DOES reach is still a door.
    fireEvent.press(screen.getByText("Editar datos"));
    expect(mockPush).toHaveBeenCalledWith(`/mascotas/${TOKEN}/editar`);
  });

  it("keeps the two find-home labels on their own roles", async () => {
    // One destination, two asks: the titular reads "Acompañamiento de
    // adopción" and the foster reads "Buscar hogar".
    mockFetchOwnerPetDetail.mockResolvedValue({ outcome: "ok", payload: payload() });
    const titular = render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(screen.getByText("Acompañamiento de adopción")).toBeOnTheScreen();
    expect(screen.queryByText("Buscar hogar")).toBeNull();
    titular.unmount();

    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({ viewer: { role: "foster", isTitular: false } }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(screen.getByText("Buscar hogar")).toBeOnTheScreen();
    expect(screen.queryByText("Acompañamiento de adopción")).toBeNull();
  });

  // THE PILOT RULE, kept from 2026-09-11: no row sends anybody to a browser. A
  // tester sent out of the app mid-flow does not come back, and the pilot is
  // measured in people who keep using the app. A row that says where the thing
  // lives costs a moment of mild disappointment; a browser tab costs the
  // session. Asserted on `openURL` NOT BEING CALLED AT ALL.
  it("does NOT send the FOSTER to a browser from Buscar hogar", async () => {
    // The foster's ask is `foster`'s `sendRehomeRequest`, a different module
    // from the titular's `RehomeScreen`. A regression that pointed this row at
    // `rehomeRoute` would send a foster to a screen whose endpoint does not
    // serve them — so "goes nowhere" is asserted against BOTH exits.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({ viewer: { role: "foster", isTitular: false } }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    fireEvent.press(screen.getByText("Buscar hogar"));
    expect(mockOpenURL).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByText("Se hace desde la web")).toBeOnTheScreen();
    // A foster is not the legal owner: "Perro de asistencia" is there, grey.
    fireEvent.press(screen.getByText("Perro de asistencia"));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("keeps Modo perdida on a LOST animal while the titular-only rows go inert", async () => {
    // THE DELIBERATE DIVERGENCE. The web drops "Marcar como perdida" on a lost
    // animal because its LostCaseBlock carries "Marcar como encontrada"; this
    // row IS that cockpit, so taking it away would hide the entry point in the
    // one state where somebody needs it fastest.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload(withStatus("lost")),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(screen.getByText("Modo perdida")).toBeOnTheScreen();

    expect(screen.getAllByText("No se puede en esta situación")).toHaveLength(2);
    mockPush.mockClear();
    fireEvent.press(screen.getByText("Transferir la titularidad"));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("takes NOTHING away when the status section itself failed to load", async () => {
    // `unavailable` means the server could not read the section, which is this
    // face's founding distinction. A client that gated on an unread status
    // would turn a pooler blip into a permissions message.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({ status: UNAVAILABLE }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(screen.getByText("Anotar")).toBeOnTheScreen();
    expect(screen.getByText("Modo perdida")).toBeOnTheScreen();

    expect(screen.queryByText("Solo el titular")).toBeNull();
    mockPush.mockClear();
    fireEvent.press(screen.getByText("Transferir la titularidad"));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: `/mascotas/${TOKEN}/transferir`,
      params: { name: "Pampa" },
    });
  });
});

describe("PetDocumentScreen — a pull re-reads the document without taking it away", () => {
  // WHAT THIS BLOCK EXISTS FOR. "Actualizar" became a pull gesture on
  // 2026-09-03, and the screen adopted `pullToRefresh` WITHOUT the
  // `mode: "initial" | "refresh"` split its four siblings (TurnosScreen,
  // SharesScreen, NotificationsScreen, TransfersScreen) already use. The two
  // consequences were both visible on a device and invisible to the suite:
  // the platform spinner ran during the FIRST read, next to "Leyendo la
  // ficha…", and a pull replaced the whole credential with that placeholder
  // instead of refreshing it underneath. A refresh that unmounts what it is
  // refreshing is a reload.

  const control = () => screen.UNSAFE_getByType(RefreshControl);
  const pull = () => fireEvent(control(), "refresh");

  /** A read that has not answered yet, plus the handle that lands it. */
  function deferredRead() {
    let land!: (value: unknown) => void;
    const promise = new Promise((resolve) => {
      land = resolve;
    });
    return { promise, land: (value: unknown) => land(value) };
  }

  it("does not spin the platform refresher during the first read", async () => {
    const first = deferredRead();
    mockFetchOwnerPetDetail.mockReturnValueOnce(first.promise as Promise<unknown>);
    render(<PetDocumentScreen publicToken={TOKEN} />);

    // The screen's own placeholder is the first read's indicator. The
    // platform's is for the gesture, and no gesture happened.
    expect(screen.getByText("Leyendo la ficha…")).toBeOnTheScreen();
    expect(control().props.refreshing).toBe(false);

    await act(async () => {
      first.land({ outcome: "ok", payload: payload() });
    });
    expect(screen.getByText("Pampa")).toBeOnTheScreen();
  });

  // -------------------------------------------------------------------------
  // lote 1b F9 — THE SPINNER BELONGS TO THE GESTURE
  //
  // `refreshing` is the RefreshControl's OWN prop, and the focus read was wired
  // to `load("refresh")` — so every single return from a pushed screen dropped
  // the platform spinner on somebody who had not pulled anything. The two facts
  // ("a read is happening" and "a finger asked for it") are not the same, and
  // only the second may drive the control.
  // -------------------------------------------------------------------------
  it("does not spin the platform refresher when the screen merely regains focus", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(mockFetchOwnerPetDetail).toHaveBeenCalledTimes(1);

    // Held in flight, so the assertion describes the window the person sees.
    const second = deferredRead();
    mockFetchOwnerPetDetail.mockReturnValueOnce(second.promise as Promise<unknown>);
    await refocus();

    // The re-read IS happening — that half is NAV-3 and stays.
    expect(mockFetchOwnerPetDetail).toHaveBeenCalledTimes(2);
    // And the document is still there, with no spinner nobody asked for.
    expect(screen.getByText("Pampa")).toBeOnTheScreen();
    expect(screen.queryByText("Leyendo la ficha…")).toBeNull();
    expect(control().props.refreshing).toBe(false);

    await act(async () => {
      second.land({ outcome: "ok", payload: payload() });
    });
  });

  it("keeps the credential on screen while a pull re-reads it, and stops when it lands", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(mockFetchOwnerPetDetail).toHaveBeenCalledTimes(1);

    const second = deferredRead();
    mockFetchOwnerPetDetail.mockReturnValueOnce(second.promise as Promise<unknown>);
    act(() => {
      pull();
    });

    // The document is STILL THERE, being refreshed underneath — the animal,
    // the sections below the card, and no placeholder.
    expect(screen.getByText("Pampa")).toBeOnTheScreen();
    expect(screen.getByText("Recordatorios")).toBeOnTheScreen();
    expect(screen.queryByText("Leyendo la ficha…")).toBeNull();
    expect(control().props.refreshing).toBe(true);
    expect(mockFetchOwnerPetDetail).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.land({ outcome: "ok", payload: payload() });
    });
    await waitFor(() => expect(control().props.refreshing).toBe(false));
    expect(screen.getByText("Pampa")).toBeOnTheScreen();
  });

  it("re-reads the libreta from the back face without taking the face away", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    fireEvent.press(firstTurnControl("Girar a Libreta"));
    await screen.findByText("Libreta · dorso", { includeHiddenElements: true }, { timeout: 5000 });
    await waitFor(() => expect(mockFetchPetLibreta).toHaveBeenCalledTimes(1));

    // Both reads held in flight, so the assertions below describe the pull
    // WHILE it is happening rather than after it has finished.
    const ledger = deferredRead();
    const detail = deferredRead();
    mockFetchPetLibreta.mockReturnValueOnce(ledger.promise as Promise<unknown>);
    mockFetchOwnerPetDetail.mockReturnValueOnce(detail.promise as Promise<unknown>);
    act(() => {
      pull();
    });

    // The two faces have SEPARATE reads, and one pull has to reach both — but
    // reaching the libreta must not mean throwing it away and mounting a new
    // one. The placeholder is the witness that it was: it only renders while
    // the libreta's own state is `loading`.
    expect(screen.queryByText("Leyendo la libreta…")).toBeNull();
    // NO WRITE BUTTON ON THIS FACE (PO annotate 2026-10-05, LibretaScreen.tsx):
    // Anotar moved to the front face's primary row. Pinned as an absence so a
    // second Anotar cannot creep back onto the ledger during a refresh.
    expect(screen.queryByRole("button", { name: "Anotar" })).toBeNull();
    expect(mockFetchPetLibreta).toHaveBeenCalledTimes(2);
    expect(mockFetchOwnerPetDetail).toHaveBeenCalledTimes(2);

    await act(async () => {
      ledger.land({ outcome: "unreachable", detail: "not under test" });
      detail.land({ outcome: "ok", payload: payload() });
    });
    await waitFor(() => expect(control().props.refreshing).toBe(false));
  });

  it("does not read the libreta at all from the front face", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    act(() => {
      pull();
    });
    await waitFor(() => expect(mockFetchOwnerPetDetail).toHaveBeenCalledTimes(2));
    // The libreta face is not mounted, so there is nothing to refresh there.
    expect(mockFetchPetLibreta).not.toHaveBeenCalled();

    // THE REGRESSION: the nonce this pull bumped is still non-zero when the
    // libreta mounts later. `useFocusEffect` alone must account for the read —
    // a nonce that arrives already set is a fact about an EARLIER pull, not a
    // new one to honour, and mounting must not fire the focus read AND a
    // spurious "refresh" on top of it.
    fireEvent.press(firstTurnControl("Girar a Libreta"));
    await screen.findByText("Libreta · dorso", { includeHiddenElements: true }, { timeout: 5000 });
    expect(mockFetchPetLibreta).toHaveBeenCalledTimes(1);
  });
});

describe("OwnerFace — the photo mount matches the web phone recipe", () => {
  it("is 116 with a surface ring inside the outlined mount", () => {
    const mount = StyleSheet.flatten(ownerFaceStyles.photoMount);
    const photo = StyleSheet.flatten(ownerFaceStyles.photo);
    expect(mount.width).toBe(PHOTO_SIZE);
    expect(mount.height).toBe(PHOTO_SIZE);
    expect(photo.borderWidth).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// S-1 / VT-2 — A PHOTO THAT WOULD NOT LOAD IS NOT AN ANIMAL WITH NO PHOTO
// ---------------------------------------------------------------------------

describe("the credential photo", () => {
  it("names the failure when the image cannot be fetched", async () => {
    // RN's <Image> draws NOTHING on a failed load: a blank frame the size of
    // the photo, which reads as "this animal has no photo" — a claim about the
    // record, made by a ten-second network failure.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        identity: {
          status: "ok",
          data: {
            name: "Pampa",
            species: "Perro",
            sex: "female",
            breed: "Mestiza",
            breedLine: "Mestiza · Hembra · 2 años · Perro",
            photoUrl: "https://cdn.example/pampa.jpg",
            jurisdictionProvince: "CABA",
            jurisdictionLocality: "Palermo",
            tags: [],
          },
        },
      }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);

    const photo = await screen.findByLabelText("Foto de Pampa");
    expect(screen.queryByText("Foto no disponible")).toBeNull();

    await act(async () => {
      fireEvent(photo, "error");
    });

    expect(screen.getByText("Foto no disponible")).toBeOnTheScreen();
  });
});

// ---------------------------------------------------------------------------
// The reminders door lives in the panel's Salud group, and the screen behind it
// ---------------------------------------------------------------------------
//
// `VacunasScreen` is tested HERE rather than in a file of its own because the
// count of `apps/mobile/src/**/*.test.tsx` is an architecture fact
// (`scripts/architecture-facts.ts` → `mobile_jest_files`) with a three-step
// chain behind it, and because the screen IS this document's reminders section
// continued.
//
// THE DOOR HAS MOVED TWICE: out of the card below the credential into the Más
// sheet (PO, 2026-09-16), then into the panel's SALUD group with no sheet to
// open first (owner-pet-actions). The tests below still pin the SAME two
// properties, because those are what every move had to preserve:
//   1. the door is reachable, and goes to /vacunas;
//   2. a reminders read that FAILED cannot take the door with it.
// The catalogue gates the row on the animal and the viewer, never on the
// reminders section: the write does not read the list.

describe("PetDocumentScreen — the reminders door, in the Salud group", () => {
  it("WITH ROWS: the card lists them, and the Salud row carries the way in", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(screen.getByText("Antirrábica anual")).toBeOnTheScreen();

    fireEvent.press(screen.getByText("Recordatorios de vacunas"));
    expect(mockPush).toHaveBeenCalledWith(vaccineRemindersRoute(TOKEN));
  });

  it("NOTHING SCHEDULED: no card at all, and the door is still there", async () => {
    // The PO's report, pinned: a healthy animal's document used to be followed
    // by a titled box whose only content was the news that there is no news.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({ reminders: OK({ items: [], total: 0, truncated: false }) }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    expect(screen.queryByText("Recordatorios")).toBeNull();
    expect(screen.queryByText("Sin próximas vacunas.")).toBeNull();

    fireEvent.press(screen.getByText("Recordatorios de vacunas"));
    expect(mockPush).toHaveBeenCalledWith(vaccineRemindersRoute(TOKEN));
  });

  it("READ FAILED: the refusal is drawn AND the door survives it", async () => {
    // The dead end this exists against: hiding the way in because a read
    // failed tells the person the app cannot schedule a vaccine, when the truth
    // is that the app could not READ the list. The write needs no list, and the
    // catalogue never reads it.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({ reminders: UNAVAILABLE }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    expect(screen.getByText("Recordatorios")).toBeOnTheScreen();
    expect(screen.getByText("No se pudo leer esta sección.")).toBeOnTheScreen();

    fireEvent.press(screen.getByText("Recordatorios de vacunas"));
    expect(mockPush).toHaveBeenCalledWith(vaccineRemindersRoute(TOKEN));
  });
});

describe("VacunasScreen — programar y eliminar, behind the card", () => {
  beforeEach(() => {
    mockSendReminder.mockReset();
    mockNav.reset();
  });

  it("a REPLAYED cancel (changed: false) renders as DONE, not as an error, and the row leaves", async () => {
    // The endpoint answers 200 `changed: false` when the row was already gone —
    // a second tap, or a retry after a lost response. That is a success and
    // the screen must say so; "no hay recordatorio que eliminar" would tell
    // somebody their cancel failed when it is exactly what already happened.
    mockSendReminder.mockResolvedValue({
      outcome: "ok",
      payload: { command: "cancel_vaccine_reminder", reminderId: "rem-1", changed: false },
    });
    render(<VacunasScreen publicToken={TOKEN} />);
    await screen.findByText("Antirrábica anual");

    fireEvent.press(screen.getByText("Eliminar"));

    expect(await screen.findByText("Ese recordatorio ya estaba eliminado.")).toBeOnTheScreen();
    expect(screen.queryByText("Antirrábica anual")).toBeNull();
    expect(screen.getByText("Sin próximas vacunas.")).toBeOnTheScreen();
    expect(screen.queryByText("No pudimos guardar el recordatorio.")).toBeNull();
    expect(mockSendReminder).toHaveBeenCalledWith({}, TOKEN, {
      command: "cancel_vaccine_reminder",
      reminderId: "rem-1",
    });
  });

  it("a first cancel (changed: true) says it is done and the row leaves", async () => {
    mockSendReminder.mockResolvedValue({
      outcome: "ok",
      payload: { command: "cancel_vaccine_reminder", reminderId: "rem-1", changed: true },
    });
    render(<VacunasScreen publicToken={TOKEN} />);
    await screen.findByText("Antirrábica anual");

    fireEvent.press(screen.getByText("Eliminar"));

    expect(await screen.findByText("Listo. El recordatorio quedó eliminado.")).toBeOnTheScreen();
    expect(screen.queryByText("Antirrábica anual")).toBeNull();
  });

  it("schedules in the contract's shape: the typed DD/MM/AAAA crosses as YYYY-MM-DD, blank notes as null", async () => {
    mockSendReminder.mockResolvedValue({
      outcome: "ok",
      payload: { command: "create_vaccine_reminder", reminderId: "rem-9" },
    });
    render(<VacunasScreen publicToken={TOKEN} />);
    await screen.findByText("Antirrábica anual");

    fireEvent.changeText(screen.getByLabelText("Vacuna, obligatorio"), "Sextuple");
    fireEvent.changeText(screen.getByLabelText("Fecha estimada, obligatorio"), "20/11/2026");
    fireEvent.press(screen.getByText("Programar vacuna"));

    await waitFor(() => expect(mockSendReminder).toHaveBeenCalledTimes(1));
    expect(mockSendReminder).toHaveBeenCalledWith({}, TOKEN, {
      command: "create_vaccine_reminder",
      vaccineName: "Sextuple",
      dueAt: "2026-11-20",
      description: null,
    });
    expect(
      await screen.findByText("Listo. Te vamos a avisar cuando se acerque la fecha de Sextuple."),
    ).toBeOnTheScreen();
    // The list is RE-READ after a landed schedule: the ack carries only the id,
    // and the due label is the server's to compute.
    await waitFor(() => expect(mockFetchOwnerPetDetail).toHaveBeenCalledTimes(2));
  });

  it("refuses a blank vaccine name locally, in the web's own words, and posts nothing", async () => {
    render(<VacunasScreen publicToken={TOKEN} />);
    await screen.findByText("Antirrábica anual");

    fireEvent.changeText(screen.getByLabelText("Fecha estimada, obligatorio"), "20/11/2026");
    fireEvent.press(screen.getByText("Programar vacuna"));

    expect(await screen.findByText("Falta el nombre de la vacuna.")).toBeOnTheScreen();
    expect(mockSendReminder).not.toHaveBeenCalled();
  });

  it("UNKNOWN still offers: a reminders read that failed keeps the form and does not say 'sin próximas vacunas'", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({ reminders: UNAVAILABLE }),
    });
    render(<VacunasScreen publicToken={TOKEN} />);

    expect(await screen.findByText("No se pudo leer esta sección.")).toBeOnTheScreen();
    expect(screen.getByText("Programar vacuna")).toBeOnTheScreen();
    expect(screen.queryByText("Sin próximas vacunas.")).toBeNull();
  });

  it("a whole read that FAILED still keeps the form", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue({ outcome: "unreachable", detail: "no network" });
    render(<VacunasScreen publicToken={TOKEN} />);

    expect(
      await screen.findByText("No pudimos conectarnos. Revisá tu conexión."),
    ).toBeOnTheScreen();
    expect(screen.getByText("Programar vacuna")).toBeOnTheScreen();
  });
});

// ---------------------------------------------------------------------------
// The two contextual doors: fallecimiento and la atestación PPP
// ---------------------------------------------------------------------------

/**
 * THE DEFECT THESE PIN. Both forms have been complete and tested on
 * `RecordEventScreen` for weeks, both are in `WRITABLE_KINDS`, and until
 * 2026-09-10 `recordEventRoute` had exactly three call sites in the whole app —
 * none of which named either kind. A person could not reach them at all.
 *
 * EVERY EXPECTED URL IS A STRING LITERAL, not a `recordEventRoute(...)` call.
 * Asserting the navigation against the very function that builds it would pass
 * with the route builder dropping the query string entirely, which is precisely
 * the failure mode here: the picker and the pre-selected form differ ONLY in
 * that query string.
 */
describe("PetDocumentScreen — the two contextual doors", () => {
  /** A compliance section whose ppp card is in the given state. */
  function withPppCard(state: string, tone: string) {
    return {
      compliance: OK({
        cards: [
          { key: "rabies", label: "Vacuna antirrábica", state: "Vigente", tone: "ok" },
          { key: "ppp", label: "Atestación PPP", state, tone },
        ],
        summary: { total: 2, ok: 1, label: "1 de 2 al día" },
        worstTone: tone,
        worstIsUnknown: false,
      }),
    };
  }

  /** The registries section for an animal the regime DOES cover. */
  const PPP_APPLIES = OK([{ id: "caba_ley_4078", label: "CABA · Ley 4078", required: true }]);

  it("reaches the fallecimiento form from its own row at the foot of the panel, carrying the kind", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    // The consequence is on the row BEFORE the tap.
    expect(screen.getByText("Cierra el registro del animal")).toBeOnTheScreen();
    fireEvent.press(screen.getByText("Reportar fallecimiento"));

    expect(mockPush).toHaveBeenCalledWith("/mascotas/DIM-PAMP-0001/asentar?kind=death");
  });

  it("does not fall through to the picker — the death row and Anotar are different doors", async () => {
    // THE NON-VACUITY GUARD. `recordEventRoute(token)` and
    // `recordEventRoute(token, { kind: "death" })` differ only in the query
    // string, so a wiring that forgot the kind would still navigate, still land
    // on a real screen, and still look right in a screenshot — it would just
    // drop the person in the routine-acts picker with no "Fallecimiento" row in
    // it. The two URLs are asserted against each other so the test fails the
    // moment they stop differing.
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    fireEvent.press(screen.getByText("Anotar"));
    expect(mockPush).toHaveBeenLastCalledWith("/mascotas/DIM-PAMP-0001/asentar");

    fireEvent.press(screen.getByText("Reportar fallecimiento"));
    expect(mockPush).toHaveBeenLastCalledWith("/mascotas/DIM-PAMP-0001/asentar?kind=death");
    expect(mockPush).not.toHaveBeenLastCalledWith("/mascotas/DIM-PAMP-0001/asentar");
  });

  it("offers no fallecimiento row on an animal already registered as fallecida", async () => {
    // A second death on one animal is a 409 from `checkWriteGuard`. The row is
    // withheld rather than drawn inert: a deceased animal keeps only Compartir,
    // Editar datos, Foto and Contactos (PO), for the same reason.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        status: OK({
          petStatus: "deceased",
          ringStatus: "ok",
          situation: null,
          memorial: null,
          pregnancyStatus: null,
          rightCell: "none",
        }),
      }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    expect(screen.queryByText("Reportar fallecimiento")).toBeNull();
    // NON-VACUITY: the panel really rendered, and rows that survive a death ARE
    // on it — so the assertion above is about the gate and not about a panel
    // that never mounted.
    expect(screen.getByText("Foto")).toBeOnTheScreen();
  });

  it("puts the atestación door on the PPP card, and it carries the kind", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        ...withPppCard("Atestación requerida", "due"),
        pppRegistries: PPP_APPLIES,
      }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    // The door is IN the Cumplimiento section, beside the card it belongs to —
    // no sheet to open, exactly as the web draws it inside its own ppp card.
    expect(screen.getByText("Atestación requerida")).toBeOnTheScreen();
    fireEvent.press(screen.getByText("Registrar atestación"));

    expect(mockPush).toHaveBeenCalledWith(
      "/mascotas/DIM-PAMP-0001/asentar?kind=dangerous_breed_attestation",
    );
  });

  it("withholds the atestación door from an animal the regime does not cover", async () => {
    // `pppRegistries: null` is the contract's own "not under the PPP regime".
    // The compliance card here is the "Faltan datos" variant, which is a nudge
    // to fill in breed and weight and NOT an attestation that is owed.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        ...withPppCard("Faltan datos", "due"),
        pppRegistries: OK(null),
      }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    expect(screen.getByText("Faltan datos")).toBeOnTheScreen();
    expect(screen.queryByText("Registrar atestación")).toBeNull();
  });

  it("withholds the atestación door when the registries section did not answer", async () => {
    // DELIBERATELY THE OPPOSITE of the pregnancy rows' three-state rule, where
    // an unread fact still offers the row. The regime covers a small minority
    // of dogs, so a door opened on an unread section would put "Atestación de
    // raza peligrosa" in front of almost every owner — the "form that refuses
    // most animals" the contract's docblock refuses to build.
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        ...withPppCard("Atestación requerida", "due"),
        pppRegistries: UNAVAILABLE,
      }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    // NON-VACUITY: the card itself still renders, so this is the door being
    // withheld and not the whole section failing.
    expect(screen.getByText("Atestación requerida")).toBeOnTheScreen();
    expect(screen.queryByText("Registrar atestación")).toBeNull();
  });

  it("takes the atestación door away once the card says Atestada", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        ...withPppCard("Atestada", "ok"),
        pppRegistries: PPP_APPLIES,
      }),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    expect(screen.getByText("Atestada")).toBeOnTheScreen();
    expect(screen.queryByText("Registrar atestación")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The compliance card's secondary line
// ---------------------------------------------------------------------------

describe("the compliance card prints its datum, not just its verdict", () => {
  /**
   * `detail` is the contract's "es-AR secondary line — date, provider, chip
   * number", and this face rendered NEITHER it nor the web's enriched pill.
   *
   * The web suppresses `detail` for exactly two cards — a current rabies stamp
   * and a verified microchip — because its `StatusBadge` has already appended
   * the datum to the pill ("VIGENTE · HASTA 14/01/2027", the chip number
   * itself). This row's value is the bare `card.state` and does no such thing,
   * so on the phone the fact that SATISFIES the obligation was nowhere on the
   * screen: "Microchip · Registrado" with no number, "Vacuna antirrábica ·
   * Vigente" with no until-when.
   *
   * A compliance card that names an obligation and hides the fact behind it is
   * worse than quiet — it looks complete.
   */
  function withDetails() {
    return {
      compliance: OK({
        cards: [
          {
            key: "rabies",
            label: "Vacuna antirrábica",
            state: "Vigente",
            tone: "ok",
            detail: "Próxima 14/01/2027 · Vet. San Justo",
          },
          {
            key: "microchip",
            label: "Microchip",
            state: "Registrado",
            tone: "ok",
            detail: "982000123456789",
          },
        ],
        summary: { total: 2, ok: 2, label: "2 de 2 al día" },
        worstTone: "ok",
        worstIsUnknown: false,
      }),
    };
  }

  it("shows the vaccine's next-due date and the chip number", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload(withDetails()),
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    expect(screen.getByText("Próxima 14/01/2027 · Vet. San Justo")).toBeOnTheScreen();
    expect(screen.getByText("982000123456789")).toBeOnTheScreen();
  });

  it("renders nothing extra when a card carries no detail", async () => {
    // The default fixture's one card has no `detail`. Nothing may appear
    // between the row and the next card — a null datum is not "—", and an empty
    // muted line under every obligation is noise the web does not draw either.
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    expect(screen.getByText("Vacuna antirrábica")).toBeOnTheScreen();
    expect(screen.queryByText("—")).not.toBeOnTheScreen();
    expect(screen.queryByText("null")).not.toBeOnTheScreen();
  });
});

// notificaciones-destinos (2026-10): a seized animal's former titular keeps a
// READ while the custody episode is open (PO 2026-07-18). The owner read says
// not_found for them; the screen then asks for the former-owner face instead of
// stopping at "No disponible".
describe("PetDocumentScreen — the former owner's read-only face", () => {
  it("shows the custody banner and the animal when the server grants the read", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "api-error",
      code: "not_found",
      retryAfterSeconds: null,
    });
    mockFetchFormerOwnerPetRead.mockResolvedValue({
      outcome: "ok",
      payload: {
        payloadVersion: 1,
        issuedAt: "2026-10-06T00:00:00.000Z",
        staleAfter: "2026-10-06T00:01:00.000Z",
        face: "former_owner_during_custody",
        pet: {
          publicToken: TOKEN,
          name: "Toto",
          species: "dog",
          breed: null,
          sex: "male",
          dateOfBirth: null,
        },
        custodyCase: { publicCode: "CAS-CUST-0001" },
      },
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Custodia oficial en curso")).toBeOnTheScreen();
    expect(screen.getByText("Toto")).toBeOnTheScreen();
    expect(screen.getByText(/Caso CAS-CUST-0001/)).toBeOnTheScreen();
    expect(screen.queryByText("No disponible")).not.toBeOnTheScreen();
    expect(mockFetchFormerOwnerPetRead).toHaveBeenCalledWith({}, TOKEN);
  });

  it("keeps the refusal for a stranger: no grant, no face", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue({
      outcome: "api-error",
      code: "not_found",
      retryAfterSeconds: null,
    });
    render(<PetDocumentScreen publicToken={TOKEN} />);
    expect(await screen.findByText("No disponible")).toBeOnTheScreen();
    expect(screen.queryByText("Custodia oficial en curso")).not.toBeOnTheScreen();
  });

  it("never asks for the former-owner face when the owner read succeeds", async () => {
    render(<PetDocumentScreen publicToken={TOKEN} />);
    await waitFor(() => expect(mockFetchOwnerPetDetail).toHaveBeenCalled());
    expect(mockFetchFormerOwnerPetRead).not.toHaveBeenCalled();
  });
});
