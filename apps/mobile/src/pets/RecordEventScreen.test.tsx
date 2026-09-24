// `RecordEventScreen` — the first RENDER tests in this app.
//
// WHY THEY EXIST, GIVEN 180 PASSING PURE TESTS
// ---------------------------------------------------------------------------
// The view-models are covered and the endpoints are covered; what was NOT
// covered is the wiring between them, and that is where this screen's real
// risks live. A form that validates perfectly and never calls the API, a
// refusal that arrives and renders nowhere, an idempotency key that a re-render
// quietly regenerates — every one of those is green under a pure test and
// broken on a phone.
//
// So these assert BEHAVIOUR through the rendered tree: what a person sees, what
// they can press, and what leaves the device when they do.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import {
  Alert,
  AppState,
  type AppStateStatus,
  KeyboardAvoidingView,
  TextInput,
} from "react-native";

import { createNavigationFake } from "../ui/navigation-fake";

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockRecordPetEvent = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockFetchOwnerPetDetail = jest.fn<(...args: unknown[]) => Promise<unknown>>();

// A REAL LISTENER REGISTRY with a stable object and a working unsubscribe — see
// `ui/navigation-fake.ts` for why both halves matter and what the stub they
// replace made invisible.
const mockNav = createNavigationFake();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn() }),
  useNavigation: () => mockNav.navigation,
}));

jest.mock("../api/endpoints", () => ({
  recordPetEvent: (...args: unknown[]) => mockRecordPetEvent(...args),
  // NOT OPTIONAL EVEN THOUGH ONE FORM READS IT. A module mock replaces the
  // whole module: an export left out of it is `undefined` at the call site, and
  // the attestation form would throw on mount rather than fail an assertion.
  fetchOwnerPetDetail: (...args: unknown[]) => mockFetchOwnerPetDetail(...args),
}));

/**
 * `getSessionState` IS NOT DECORATION HERE. The draft store keys every draft by
 * the id of the person who wrote it — two people share a phone in this
 * product's model — so a screen whose session answers "signed-out" persists
 * NOTHING, and every case below about recovering a draft would pass for a build
 * where the feature had been deleted. Signed-in is also what the real screen
 * always sees: the route is behind `useGate`.
 */
const mockSignedInUserId = "99999999-9999-4999-8999-999999999999";
/**
 * Who the session store says is signed in RIGHT NOW. `undefined` is signed-out.
 *
 * MUTABLE AND READ ON EVERY CALL, because the draft hook asks again at write
 * time (A2b): a sign-out does not re-render the form, so a case that wants to
 * prove the late write is refused has to change the answer under a form that
 * never hears about it. Reset to `mockSignedInUserId` before every case.
 */
const mockSession: {
  userId: string | undefined;
  /**
   * What the store answers while `userId` is `undefined`. A deliberate
   * sign-out by default; the A2c cases swap in the two INVOLUNTARY phases — a
   * refresh that timed out (`session-unverified`) and one that was refused
   * (`signed-out` with `auth_expired`) — which must NOT cost the draft.
   */
  notSignedIn: { phase: string; reason?: string; message?: string };
  /**
   * `draftSweepEpoch()`: how many draft sweeps have run. A case that models a
   * DELIBERATE exit bumps it, because that is what the real exit does; the
   * phase alone no longer tells the hook whether the drafts were swept (A2c).
   */
  sweepEpoch: number;
} = {
  userId: mockSignedInUserId,
  notSignedIn: { phase: "signed-out", reason: "user_action" },
  sweepEpoch: 0,
};
jest.mock("../auth/session-store", () => ({
  sessionPort: {},
  getSessionState: () =>
    mockSession.userId === undefined
      ? mockSession.notSignedIn
      : { phase: "signed-in", user: { id: mockSession.userId } },
  draftSweepEpoch: () => mockSession.sweepEpoch,
}));

/**
 * The two network steps a tattoo photo takes before the asiento.
 *
 * MOCKED AT THE FLOW AND NOT AT THE ENDPOINTS, because the endpoints module is
 * already replaced whole by the mock above and adding two more exports to it
 * would spread this kind's wiring across two stubs. The flow's OWN rules are
 * covered by its own test; what these cases prove is what the SCREEN does with
 * each of its two outcomes.
 */
const mockStageTattooPhoto = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("./tattoo-photo-flow", () => ({
  stageTattooPhoto: (...args: unknown[]) => mockStageTattooPhoto(...args),
}));

import { IMAGE_PICK_MARKER_KEY } from "../native/image-pick-marker-store";
import {
  type ImagePickMarker,
  type ImagePickResult,
  type ImagePickerPort,
  resetImagePickerPort,
  setImagePickerPort,
} from "../native/image-picker-port";
import { RecordEventScreen } from "./RecordEventScreen";
import {
  RECORD_KINDS,
  WRITABLE_KINDS as WRITABLE_KIND_SET,
  kindTitle,
  recordEventCta,
} from "./record-event-view-model";

/**
 * Every kind that has a form.
 *
 * DERIVED, NOT RESTATED. This file kept a hand-written copy and it went stale
 * three times in one week — once per kind added — each time failing with
 * "expected exactly one submit control, found 0", which reads like a broken
 * screen and was a list that never learned a name. Pointing at the view-model's
 * own set makes that impossible: a kind it does not know cannot be written.
 */
const WRITABLE_KINDS = [...WRITABLE_KIND_SET];

/**
 * The primary submit, whatever this kind calls it.
 *
 * The label became per-kind with A2-alta-asentar-R05 ("Registrar vacuna",
 * "Confirmar cierre de medicación", …) and none of the cases below is ABOUT the
 * wording — they press the button that writes. Restating eleven strings across
 * twenty-seven call sites would turn a copy change into a twenty-seven-line
 * diff. The WORDING has its own case, with the literals written out, so a label
 * that regressed still turns something red.
 *
 * It fails LOUDLY when it finds none or more than one, rather than returning
 * `undefined` for an assertion two lines later to be confused by.
 */
function submitControl() {
  const nodes = WRITABLE_KINDS.flatMap((kind) => screen.queryAllByText(recordEventCta(kind).label));
  if (nodes.length !== 1) {
    throw new Error(`expected exactly one submit control on screen, found ${nodes.length}`);
  }
  return nodes[0] as NonNullable<(typeof nodes)[number]>;
}

const TOKEN = "DIM-PAMP-0001";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Writes a recovery marker straight to the same AsyncStorage key
 * `image-pick-marker-store.ts` uses (T3-R4, 2026-09-22), so a test can
 * simulate "a previous process wrote this marker before it died" without
 * going through a live pick. Defaults to one that matches the tattoo form on
 * `TOKEN` for `mockSignedInUserId`, fresh; `overrides` bends one field away
 * from that match.
 */
async function seedImagePickMarker(overrides: Partial<ImagePickMarker> = {}): Promise<void> {
  const marker: ImagePickMarker = {
    screen: "tattoo",
    publicToken: TOKEN,
    sessionUserId: mockSignedInUserId,
    launchedAt: Date.now(),
    ...overrides,
  };
  await AsyncStorage.setItem(IMAGE_PICK_MARKER_KEY, JSON.stringify(marker));
}

/** The default answer: the append succeeded and was not a replay. */
function recorded(wasDuplicate = false) {
  return { outcome: "ok", payload: { eventId: EVENT_ID, wasDuplicate } };
}

/** The body of the single call the screen made. */
function sentBody() {
  const call = mockRecordPetEvent.mock.calls[0] as unknown[] | undefined;
  return call?.[2] as Record<string, unknown> | undefined;
}

/** The `Idempotency-Key` the screen sent, per call index. */
function sentKey(index = 0) {
  const call = mockRecordPetEvent.mock.calls[index] as unknown[] | undefined;
  return call?.[3] as string | undefined;
}

/**
 * A build that CAN choose a photo.
 *
 * INSTALLED FOR EVERY CASE BELOW, because the default port answers
 * `available: false` and the tatuaje form then draws a callout instead of a
 * form — which is correct behaviour and would silently take that kind out of
 * every loop in this file. The loops walk the whole union on purpose, so they
 * have to walk it in a build where every kind HAS a form. The unavailable build
 * gets its own cases, which reset the port first.
 *
 * It never actually picks: the cases that press the pick control assert what
 * the screen does with an outcome, not what a native module returns.
 */
/** The shape a ticket mints — `{petId}/{uuid}.{ext}`. */
const A_STAGED_PATH =
  "77777777-7777-4777-8777-777777777777/88888888-8888-4888-8888-888888888888.jpg";

const availablePicker: ImagePickerPort = {
  name: "test-available",
  available: true,
  pickImage: async () => ({ outcome: "cancelled" }),
  // T4-M1 (2026-09-22): `null` here, same as `moduleMissingImagePicker` —
  // most of this file is not about recovery, so nothing is waiting to be
  // recovered. The tatuaje recovery cases below install their own port.
  recoverPendingPick: async () => null,
};

beforeEach(async () => {
  // THE DRAFT STORE IS LIVE IN EVERY CASE IN THIS FILE, because the screen now
  // persists what is typed into it, and the in-memory AsyncStorage from
  // `jest.setup.js` is one Map for the whole file. Without this, a case that
  // types "12,5" into Peso and unmounts leaves a draft that the NEXT case's
  // Peso form recovers, and half this file starts asserting against a banner
  // and a pre-filled field it never asked for.
  await AsyncStorage.clear();
  mockSession.userId = mockSignedInUserId;
  mockSession.notSignedIn = { phase: "signed-out", reason: "user_action" };
  mockSession.sweepEpoch = 0;
  setImagePickerPort(availablePicker);
  mockStageTattooPhoto.mockReset();
  mockStageTattooPhoto.mockResolvedValue({ outcome: "staged", stagedPath: A_STAGED_PATH });
  mockPush.mockReset();
  mockReplace.mockReset();
  mockRecordPetEvent.mockReset();
  mockRecordPetEvent.mockResolvedValue(recorded());
  // THE PICKER READS THE PET NOW, so every test that renders it reaches this
  // mock — not only the two forms that ask for registries or a species. Before
  // this default the read resolved to `undefined` and the hook threw on
  // `.outcome`, which surfaced as two unrelated tests failing on a screen that
  // was fine.
  //
  // A PROMISE THAT NEVER LANDS, deliberately, and not a resolved failure. It
  // holds `facts` at `null` — the fourth state — so the picker draws exactly
  // the ten fixed rows and NOTHING updates state after the assertion. A
  // resolved default would settle mid-test and make every picker test carry an
  // `act` it has no reason to know about. The tests that are ABOUT the
  // conditional rows set their own read.
  mockFetchOwnerPetDetail.mockReset();
  mockFetchOwnerPetDetail.mockReturnValue(new Promise(() => {}));
});

describe("RecordEventScreen — the picker's conditional rows", () => {
  /**
   * A COMPLETE pet-detail payload, and complete on purpose.
   *
   * The fixture further down deliberately carries only the two sections the
   * FORMS read, and its own header explains why a partial one is a trap: a
   * payload missing a section the contract guarantees does not test a degraded
   * server, it tests a shape that cannot exist. The picker reads `identity` AND
   * `status`, so this one carries both — and `status` is where the honest
   * distinction lives between "no follow-up open" and "I could not find out".
   */
  function petDetail(o: {
    sex?: string | null;
    species?: string | null;
    pregnancyStatus?: string | null;
    statusDegraded?: boolean;
    /** The check-in section — its own read, so it degrades on its own. */
    checkinPending?: boolean;
    checkinDegraded?: boolean;
  }) {
    return {
      outcome: "ok",
      payload: {
        identity: { status: "ok", data: { sex: o.sex ?? "female", species: o.species ?? "dog" } },
        status: o.statusDegraded
          ? { status: "unavailable" }
          : { status: "ok", data: { pregnancyStatus: o.pregnancyStatus ?? null } },
        pppRegistries: { status: "ok", data: null },
        postAdoptionCheckin: o.checkinDegraded
          ? { status: "unavailable" }
          : { status: "ok", data: { pending: o.checkinPending ?? false } },
      },
    };
  }

  it("draws NO pregnancy row until the read lands", () => {
    // The default mock never resolves. Ten fixed rows and nothing else — a row
    // that appears late is fine, a row that vanishes under a thumb is not.
    render(<RecordEventScreen publicToken={TOKEN} />);
    expect(screen.queryByText(kindTitle("pregnancy_start"))).toBeNull();
    expect(screen.queryByText(kindTitle("pregnancy_end"))).toBeNull();
    expect(screen.queryByText(kindTitle("post_adoption_checkin"))).toBeNull();
    // NON-VACUITY: the fixed rows ARE there, so the absence above is the
    // condition and not a screen that failed to render.
    expect(screen.getByText(kindTitle("weight"))).toBeOnTheScreen();
  });

  it("adds the START row for a female with no follow-up open", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue(petDetail({ pregnancyStatus: null }));
    render(<RecordEventScreen publicToken={TOKEN} />);
    expect(await screen.findByText(kindTitle("pregnancy_start"))).toBeOnTheScreen();
    expect(screen.queryByText(kindTitle("pregnancy_end"))).toBeNull();
  });

  it("swaps to the END row while a pregnancy is in follow-up", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue(petDetail({ pregnancyStatus: "in_progress" }));
    render(<RecordEventScreen publicToken={TOKEN} />);
    expect(await screen.findByText(kindTitle("pregnancy_end"))).toBeOnTheScreen();
    expect(screen.queryByText(kindTitle("pregnancy_start"))).toBeNull();
  });

  it("adds NEITHER row for a male", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue(petDetail({ sex: "male" }));
    render(<RecordEventScreen publicToken={TOKEN} />);
    // The read has to LAND before the absence means anything, and it has no
    // visible effect here — so wait on the call rather than on a row.
    await waitFor(() => expect(mockFetchOwnerPetDetail).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(kindTitle("pregnancy_start"))).toBeNull();
    expect(screen.queryByText(kindTitle("pregnancy_end"))).toBeNull();
  });

  it("offers BOTH rows when the read failed outright", async () => {
    // Hiding a capability because a read failed is a dead end nobody can see.
    mockFetchOwnerPetDetail.mockResolvedValue({ outcome: "unreachable" });
    render(<RecordEventScreen publicToken={TOKEN} />);
    expect(await screen.findByText(kindTitle("pregnancy_start"))).toBeOnTheScreen();
    expect(screen.getByText(kindTitle("pregnancy_end"))).toBeOnTheScreen();
    // And the check-in row, for the same reason: the read knows nothing about
    // the window either.
    expect(screen.getByText(kindTitle("post_adoption_checkin"))).toBeOnTheScreen();
  });

  it("adds the CHECK-IN row while the refugio has a window open", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue(petDetail({ checkinPending: true }));
    render(<RecordEventScreen publicToken={TOKEN} />);
    expect(await screen.findByText(kindTitle("post_adoption_checkin"))).toBeOnTheScreen();
  });

  it("draws NO check-in row when nothing is pending", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue(petDetail({ checkinPending: false }));
    render(<RecordEventScreen publicToken={TOKEN} />);
    // The read has to LAND before the absence means anything — and this fixture
    // grows a pregnancy row when it does, so wait on that rather than on time.
    expect(await screen.findByText(kindTitle("pregnancy_start"))).toBeOnTheScreen();
    expect(screen.queryByText(kindTitle("post_adoption_checkin"))).toBeNull();
  });

  it("offers the check-in row when ITS section is degraded, even though the rest of the read is fine", async () => {
    // The section has its own budget and its own `unavailable`. A face whose
    // status section answered "no follow-up open" and whose window read timed
    // out must still offer the check-in: hiding it would turn a 2-second
    // hiccup on one lookup into a capability that vanished with no sentence.
    mockFetchOwnerPetDetail.mockResolvedValue(petDetail({ checkinDegraded: true }));
    render(<RecordEventScreen publicToken={TOKEN} />);
    expect(await screen.findByText(kindTitle("post_adoption_checkin"))).toBeOnTheScreen();
    // NON-VACUITY: the pregnancy rows followed THEIR facts (never pregnant →
    // start only), so the row above is the section's own state and not a
    // whole-read failure that offered everything.
    expect(screen.getByText(kindTitle("pregnancy_start"))).toBeOnTheScreen();
    expect(screen.queryByText(kindTitle("pregnancy_end"))).toBeNull();
  });

  it("opens the check-in form when its row is tapped — the web's own question, the web's own verb", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue(petDetail({ checkinPending: true }));
    render(<RecordEventScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText(kindTitle("post_adoption_checkin")));
    expect(screen.getByText("¿Cómo está?")).toBeOnTheScreen();
    expect(screen.getByText("Enviar el check-in")).toBeOnTheScreen();
  });

  it("offers BOTH rows when the read answered but the status section is degraded", async () => {
    // THE CASE A `pregnancyStatus: null` FIELD ALONE CANNOT EXPRESS. A degraded
    // section and an animal that was never pregnant would both read as null;
    // only the section's own status separates them, and they must diverge —
    // unknown offers both halves, never-pregnant offers only the start.
    mockFetchOwnerPetDetail.mockResolvedValue(petDetail({ statusDegraded: true }));
    render(<RecordEventScreen publicToken={TOKEN} />);
    expect(await screen.findByText(kindTitle("pregnancy_end"))).toBeOnTheScreen();
    expect(screen.getByText(kindTitle("pregnancy_start"))).toBeOnTheScreen();
  });

  it("opens the pregnancy form when its row is tapped", async () => {
    mockFetchOwnerPetDetail.mockResolvedValue(petDetail({ pregnancyStatus: "in_progress" }));
    render(<RecordEventScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText(kindTitle("pregnancy_end")));
    // The outcome chips are the form's own first question — a row that opened
    // the wrong form would show the picker's list again.
    expect(screen.getByText("¿Cómo terminó?")).toBeOnTheScreen();
    expect(screen.getByText("Nacieron con vida")).toBeOnTheScreen();
  });
});

describe("RecordEventScreen — the picker", () => {
  it("offers EVERY pickable kind, and says where the one that is not lives", () => {
    // DRIVEN OFF `RECORD_KINDS`, not off a list written here. The hand-written
    // list this replaced said "the nine kinds" and would have kept passing with
    // a tenth in the picker and no test touching it — which is precisely the
    // failure mode a render test exists to catch.
    render(<RecordEventScreen publicToken={TOKEN} />);
    for (const kind of RECORD_KINDS) {
      expect(screen.getByText(kindTitle(kind))).toBeOnTheScreen();
    }
    // Ending a treatment needs the asiento it ends, so it is NOT a choice here
    // — and the screen says so rather than leaving a gap a person hunts for.
    expect(screen.getByText("Terminar una medicación")).toBeOnTheScreen();
    // THE CAPTION IS THE HALF THAT ANSWERS "then where?". The row without it
    // is a dead control with no reason, so the label alone is not the
    // assertion. Reached by text and not by `getByRole("button", { name })`:
    // with no accessibilityLabel that name is derived from concatenated child
    // text, which would make this pass on the label alone.
    expect(
      screen.getByText(
        'Se hace desde el asiento del inicio del tratamiento, en la libreta: "Terminar medicación".',
      ),
    ).toBeOnTheScreen();
  });

  it("opens the form for the kind that was pressed", () => {
    render(<RecordEventScreen publicToken={TOKEN} />);
    fireEvent.press(screen.getByText("Peso"));
    expect(screen.getByLabelText("Peso (kg), obligatorio")).toBeOnTheScreen();
    expect(submitControl()).toBeOnTheScreen();
  });
});

describe("RecordEventScreen — the discard guard (A2-alta-asentar-08)", () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});

  beforeEach(() => {
    alert.mockClear();
    mockNav.reset();
  });

  it("does NOT ask anything of somebody who typed nothing", () => {
    // THE CASE THAT KEPT THIS GUARD OFF EIGHT SCREENS. `draft !== emptyDraft()`
    // is true on mount — two different objects — so a naive predicate would
    // interrupt everyone who opened the form and read the first field, and a
    // guard people learn to dismiss is not there on the day it matters.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    expect(mockNav.pressBack().blocked).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("asks before the back gesture discards a filled-in form", () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "12,5");

    expect(mockNav.pressBack().blocked).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    // THE WORDS CHANGED WITH THE BEHAVIOUR (2026-09-17). It used to say "¿Salir
    // sin guardar? Lo que escribiste hasta acá se pierde", which stopped being
    // true the day this screen started keeping the draft — and a confirm that
    // overstates what it is about is how people learn to dismiss confirms. The
    // other ten writer screens keep the old sentence because on them it is
    // still true. See `DISCARD_COPY.asiento`.
    expect(alert.mock.calls[0]?.[0]).toBe("¿Salir de este asiento?");
    expect(String(alert.mock.calls[0]?.[1])).toContain("Todavía no se registró nada");
  });

  it("asks before 'Elegir otro tipo' remounts the form under it", () => {
    // A DISCARD THE NAVIGATOR CANNOT SEE: the screen stays and the form is
    // remounted under a new `key`, taking every field with it. `beforeRemove`
    // never fires, so nothing in the guard covers this on its own.
    render(<RecordEventScreen publicToken={TOKEN} />);
    fireEvent.press(screen.getByText("Peso"));
    fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "12,5");
    fireEvent.press(screen.getByText("Elegir otro tipo"));

    expect(alert).toHaveBeenCalledTimes(1);
    // It asked and did NOT go back on its own — the form is still there.
    expect(screen.getByLabelText("Peso (kg), obligatorio")).toBeOnTheScreen();
  });

  it("lets 'Elegir otro tipo' through untouched when nothing was typed", () => {
    render(<RecordEventScreen publicToken={TOKEN} />);
    fireEvent.press(screen.getByText("Peso"));
    fireEvent.press(screen.getByText("Elegir otro tipo"));

    expect(alert).not.toHaveBeenCalled();
    expect(screen.getByText("¿Qué querés registrar?")).toBeOnTheScreen();
  });

  it("does NOT ask once the asiento is on the server", async () => {
    // The guard fires on every navigation away, including the one this screen
    // makes itself. Two screens shipped without `allowLeave` in the batch before
    // this one and asked "¿Salir sin guardar?" about a write that had landed.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "12,5");
    fireEvent.press(submitControl());
    await waitFor(() => expect(screen.getByText("Volver a la libreta")).toBeOnTheScreen());

    expect(mockNav.pressBack().blocked).toBe(false);
    fireEvent.press(screen.getByText("Volver a la libreta"));
    expect(alert).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalled();
  });
});

describe("RecordEventScreen — the CTA names what it writes (A2-alta-asentar-R05)", () => {
  // THE LITERALS LIVE HERE and nowhere else in this file. AGENTS.md's four-verb
  // rule forbids a bare CTA by name ("Never bare ('Aceptar', 'Guardar',
  // 'Publicar' on its own)") and this screen said "Guardar" for all eleven
  // forms while the web said "Registrar vacuna" for the same act.
  it("says 'Registrar vacuna' on a vaccination", () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="vaccination" />);
    expect(screen.getByText("Registrar vacuna")).toBeOnTheScreen();
    expect(screen.queryByText("Guardar")).toBeNull();
  });

  it("says 'Registrar peso' on a weight", () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    expect(screen.getByText("Registrar peso")).toBeOnTheScreen();
  });

  it("CONFIRMS a closure rather than registering an end", () => {
    // The rule names this exact case: "Closing a treatment is `Confirmar
    // cierre`, not `Registrar fin`." A screen that folded every kind into one
    // "Registrar X" would read as correct and break that reservation.
    render(
      <RecordEventScreen publicToken={TOKEN} initialKind="medication_end" sourceEventId="evt-1" />,
    );
    expect(screen.getByText("Confirmar cierre de medicación")).toBeOnTheScreen();
    expect(screen.queryByText(/Registrar fin/)).toBeNull();
  });

  it("does not call a note an observable event", () => {
    // `Registrar X` is reserved for logging something observed. A note is
    // neither observed nor confirmed, so it takes the fourth shape — a verb
    // WITH its object, which is what keeps it out of the banned bare "Guardar".
    render(<RecordEventScreen publicToken={TOKEN} initialKind="note" />);
    expect(screen.getByText("Guardar la nota")).toBeOnTheScreen();
    expect(screen.queryByText("Guardar")).toBeNull();
    expect(screen.queryByText("Registrar nota")).toBeNull();
  });
});

describe("RecordEventScreen — a bite victim's contact is not the keyboard's to keep", () => {
  it("opts the victim's name and phone out of keyboard learning and autofill", () => {
    // The name and phone belong to a THIRD party — the person bitten — who
    // never agreed to be on this phone. Autocorrect dictionaries and autofill
    // suggestions would keep them long after the draft is swept. The phone
    // keeps its telephone keypad.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="bite" />);

    for (const label of ["Nombre de quien fue mordido", "Teléfono de contacto"]) {
      expect(screen.getByLabelText(label).props).toMatchObject({
        autoCorrect: false,
        autoComplete: "off",
        importantForAutofill: "no",
        textContentType: "none",
      });
    }
    expect(screen.getByLabelText("Teléfono de contacto").props.inputMode).toBe("tel");
  });
});

describe("RecordEventScreen — a weight, end to end", () => {
  it("sends what was typed, with the key, and reports success", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);

    fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "12,5");
    fireEvent.changeText(screen.getByLabelText("Fecha, obligatorio"), "20/08/2026");
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    // The comma a person types on an es-AR keyboard is a decimal point.
    expect(sentBody()).toMatchObject({ kind: "weight", kg: 12.5, occurredAt: "2026-08-20" });
    expect(sentKey()).toMatch(/^[0-9a-f-]{36}$/);

    expect(await screen.findByText("Asiento registrado.")).toBeOnTheScreen();
  });

  it("returns to the LIBRETA face, not to the front of the document", async () => {
    // D3 (native QA batch 1). "Volver a la libreta" used to call
    // `credentialRoute(token)`, which opens `PetDocumentScreen` on its default
    // face — so the person who had just written an asiento landed on the
    // CREDENTIAL side of the card and had to find the turn button to see what
    // they had done. The label promised the back; the navigation delivered the
    // front.
    //
    // The literal is spelled out rather than built with `credentialRoute`: a
    // test that re-derives its expected value from the function under test
    // agrees with a broken one.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "12");
    fireEvent.press(submitControl());

    fireEvent.press(await screen.findByText("Volver a la libreta"));
    expect(mockReplace).toHaveBeenCalledWith(`/mascotas/${TOKEN}?face=libreta`);
  });

  it("says a REPLAY was a replay, instead of claiming a second asiento", async () => {
    mockRecordPetEvent.mockResolvedValue(recorded(true));
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "12");
    fireEvent.press(submitControl());
    expect(await screen.findByText(/no se duplicó/i)).toBeOnTheScreen();
  });

  it("refuses a weight over the ceiling WITHOUT calling the server", async () => {
    // The contract's schema runs on this side first, which is the whole point of
    // shipping it to the client: the person gets the sentence immediately and
    // the network never sees a body that could not have been accepted.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "500");
    fireEvent.press(submitControl());

    expect(await screen.findByText("El peso no puede superar los 120 kg.")).toBeOnTheScreen();
    expect(mockRecordPetEvent).not.toHaveBeenCalled();
  });
});

describe("RecordEventScreen — the refusals a person sees", () => {
  it("renders a server refusal in the person's own words", async () => {
    mockRecordPetEvent.mockResolvedValue({ outcome: "api-error", code: "event_date_future" });
    render(<RecordEventScreen publicToken={TOKEN} initialKind="note" />);
    fireEvent.changeText(screen.getByLabelText("Nota, obligatorio"), "Comió bien.");
    fireEvent.press(submitControl());

    expect(await screen.findByText("La fecha no puede ser futura.")).toBeOnTheScreen();
    // A refused write leaves the form standing, with what was typed still in it.
    expect(submitControl()).toBeOnTheScreen();
  });

  it("renders a transport failure as a transport failure, not as a refusal", async () => {
    mockRecordPetEvent.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<RecordEventScreen publicToken={TOKEN} initialKind="note" />);
    fireEvent.changeText(screen.getByLabelText("Nota, obligatorio"), "Comió bien.");
    fireEvent.press(submitControl());
    expect(await screen.findByText(/Revisá tu conexión/)).toBeOnTheScreen();
  });

  it("turns the same-day gate into a QUESTION, and resends on the SAME key", async () => {
    // It is a soft gate: nothing was written, so the retry is the same attempt
    // and must carry the same key. A fresh key here would be the app opting out
    // of the protection the header exists for.
    mockRecordPetEvent.mockResolvedValueOnce({
      outcome: "api-error",
      code: "same_day_duplicate_suspected",
    });
    render(<RecordEventScreen publicToken={TOKEN} initialKind="vaccination" />);
    fireEvent.changeText(screen.getByLabelText("Vacuna, obligatorio"), "Antirrábica");
    fireEvent.press(submitControl());

    const confirm = await screen.findByText("Sí, registrar igual");
    expect(screen.getByText(/¿Querés registrar otro\?/)).toBeOnTheScreen();

    fireEvent.press(confirm);
    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(2));
    expect(sentKey(0)).toBe(sentKey(1));
    // The second body carries the override; the first did not.
    expect(sentBody()).toMatchObject({ sameDayOverride: false });
    expect((mockRecordPetEvent.mock.calls[1] as unknown[])[2]).toMatchObject({
      sameDayOverride: true,
    });
  });
});

describe("RecordEventScreen — medicación", () => {
  it("shows the interval field only for a custom frequency", () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="medication_start" />);
    expect(screen.queryByLabelText("Cada cuántas horas, obligatorio")).toBeNull();
    fireEvent.press(screen.getByText("Personalizada"));
    expect(screen.getByLabelText("Cada cuántas horas, obligatorio")).toBeOnTheScreen();
  });

  it("joins the day and the hour into the one string the contract describes", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="medication_start" />);
    fireEvent.changeText(screen.getByLabelText("Medicamento, obligatorio"), "Amoxicilina");
    fireEvent.changeText(screen.getByLabelText("Dosis, obligatorio"), "250 mg");
    fireEvent.changeText(screen.getByLabelText("Fecha de inicio, obligatorio"), "20/08/2026");
    fireEvent.changeText(screen.getByLabelText("Primera dosis — día, obligatorio"), "20/08/2026");
    fireEvent.changeText(screen.getByLabelText("Primera dosis — hora, obligatorio"), "08:00");
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({ firstDoseAt: "2026-08-20T08:00" });
  });

  it("carries the source asiento when it was opened from one", async () => {
    render(
      <RecordEventScreen
        publicToken={TOKEN}
        initialKind="medication_end"
        sourceEventId={EVENT_ID}
      />,
    );
    fireEvent.changeText(screen.getByLabelText("Fecha de fin, obligatorio"), "20/08/2026");
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({
      kind: "medication_end",
      medicationStartedEventId: EVENT_ID,
    });
    // Opened FOR one kind, so there is nothing to go back to inside the screen.
    expect(screen.queryByText("Elegir otro tipo")).toBeNull();
  });

  it("says so, instead of sending, when it was opened without the asiento it ends", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="medication_end" />);
    fireEvent.press(submitControl());
    expect(await screen.findByText(/Abrila desde su asiento/)).toBeOnTheScreen();
    expect(mockRecordPetEvent).not.toHaveBeenCalled();
  });
});

describe("RecordEventScreen — the idempotency key", () => {
  it("keeps ONE key across every retry of one form", async () => {
    mockRecordPetEvent.mockResolvedValueOnce({ outcome: "api-error", code: "event_failed" });
    render(<RecordEventScreen publicToken={TOKEN} initialKind="note" />);
    fireEvent.changeText(screen.getByLabelText("Nota, obligatorio"), "Comió bien.");

    fireEvent.press(submitControl());
    await screen.findByText(/No pudimos guardar el registro/);
    fireEvent.press(submitControl());
    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(2));

    // THE POINT OF THE HEADER. If the first attempt had in fact committed before
    // the failure was reported, this retry resolves to it instead of writing a
    // second asiento onto an append-only spine.
    expect(sentKey(0)).toBe(sentKey(1));
  });

  it("gives a DIFFERENT key to a different kind, because it is a different act", async () => {
    render(<RecordEventScreen publicToken={TOKEN} />);

    fireEvent.press(screen.getByText("Nota"));
    fireEvent.changeText(screen.getByLabelText("Nota, obligatorio"), "Comió bien.");
    fireEvent.press(submitControl());
    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    const noteKey = sentKey(0);

    // Back to the picker via the finished screen is not reachable, so this
    // exercises the remount directly: a second mount is a second attempt.
    screen.unmount();
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "12");
    fireEvent.press(submitControl());
    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(2));

    expect(sentKey(1)).not.toBe(noteKey);
  });
});

// ---------------------------------------------------------------------------
// WU-L — the four newest forms. One render test per kind, because a `switch`
// arm that returned the wrong fields would still compile and still submit.
// ---------------------------------------------------------------------------

describe("RecordEventScreen — visita veterinaria", () => {
  it("sends the motivo as the wire's `reason`, and the diagnosis as free text", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="vet_visit" />);

    fireEvent.changeText(
      screen.getByLabelText("Motivo de la visita, obligatorio"),
      "Control anual",
    );
    fireEvent.changeText(screen.getByLabelText("Fecha, obligatorio"), "20/08/2026");
    fireEvent.changeText(screen.getByLabelText("Diagnóstico"), "Otitis externa");
    fireEvent.changeText(screen.getByLabelText("Veterinario/a"), "Dra. Sosa");
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({
      kind: "vet_visit",
      reason: "Control anual",
      occurredAt: "2026-08-20",
      diagnosis: "Otitis externa",
      vetName: "Dra. Sosa",
      // Untouched: null on the wire, not "".
      clinic: null,
      notes: null,
    });
  });

  it("shows the refusal when the motivo is missing, and sends nothing", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="vet_visit" />);
    fireEvent.press(submitControl());

    await waitFor(() =>
      expect(screen.getByText("Falta el motivo de la visita.")).toBeOnTheScreen(),
    );
    expect(mockRecordPetEvent).not.toHaveBeenCalled();
  });
});

describe("RecordEventScreen — información clínica", () => {
  it("sends the chosen sub-kind and the title", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="clinical_info" />);

    fireEvent.press(screen.getByText("Imágenes"));
    fireEvent.changeText(
      screen.getByLabelText("Estudio o procedimiento, obligatorio"),
      "Radiografía de tórax",
    );
    fireEvent.changeText(screen.getByLabelText("Fecha, obligatorio"), "20/08/2026");
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({
      kind: "clinical_info",
      subKind: "imaging",
      title: "Radiografía de tórax",
      occurredAt: "2026-08-20",
    });
  });

  it("offers the five owner sub-kinds and NEVER the vet-only one", () => {
    // `disease_diagnosis` is a real `clinical_info_logged` sub_kind whose writer
    // authorizes on a verified matrícula and checks no ownership at all. It is
    // absent from the contract's enum, so it cannot be rendered here — this
    // asserts the consequence a reader would otherwise have to take on faith.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="clinical_info" />);
    for (const label of ["Análisis", "Imágenes", "Cirugía", "Alergia", "Otro"]) {
      expect(screen.getByText(label)).toBeOnTheScreen();
    }
    expect(screen.queryByText("Diagnóstico de enfermedad")).toBeNull();
  });

  it("defaults to Análisis rather than to nothing, and the chip says so", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="clinical_info" />);
    fireEvent.changeText(
      screen.getByLabelText("Estudio o procedimiento, obligatorio"),
      "Hemograma",
    );
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({ subKind: "lab_work" });
  });
});

describe("RecordEventScreen — esterilización", () => {
  it("sends the chosen procedure", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="sterilization" />);

    fireEvent.press(screen.getByText("Ovariectomía"));
    fireEvent.changeText(screen.getByLabelText("Fecha de la cirugía, obligatorio"), "20/08/2026");
    fireEvent.changeText(screen.getByLabelText("Clínica"), "Veterinaria del Parque");
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({
      kind: "sterilization",
      procedure: "spay",
      occurredAt: "2026-08-20",
      clinic: "Veterinaria del Parque",
      performedBy: null,
    });
  });
});

describe("RecordEventScreen — microchip", () => {
  it("sends the chip number and the implant date", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="microchip" />);

    fireEvent.changeText(
      screen.getByLabelText("Número de microchip, obligatorio"),
      "982000123456789",
    );
    fireEvent.changeText(screen.getByLabelText("Fecha de implantación, obligatorio"), "20/08/2026");
    fireEvent.changeText(screen.getByLabelText("Zona del cuerpo"), "Cuello, lado izquierdo");
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({
      kind: "microchip",
      chipNumber: "982000123456789",
      occurredAt: "2026-08-20",
      locationOnBody: "Cuello, lado izquierdo",
      countryCode: null,
      implantedBy: null,
    });
  });

  it("shows the refusal when the number is missing, and sends nothing", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="microchip" />);
    fireEvent.press(submitControl());

    await waitFor(() =>
      expect(screen.getByText("Falta el número de microchip.")).toBeOnTheScreen(),
    );
    expect(mockRecordPetEvent).not.toHaveBeenCalled();
  });

  it("shows the immutability note on EVERY form, before the button", () => {
    // A person about to write into a national registry should read it while
    // they can still stop — and a new `switch` arm is exactly where it would
    // have been forgotten, which is why this walks the union rather than the
    // four kinds it originally listed.
    for (const kind of [...RECORD_KINDS, "medication_end" as const]) {
      const view = render(<RecordEventScreen publicToken={TOKEN} initialKind={kind} />);
      expect(screen.getByText(/no se editan ni se borran/i)).toBeOnTheScreen();
      view.unmount();
    }
  });

  it("chains the return key across every kind — one 'done', and it is the LAST field", () => {
    // forms-F6: the return key was a dead key on this form, so a person closed
    // and reopened the keyboard between six fields.
    //
    // THIS ALSO AUDITS `chainLength`, which is a hand-written count per kind
    // and the one thing about the chain that can silently drift: a count one
    // too low puts "done" on a middle field and orphans the last one; one too
    // high leaves no "done" at all. Both are invisible on a screenshot.
    for (const kind of [...RECORD_KINDS, "medication_end" as const]) {
      const view = render(<RecordEventScreen publicToken={TOKEN} initialKind={kind} />);
      const chained = screen
        .UNSAFE_getAllByType(TextInput)
        .filter((input) => input.props.returnKeyType !== undefined);

      expect(chained.length).toBeGreaterThan(0);
      const keys = chained.map((input) => input.props.returnKeyType);
      const expected = keys.map((_, index) => (index === keys.length - 1 ? "done" : "next"));
      expect({ kind, keys }).toEqual({ kind, keys: expected });
      view.unmount();
    }
  });
});

describe("RecordEventScreen — síntoma", () => {
  it("warns about the sanitary authority BEFORE the form, not after the write", () => {
    // The one asiento here whose write can leave the animal's own record. The
    // subtitle is on screen from the moment the form opens, which is while the
    // person can still decide not to send it.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="symptom" />);
    expect(screen.getByText(/autoridad sanitaria/i)).toBeOnTheScreen();
    expect(screen.getByText(/no se editan ni se borran/i)).toBeOnTheScreen();
  });

  it("offers NO date field a person must fill, unlike every other kind", () => {
    // Síntoma's onset is optional and blank; the form asks "desde cuándo (si
    // sabés)". A required date here would collect a guess.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="symptom" />);
    expect(screen.queryByLabelText("Fecha, obligatorio")).toBeNull();
    expect(screen.getByLabelText("Desde cuándo (si sabés)")).toBeOnTheScreen();
  });

  it("sends the free text alone when that is all the person knows", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="symptom" />);
    fireEvent.changeText(
      screen.getByLabelText("Qué le viste, obligatorio"),
      "Decaído, no come desde ayer",
    );
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({
      kind: "symptom",
      freeText: "Decaído, no come desde ayer",
      severity: null,
      onsetAt: null,
    });
    // NO `occurredAt`, even though `emptyDraft` pre-fills one for the other ten.
    expect(sentBody()).not.toHaveProperty("occurredAt");
    expect(sentKey()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("carries the severity and the onset when the person did know them", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="symptom" />);
    fireEvent.changeText(screen.getByLabelText("Qué le viste, obligatorio"), "Vómitos");
    fireEvent.press(screen.getByText("Grave"));
    fireEvent.changeText(screen.getByLabelText("Desde cuándo (si sabés)"), "20/08/2026");
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({ severity: "severe", onsetAt: "2026-08-20" });
  });

  it("lets a severity be UNPICKED, because the web's select starts blank", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="symptom" />);
    fireEvent.changeText(screen.getByLabelText("Qué le viste, obligatorio"), "Tos");
    fireEvent.press(screen.getByText("Leve"));
    fireEvent.press(screen.getByText("Leve"));
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({ severity: null });
  });

  it("refuses an empty description WITHOUT calling the server", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="symptom" />);
    fireEvent.press(submitControl());

    expect(await screen.findByText("Contá qué le viste.")).toBeOnTheScreen();
    expect(mockRecordPetEvent).not.toHaveBeenCalled();
  });

  it("is reachable from the picker, in the place the day happens in", () => {
    render(<RecordEventScreen publicToken={TOKEN} />);
    fireEvent.press(screen.getByText("Síntoma"));
    expect(screen.getByLabelText("Qué le viste, obligatorio")).toBeOnTheScreen();
  });
});

describe("RecordEventScreen — check-in post-adopción, the eighteenth and last", () => {
  it("says who reads it and what it lacks BEFORE the form is filled", () => {
    // Addressed to the refugio, sent without a date, and no photo on this
    // release — three things a person is entitled to know while they can
    // still decide, and the third is the one that would otherwise read as a
    // broken form to somebody who used the web's.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="post_adoption_checkin" />);
    expect(screen.getByText(/refugio que pidió el seguimiento/i)).toBeOnTheScreen();
    expect(screen.getByText(/foto, por ahora se hace desde la web/i)).toBeOnTheScreen();
    expect(screen.getByText(/no se editan ni se borran/i)).toBeOnTheScreen();
  });

  it("sends the text alone — no date, no refugio, no attachment", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="post_adoption_checkin" />);
    fireEvent.changeText(screen.getByLabelText("¿Cómo está?"), "Come bien y ya duerme en su cama.");
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({
      kind: "post_adoption_checkin",
      notes: "Come bien y ya duerme en su cama.",
    });
    // NO `occurredAt`, even though `emptyDraft` pre-fills one: the server
    // stamps the moment of reporting, as the web action does.
    expect(sentBody()).not.toHaveProperty("occurredAt");
    expect(sentKey()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sends with nothing typed — 'estamos bien' is a real check-in, as on the web", async () => {
    // The web form has no required field; a client-side refusal here would be
    // this app inventing a rule the contract does not have.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="post_adoption_checkin" />);
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ kind: "post_adoption_checkin", notes: null });
  });

  it("shows the server's own reason when the window closed under the person", async () => {
    // The refusal the three-state menu exists to reach: offered on a degraded
    // read, refused by the server, and the sentence names the real reason
    // rather than a generic failure.
    mockRecordPetEvent.mockResolvedValue({ outcome: "api-error", code: "checkin_no_open_window" });
    render(<RecordEventScreen publicToken={TOKEN} initialKind="post_adoption_checkin" />);
    fireEvent.press(submitControl());

    expect(
      await screen.findByText(/no tiene un check-in post-adopción pendiente/i),
    ).toBeOnTheScreen();
  });
});

describe("atestación PPP — the registry list is the jurisdiction's, and it degrades to the nation's", () => {
  /**
   * The pet-detail payload, cut down to the two sections these forms read.
   *
   * `identity` IS NOT OPTIONAL HERE even though only the death form reads it:
   * one hook serves both kinds off one request, so a fixture missing a section
   * the contract guarantees does not test a degraded server — it tests a
   * payload that cannot exist, and the throw it produces looks like a screen
   * bug. Caught the day the death form started reading the species.
   */
  function detail(section: unknown, species: string | null = "dog") {
    return {
      outcome: "ok",
      payload: {
        identity: { status: "ok", data: { species } },
        pppRegistries: section,
      },
    };
  }

  beforeEach(() => {
    mockFetchOwnerPetDetail.mockReset();
    mockRecordPetEvent.mockReset();
    // The append succeeds unless a case says otherwise — these cases are about
    // WHICH registry leaves the device, not about how a refusal renders.
    mockRecordPetEvent.mockResolvedValue(recorded());
  });

  it("offers the two national registries plus Otro registro before any read answers", async () => {
    // THE FORM IS CORRECT WITHOUT THE READ, which is the whole reason it does
    // not block on one. A pending promise is the state a person sees first, and
    // on a slow connection it is the state they fill the form in.
    mockFetchOwnerPetDetail.mockReturnValue(new Promise(() => {}));
    render(<RecordEventScreen publicToken={TOKEN} initialKind="dangerous_breed_attestation" />);

    expect(screen.getByText("CABA · Ley 4078")).toBeTruthy();
    expect(screen.getByText("Prov. Bs. As. · Ley 14.107")).toBeTruthy();
    expect(screen.getByText("Otro registro")).toBeTruthy();
  });

  it("replaces them with the jurisdiction's own list, and KEEPS Otro registro", async () => {
    // `buildRegistryOptions` appends "Otro registro" unconditionally on the web
    // and the server accepts it unconditionally; a jurisdiction naming its own
    // registries must not take that answer away from an owner registered in a
    // third province.
    mockFetchOwnerPetDetail.mockResolvedValue(
      detail({
        status: "ok",
        data: [{ id: "prov_neuquen", label: "Neuquén · Registro provincial", required: true }],
      }),
    );
    render(<RecordEventScreen publicToken={TOKEN} initialKind="dangerous_breed_attestation" />);

    await waitFor(() => expect(screen.getByText("Neuquén · Registro provincial")).toBeTruthy());
    expect(screen.getByText("Otro registro")).toBeTruthy();
    // NON-VACUITY: the national fallback is GONE, not merely joined.
    expect(screen.queryByText("CABA · Ley 4078")).toBeNull();
  });

  it("keeps the national list when the section says the read did not answer", async () => {
    // `unavailable` is not "this jurisdiction names none". Printing an empty
    // list over a read that failed would leave the person with no answer at all.
    mockFetchOwnerPetDetail.mockResolvedValue(detail({ status: "unavailable" }));
    render(<RecordEventScreen publicToken={TOKEN} initialKind="dangerous_breed_attestation" />);

    await waitFor(() => expect(mockFetchOwnerPetDetail).toHaveBeenCalledTimes(1));
    expect(screen.getByText("CABA · Ley 4078")).toBeTruthy();
  });

  it("DROPS a registry chosen from the fallback when the jurisdiction's list arrives without it", async () => {
    // THE DEFECT THIS RECONCILIATION EXISTS FOR, and it only bites on a slow
    // link. The fallback chips render, the person picks one and keeps filling
    // the form, and THEN the jurisdiction's own list replaces the options. The
    // chip row loses its highlight — scrolled out of view by now — while the
    // draft still holds `caba_4078`, so the form's own validation passes and
    // the refusal arrives from the SERVER, about a value the app itself
    // offered. Clearing it makes the draft agree with the screen, and the next
    // submit is refused HERE, in the place the person can act on it.
    let resolveDetail: (value: unknown) => void = () => {};
    mockFetchOwnerPetDetail.mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );
    render(<RecordEventScreen publicToken={TOKEN} initialKind="dangerous_breed_attestation" />);

    fireEvent.press(screen.getByText("CABA · Ley 4078"));

    await act(async () => {
      resolveDetail(
        detail({
          status: "ok",
          data: [{ id: "prov_neuquen", label: "Neuquén · Registro provincial", required: true }],
        }),
      );
    });

    await waitFor(() => expect(screen.getByText("Neuquén · Registro provincial")).toBeTruthy());
    expect(screen.queryByText("CABA · Ley 4078")).toBeNull();

    fireEvent.press(submitControl());

    // THE TWO HALVES THAT MATTER: the person is told what to do, and nothing
    // left the device carrying the id the server would have refused.
    await waitFor(() =>
      expect(screen.getByText("Elegí el registro donde hiciste la atestación.")).toBeTruthy(),
    );
    expect(mockRecordPetEvent).not.toHaveBeenCalled();
  });

  it("KEEPS a registry the jurisdiction's list still offers", async () => {
    // NON-VACUITY. A reconciliation that cleared the field on every list swap
    // would pass the case above and quietly throw away a valid answer. "Otro
    // registro" survives every list, which makes it the honest probe.
    let resolveDetail: (value: unknown) => void = () => {};
    mockFetchOwnerPetDetail.mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );
    render(<RecordEventScreen publicToken={TOKEN} initialKind="dangerous_breed_attestation" />);

    fireEvent.press(screen.getByText("Otro registro"));

    await act(async () => {
      resolveDetail(
        detail({
          status: "ok",
          data: [{ id: "prov_neuquen", label: "Neuquén · Registro provincial", required: true }],
        }),
      );
    });

    await waitFor(() => expect(screen.getByText("Neuquén · Registro provincial")).toBeTruthy());
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({ kind: "dangerous_breed_attestation", registry: "other" });
  });

  it("does NOT read the pet detail for a form with no registry field", async () => {
    // Every other kind would be paying for a pet-detail round trip it has no
    // field for.
    mockFetchOwnerPetDetail.mockResolvedValue(detail({ status: "ok", data: null }));
    render(<RecordEventScreen publicToken={TOKEN} initialKind="note" />);

    expect(mockFetchOwnerPetDetail).not.toHaveBeenCalled();
  });
});

describe("fallecimiento — el asiento que cierra el registro", () => {
  function detail(species: string | null = "dog") {
    return {
      outcome: "ok",
      payload: {
        identity: { status: "ok", data: { species } },
        pppRegistries: { status: "ok", data: null },
      },
    };
  }

  beforeEach(() => {
    mockFetchOwnerPetDetail.mockReset();
    mockRecordPetEvent.mockReset();
    mockFetchOwnerPetDetail.mockResolvedValue(detail());
    mockRecordPetEvent.mockResolvedValue(recorded());
  });

  it("avisa lo que cierra ANTES del formulario, no después de enviarlo", async () => {
    // La única subtitle de esta pantalla que advierte en vez de describir. Una
    // persona tiene derecho a saber que esto da de baja tránsitos y casos
    // mientras todavía puede decidir no hacerlo.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="death" />);
    expect(screen.getByText(/Cierra el registro del animal/)).toBeTruthy();
  });

  it("no muestra el selector de enfermedad hasta que la causa es Enfermedad", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="death" />);
    expect(screen.queryByText("Rabia (confirmada)")).toBeNull();

    fireEvent.press(screen.getByText("Enfermedad"));
    await waitFor(() => expect(screen.getByText("Rabia (confirmada)")).toBeTruthy());
  });

  it("filtra el catálogo por la especie del animal", async () => {
    // El catálogo es dog/cat-céntrico y el servidor filtra igual. Ofrecerle
    // panleucopenia felina al dueño de un perro es ofrecerle un código que su
    // propio animal no puede tener.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="death" />);
    await waitFor(() => expect(mockFetchOwnerPetDetail).toHaveBeenCalledTimes(1));
    fireEvent.press(screen.getByText("Enfermedad"));

    await waitFor(() => expect(screen.getByText("Brucelosis canina (B. canis)")).toBeTruthy());
    expect(screen.queryByText("Panleucopenia felina")).toBeNull();
  });

  it("DESCARTA la enfermedad elegida cuando la causa deja de ser Enfermedad", async () => {
    // EL MISMO DEFECTO QUE EL REGISTRO PPP, en otra forma: alguien elige
    // "Enfermedad", nombra una, y después cambia a "Accidente". Sin este
    // borrado el borrador sigue cargando la enfermedad abandonada, el campo ya
    // no está en pantalla, y el servidor recibe una causa que no la pide con un
    // código que sí mandó.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="death" />);
    fireEvent.press(screen.getByText("Enfermedad"));
    await waitFor(() => expect(screen.getByText("Rabia (confirmada)")).toBeTruthy());
    fireEvent.press(screen.getByText("Rabia (confirmada)"));

    fireEvent.press(screen.getByText("Accidente"));
    await waitFor(() => expect(screen.queryByText("Rabia (confirmada)")).toBeNull());

    fireEvent.press(submitControl());
    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({ kind: "death", cause: "accident", diseaseCode: null });
  });

  it("DESCARTA los datos de la clínica cuando deja de haber fallecido en una", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="death" />);
    fireEvent.press(screen.getByText("No la sé"));
    // `getAllByText` Y NO `getByText`: esta pantalla tiene TRES filas sí/no a la
    // vez y las tres dicen lo mismo. La primera en orden de dibujo es
    // "¿Falleció en una veterinaria?" — y que haga falta contarlas es la razón
    // por la que el grupo de `Choice` ahora lleva su pregunta como etiqueta
    // accesible.
    fireEvent.press(screen.getAllByText("Sí")[0] as never);

    // La veterinaria aparece, y con ella la pregunta del contacto.
    await waitFor(() => expect(screen.getByText("Nombre de la veterinaria")).toBeTruthy());
    fireEvent.press(screen.getByText("No me contactó"));
    await waitFor(() => expect(screen.getByText("¿Decidió sin consultarte?")).toBeTruthy());

    // Y al decir que NO falleció en una veterinaria, las tres se van juntas.
    fireEvent.press(screen.getAllByText("No")[0] as never);
    await waitFor(() => expect(screen.queryByText("Nombre de la veterinaria")).toBeNull());
    expect(screen.queryByText("¿Decidió sin consultarte?")).toBeNull();

    fireEvent.press(submitControl());
    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({
      kind: "death",
      deathAtClinic: false,
      clinicName: null,
      vetContactedOwner: null,
      vetDecidedAlone: false,
    });
  });

  it("refuse sin causa, ANTES de llamar al servidor", async () => {
    // `cause` no tiene default a propósito: "no la sé" es una respuesta que la
    // persona da, no una que el formulario dé por ella.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="death" />);
    fireEvent.press(submitControl());

    await waitFor(() => expect(screen.getByText("Elegí la causa del fallecimiento.")).toBeTruthy());
    expect(mockRecordPetEvent).not.toHaveBeenCalled();
  });

  it("DESCARTA una enfermedad que el catálogo deja de ofrecer cuando llega la especie", async () => {
    // EL MISMO DEFECTO QUE EL REGISTRO PPP, REINTRODUCIDO EL MISMO DÍA tres
    // pantallas más abajo — y peor, porque acá el valor que sobrevive dispara
    // una señal a la autoridad sanitaria. En un link lento el selector muestra
    // el catálogo entero antes de saber la especie; alguien con un PERRO elige
    // "Toxoplasmosis", que es de gatos y es NOTIFICABLE. Cuando llega la
    // especie el chip desaparece y, sin este borrado, el borrador lo conserva.
    let resolveDetail: (value: unknown) => void = () => {};
    mockFetchOwnerPetDetail.mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );
    render(<RecordEventScreen publicToken={TOKEN} initialKind="death" />);
    fireEvent.press(screen.getByText("Enfermedad"));

    // Sin especie todavía, el catálogo entero — incluidas las de gato.
    await waitFor(() => expect(screen.getByText("Panleucopenia felina")).toBeTruthy());
    fireEvent.press(screen.getByText("Panleucopenia felina"));

    await act(async () => {
      resolveDetail(detail("dog"));
    });

    await waitFor(() => expect(screen.queryByText("Panleucopenia felina")).toBeNull());
    fireEvent.press(submitControl());

    // Se refuta ACÁ, sobre un campo que la persona puede volver a contestar —
    // en vez de escribir en el libro una enfermedad que ese animal no puede
    // tener, en una fila que después nadie puede corregir.
    await waitFor(() => expect(screen.getByText("Elegí de qué enfermedad murió.")).toBeTruthy());
    expect(mockRecordPetEvent).not.toHaveBeenCalled();
  });

  it("CONSERVA una enfermedad que la especie sí admite", async () => {
    // NO-VACUIDAD: un borrado incondicional pasaría el caso de arriba y le
    // tiraría la respuesta a quien contestó bien.
    let resolveDetail: (value: unknown) => void = () => {};
    mockFetchOwnerPetDetail.mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );
    render(<RecordEventScreen publicToken={TOKEN} initialKind="death" />);
    fireEvent.press(screen.getByText("Enfermedad"));
    await waitFor(() => expect(screen.getByText("Rabia (confirmada)")).toBeTruthy());
    fireEvent.press(screen.getByText("Rabia (confirmada)"));

    await act(async () => {
      resolveDetail(detail("dog"));
    });

    await waitFor(() => expect(mockFetchOwnerPetDetail).toHaveBeenCalledTimes(1));
    fireEvent.press(submitControl());
    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({ kind: "death", diseaseCode: "rabies_confirmed" });
  });

  it("manda la causa y la fecha en el asiento más simple que se puede escribir", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="death" />);
    fireEvent.press(screen.getByText("Natural / vejez"));
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({ kind: "death", cause: "natural" });
  });
});

describe("tatuaje — el asiento que necesita una foto", () => {
  /** A build with no `expo-image-picker`, which is every build shipped so far. */
  function withoutPicker() {
    resetImagePickerPort();
  }

  it("EN UNA BUILD SIN SELECTOR no dibuja el formulario ni un botón que no puede funcionar", () => {
    // La regla del puerto, la misma que sigue `PetPhotoScreen`: leer
    // `available` ANTES de dibujar un control. La foto es obligatoria en las dos
    // puertas, así que un formulario sin manera de elegirla sólo podría terminar
    // en un refusal — y buscar un botón que no puede andar es el callejón que
    // esta pantalla existe para evitar.
    withoutPicker();
    render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);

    expect(
      screen.getByText("Todavía no se puede registrar un tatuaje desde la app"),
    ).toBeOnTheScreen();
    expect(screen.getByText(/la foto se carga desde la web/i)).toBeOnTheScreen();
    // NI EL CAMPO DEL CÓDIGO NI EL BOTÓN DE ENVIAR.
    expect(screen.queryByText("Código del tatuaje")).not.toBeOnTheScreen();
    expect(screen.queryByText(recordEventCta("tattoo").label)).not.toBeOnTheScreen();
  });

  it("con selector disponible dibuja el formulario y dice que la foto es obligatoria", () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);
    expect(screen.getByText(/la foto es obligatoria/i)).toBeOnTheScreen();
    expect(screen.getByText("Elegir la foto del tatuaje")).toBeOnTheScreen();
    expect(screen.getByText(recordEventCta("tattoo").label)).toBeOnTheScreen();
  });

  it("PO decision 20A: dice que una foto de la cámara también sirve, antes de elegir una", async () => {
    // "Elegir la foto del tatuaje" abre la galería (`launchImageLibraryAsync`)
    // y no tiene control de cámara propio.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);
    expect(
      screen.getByText(
        "Podés elegir una que ya tengas, o sacar una nueva con la cámara y elegirla después.",
      ),
    ).toBeOnTheScreen();

    setImagePickerPort({
      name: "test-picks",
      available: true,
      pickImage: async () => ({
        outcome: "picked",
        bytes: new Uint8Array([0xff, 0xd8, 0xff]),
        contentType: "image/jpeg",
        previewUri: null,
      }),
      recoverPendingPick: async () => null,
    });
    await act(async () => {
      fireEvent.press(screen.getByText("Elegir la foto del tatuaje"));
    });

    // GONE once a photo is ready — there is no camera choice left to explain.
    expect(
      screen.queryByText(
        "Podés elegir una que ya tengas, o sacar una nueva con la cámara y elegirla después.",
      ),
    ).toBeNull();
  });

  it("REFUSES sin foto y no manda nada — el contrato nombra el paso que falta", async () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);
    fireEvent.changeText(screen.getByLabelText("Código del tatuaje, obligatorio"), "ABC-1234");
    fireEvent.press(submitControl());

    await waitFor(() => expect(screen.getByText(/falta la foto del tatuaje/i)).toBeOnTheScreen());
    expect(mockRecordPetEvent).not.toHaveBeenCalled();
  });

  it("F-10 (native review): la foto que se sube DESPUÉS del refusal borra el aviso de que falta", async () => {
    // El aviso vivía en un estado aparte del borrador (`error`, no `invalid`),
    // así que agregar la foto no lo tocaba: `set()` sólo limpia un campo que
    // cambió, y la foto no es un campo. El aviso quedaba en pantalla mintiendo
    // sobre un formulario que ya podía enviarse.
    setImagePickerPort({
      name: "test-picks",
      available: true,
      pickImage: async () => ({
        outcome: "picked",
        bytes: new Uint8Array([0xff, 0xd8, 0xff]),
        contentType: "image/jpeg",
        previewUri: null,
      }),
      recoverPendingPick: async () => null,
    });
    render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);

    // Code filled so the ONLY missing thing is the photo — the same setup
    // "REFUSES sin foto" below uses.
    fireEvent.changeText(screen.getByLabelText("Código del tatuaje, obligatorio"), "ABC-1234");
    fireEvent.press(submitControl());
    await waitFor(() => expect(screen.getByText(/falta la foto del tatuaje/i)).toBeOnTheScreen());

    await act(async () => {
      fireEvent.press(screen.getByText("Elegir la foto del tatuaje"));
    });

    expect(screen.getByText("Foto lista")).toBeOnTheScreen();
    expect(screen.queryByText(/falta la foto del tatuaje/i)).toBeNull();
  });

  it("SUBE LA FOTO AL ELEGIRLA, no al enviar", async () => {
    // Que la persona se entere de que la subida falló mientras todavía está
    // mirando la foto, y que un campo mal cargado no cueste megabytes.
    setImagePickerPort({
      name: "test-picks",
      available: true,
      pickImage: async () => ({
        outcome: "picked",
        bytes: new Uint8Array([0xff, 0xd8, 0xff]),
        contentType: "image/jpeg",
        previewUri: null,
      }),
      recoverPendingPick: async () => null,
    });
    render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);

    await act(async () => {
      fireEvent.press(screen.getByText("Elegir la foto del tatuaje"));
    });

    expect(mockStageTattooPhoto).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Foto lista")).toBeOnTheScreen();
    // NO DICE "LISTO" A SECAS: los bytes están arriba, el asiento no existe.
    expect(screen.getByText(/se va a guardar junto con el asiento/i)).toBeOnTheScreen();
    // Y todavía no salió ningún asiento.
    expect(mockRecordPetEvent).not.toHaveBeenCalled();
  });

  it("manda el asiento con el stagedPath que dejó la subida", async () => {
    setImagePickerPort({
      name: "test-picks",
      available: true,
      pickImage: async () => ({
        outcome: "picked",
        bytes: new Uint8Array([0xff, 0xd8, 0xff]),
        contentType: "image/jpeg",
        previewUri: null,
      }),
      recoverPendingPick: async () => null,
    });
    render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);

    fireEvent.changeText(screen.getByLabelText("Código del tatuaje, obligatorio"), "ABC-1234");
    await act(async () => {
      fireEvent.press(screen.getByText("Elegir la foto del tatuaje"));
    });
    fireEvent.press(submitControl());

    await waitFor(() => expect(mockRecordPetEvent).toHaveBeenCalledTimes(1));
    expect(mockRecordPetEvent.mock.calls[0]?.[2]).toMatchObject({
      kind: "tattoo",
      tattooCode: "ABC-1234",
      stagedPath: A_STAGED_PATH,
    });
  });

  it("muestra la razón cuando la subida falla, y sigue sin foto", async () => {
    setImagePickerPort({
      name: "test-picks",
      available: true,
      pickImage: async () => ({
        outcome: "picked",
        bytes: new Uint8Array([0xff, 0xd8, 0xff]),
        contentType: "image/jpeg",
        previewUri: null,
      }),
      recoverPendingPick: async () => null,
    });
    mockStageTattooPhoto.mockResolvedValue({
      outcome: "failed",
      failure: { stage: "put", kind: "expired" },
    });
    render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);

    await act(async () => {
      fireEvent.press(screen.getByText("Elegir la foto del tatuaje"));
    });

    expect(screen.getByText(/el permiso venció/i)).toBeOnTheScreen();
    expect(screen.queryByText("Foto lista")).not.toBeOnTheScreen();
  });
});

describe("tatuaje — T4-M1 (2026-09-22): una foto que Android sostuvo desde antes de este montaje", () => {
  const recoveredPick = {
    outcome: "picked" as const,
    bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    contentType: "image/jpeg",
    previewUri: null,
  };

  it("T3-R4 (2026-09-22): NO la sube sola — aterriza en revisión y exige un toque", async () => {
    // ESTE ES EL FIX. Hasta T3-R4 esta misma foto se subía sin ningún gesto:
    // el título de este caso decía "la sube sola, sin ningún toque en el
    // botón" y eso era el bug — una recuperación no tiene ningún toque
    // detrás, así que auto-subirla podía mandar la foto de OTRA mascota (o de
    // otra sesión) al tatuaje de esta.
    await seedImagePickMarker();
    setImagePickerPort({
      name: "test-recovers",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick: async () => recoveredPick,
    });

    render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);

    await waitFor(() =>
      expect(screen.getByText("¿Es esta la foto del tatuaje?")).toBeOnTheScreen(),
    );
    expect(mockStageTattooPhoto).not.toHaveBeenCalled();
    expect(screen.queryByText("Foto lista")).not.toBeOnTheScreen();
  });

  it("un toque en 'Usar esta foto' recién ahí la sube", async () => {
    await seedImagePickMarker();
    setImagePickerPort({
      name: "test-recovers",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick: async () => recoveredPick,
    });

    render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);
    await waitFor(() =>
      expect(screen.getByText("¿Es esta la foto del tatuaje?")).toBeOnTheScreen(),
    );

    await act(async () => {
      fireEvent.press(screen.getByText("Usar esta foto"));
    });

    expect(mockStageTattooPhoto).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Foto lista")).toBeOnTheScreen();
  });

  it("'Descartar' vuelve al principio sin subir nada", async () => {
    await seedImagePickMarker();
    setImagePickerPort({
      name: "test-recovers",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick: async () => recoveredPick,
    });

    render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);
    await waitFor(() =>
      expect(screen.getByText("¿Es esta la foto del tatuaje?")).toBeOnTheScreen(),
    );

    fireEvent.press(screen.getByText("Descartar"));

    expect(mockStageTattooPhoto).not.toHaveBeenCalled();
    expect(screen.getByText("Elegir la foto del tatuaje")).toBeOnTheScreen();
  });

  it("muestra la misma razón que una falla en vivo, para una recuperación fallida", async () => {
    await seedImagePickMarker();
    setImagePickerPort({
      name: "test-recovers-failed",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick: async () => ({
        outcome: "failed",
        detail: "pending: ERR_IMAGE_MANIPULATOR: boom",
      }),
    });

    render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);

    await waitFor(() =>
      expect(screen.getByText("No pudimos abrir tus fotos. Volvé a intentar.")).toBeOnTheScreen(),
    );
    expect(mockStageTattooPhoto).not.toHaveBeenCalled();
  });

  it("NO pisa una elección que la persona ya está haciendo en vivo", async () => {
    // La recuperación se mantiene ABIERTA con una promesa diferida y sólo se
    // resuelve DESPUÉS de que la elección en vivo ya subió y quedó "lista" —
    // una prueba más fuerte que una carrera en el mismo tick, que el guard
    // ganaría de todos modos. Sin el `current.phase !== "none"` del efecto,
    // la respuesta tardía de Android pisaría la foto ya subida con una vieja.
    // La marca sembrada COINCIDIRÍA de no ser por el guard — así la prueba
    // sigue siendo sobre `photoAttemptStarted`, no sobre un descarte por marca.
    await seedImagePickMarker();
    let resolveRecovery!: (result: ImagePickResult | null) => void;
    const heldRecovery = new Promise<ImagePickResult | null>((resolve) => {
      resolveRecovery = resolve;
    });
    const freshPick = {
      outcome: "picked" as const,
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      contentType: "image/jpeg",
      previewUri: "file:///cache/fresh-tattoo.jpg",
    };
    setImagePickerPort({
      name: "test-race",
      available: true,
      pickImage: async () => freshPick,
      recoverPendingPick: () => heldRecovery,
    });

    render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);
    await act(async () => {
      fireEvent.press(screen.getByText("Elegir la foto del tatuaje"));
    });

    await waitFor(() => expect(screen.getByText("Foto lista")).toBeOnTheScreen());
    expect(mockStageTattooPhoto).toHaveBeenCalledTimes(1);

    // RECIÉN AHORA llega la respuesta tardía de Android — la foto en vivo ya
    // está subida y "lista".
    await act(async () => {
      resolveRecovery(recoveredPick);
    });

    // NEGATIVA CON VENTANA, y no una cuenta fija de microtasks: la cadena
    // async que llevaría a una segunda subida tiene varios saltos (el
    // wrapper "never-throws", el efecto, el updater de React), y contar los
    // saltos a mano es fragil. Esto le da 300 ms reales para que una segunda
    // subida aparezca si el guard estuviera roto, y sólo entonces confirma
    // que se quedó en una.
    let sawSecondUpload = false;
    try {
      await waitFor(() => expect(mockStageTattooPhoto).toHaveBeenCalledTimes(2), {
        timeout: 300,
      });
      sawSecondUpload = true;
    } catch {
      // Lo esperado: nunca llegó a una segunda subida en la ventana.
    }
    expect(sawSecondUpload).toBe(false);
    expect(mockStageTattooPhoto).toHaveBeenCalledTimes(1);
    expect(mockStageTattooPhoto).toHaveBeenCalledWith(
      expect.anything(),
      TOKEN,
      expect.objectContaining({ previewUri: "file:///cache/fresh-tattoo.jpg" }),
    );
  });

  describe("T3-R4 (2026-09-22): la marca ata la recuperación a quién y qué la pidió", () => {
    it("descarta una foto recuperada para OTRA mascota", async () => {
      await seedImagePickMarker({ publicToken: "DIM-OTRO-0002" });
      setImagePickerPort({
        name: "test-recovers",
        available: true,
        pickImage: async () => ({ outcome: "cancelled" }),
        recoverPendingPick: async () => recoveredPick,
      });

      render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);

      await waitFor(() => expect(screen.getByText("Elegir la foto del tatuaje")).toBeOnTheScreen());
      expect(screen.queryByText("¿Es esta la foto del tatuaje?")).not.toBeOnTheScreen();
      expect(mockStageTattooPhoto).not.toHaveBeenCalled();
    });

    it("descarta una foto recuperada para OTRA persona firmada", async () => {
      await seedImagePickMarker({ sessionUserId: "00000000-0000-4000-8000-000000000000" });
      setImagePickerPort({
        name: "test-recovers",
        available: true,
        pickImage: async () => ({ outcome: "cancelled" }),
        recoverPendingPick: async () => recoveredPick,
      });

      render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);

      await waitFor(() => expect(screen.getByText("Elegir la foto del tatuaje")).toBeOnTheScreen());
      expect(screen.queryByText("¿Es esta la foto del tatuaje?")).not.toBeOnTheScreen();
    });

    it("descarta una foto recuperada para OTRA pantalla (la de la foto de perfil)", async () => {
      await seedImagePickMarker({ screen: "pet-photo" });
      setImagePickerPort({
        name: "test-recovers",
        available: true,
        pickImage: async () => ({ outcome: "cancelled" }),
        recoverPendingPick: async () => recoveredPick,
      });

      render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);

      await waitFor(() => expect(screen.getByText("Elegir la foto del tatuaje")).toBeOnTheScreen());
      expect(screen.queryByText("¿Es esta la foto del tatuaje?")).not.toBeOnTheScreen();
    });

    it("descarta una marca VIEJA — pasado el margen de 30 minutos", async () => {
      await seedImagePickMarker({ launchedAt: Date.now() - 31 * 60 * 1000 });
      setImagePickerPort({
        name: "test-recovers",
        available: true,
        pickImage: async () => ({ outcome: "cancelled" }),
        recoverPendingPick: async () => recoveredPick,
      });

      render(<RecordEventScreen publicToken={TOKEN} initialKind="tattoo" />);

      await waitFor(() => expect(screen.getByText("Elegir la foto del tatuaje")).toBeOnTheScreen());
      expect(screen.queryByText("¿Es esta la foto del tatuaje?")).not.toBeOnTheScreen();
    });
  });
});

// ---------------------------------------------------------------------------
// The two kinds the app can now NAVIGATE to
// ---------------------------------------------------------------------------

/**
 * WHAT THESE ADD over the form tests above. `death` and
 * `dangerous_breed_attestation` have had working forms on this screen for
 * weeks; what they did not have was a door. The doors landed on 2026-09-10
 * (`OwnerFace`'s ⋯ Más row and its compliance card), and these cases pin the
 * other half of that wiring: a `kind` arriving from the route really renders
 * THAT form, and not the picker.
 *
 * EVERY EXPECTED STRING IS A LITERAL. `kindTitle("death")` as an expectation
 * would pass against a screen that rendered the wrong form with the right
 * heading, and would keep passing if both moved together.
 */
describe("las dos puertas nuevas — el kind del link rinde SU formulario", () => {
  beforeEach(() => {
    mockFetchOwnerPetDetail.mockReset();
    // No read answers: both forms are correct without one (the death form's
    // disease list and the attestation's registries degrade to their national
    // defaults), and a pending promise is the state a person sees first.
    mockFetchOwnerPetDetail.mockReturnValue(new Promise(() => {}));
  });

  it("kind=death rinde el formulario de fallecimiento y no el selector", () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="death" />);

    expect(screen.getByText("Fallecimiento")).toBeOnTheScreen();
    // The subtitle that warns before the form rather than after it.
    expect(screen.getByText(/Cierra el registro del animal/)).toBeOnTheScreen();
    // The CTA is the death form's own verb — "Asentar", never "Registrar".
    expect(screen.getByText("Asentar el fallecimiento")).toBeOnTheScreen();
    // NON-VACUITY: the PICKER is what a dropped kind renders, and its rows are
    // absent here. "Peso" is a fixed row of `RECORD_KINDS` and is not a field,
    // a label or a chip on the death form.
    expect(screen.queryByText("Peso")).toBeNull();
  });

  it("kind=dangerous_breed_attestation rinde la atestación y no el selector", () => {
    render(<RecordEventScreen publicToken={TOKEN} initialKind="dangerous_breed_attestation" />);

    expect(screen.getByText("Atestación de raza peligrosa")).toBeOnTheScreen();
    expect(screen.getByText("Registrar la atestación")).toBeOnTheScreen();
    expect(screen.queryByText("Peso")).toBeNull();
  });

  it("un kind que esta app no conoce cae en el selector, con las dos filas fijas", () => {
    // THE CONTROL FOR THE TWO ABOVE. It proves "Peso" really is what the picker
    // shows and the two assertions above are not passing against a screen that
    // renders nothing at all.
    render(<RecordEventScreen publicToken={TOKEN} initialKind={null} />);

    expect(screen.getByText("Peso")).toBeOnTheScreen();
    expect(screen.queryByText("Asentar el fallecimiento")).toBeNull();
    // AND THE PICKER STILL DOES NOT OFFER EITHER OF THE TWO. They are
    // contextual acts; a person scrolling for "Peso" must not pass
    // "Fallecimiento" on the way.
    expect(screen.queryByText("Fallecimiento")).toBeNull();
    expect(screen.queryByText("Atestación de raza peligrosa")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The keyboard, on the longest form in the app (open-work row 11)
//
// `kit.test.tsx` pins the RULE and the primitive. This pins the thing the row
// was actually about: `asentar` is ~700 lines of fields, it is one of the two
// screens the fix exists for, and a keyboard-avoidance regression here is
// invisible to every test that renders the kit in isolation. A screen that
// dropped `keyboardAvoiding`, or a `Screen` that stopped honouring it, leaves
// the field being typed on under the IME on Android and nothing goes red
// anywhere else.
// ---------------------------------------------------------------------------

describe("RecordEventScreen — the form types above the keyboard", () => {
  it("mounts a KeyboardAvoidingView with a real behavior on a multi-field form", () => {
    // `medication_start` is the longest of the owner kinds — its own
    // `returnKeyChainLength` is 4 typed fields plus the chip rows.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="medication_start" />);
    // The form is really here, not a picker or a refusal: without this the
    // assertion below could be sweeping an empty screen clean.
    expect(screen.getAllByDisplayValue("").length).toBeGreaterThan(2);

    const avoider = screen.UNSAFE_getByType(KeyboardAvoidingView);
    // `undefined` is the defect, and it is a legal prop value — so the check is
    // membership in the two arms that DO something, not "is defined".
    expect(["padding", "height"]).toContain(avoider.props.behavior);
  });
});

// ---------------------------------------------------------------------------
// What somebody types survives being interrupted (PO decision 2026-09-16)
//
// The store's own rules — keys, expiry, what it refuses to hand back — are
// pinned in `event-draft-store.test.ts`. What is pinned HERE is the half that
// only exists once the hook, the form and the server are wired together, and
// every case below is one of the ways that wiring goes wrong on a phone while
// staying green everywhere else:
//
//   · a draft that is never written, so the feature simply is not there;
//   · a draft written by somebody who opened a form and typed nothing, so the
//     banner greets people with the recovery of an empty form and teaches them
//     to ignore it before the day it matters;
//   · A DRAFT THAT OUTLIVES ITS OWN SUCCESSFUL SUBMIT, which comes back on the
//     next open and reads as "the app did not save my record" — the exact fear
//     this feature exists to remove, delivered by the fix for it;
//   · a draft DESTROYED by a submit that failed, which is that same loss at the
//     one moment the person most needed it kept.
//
// LOCAL SCRATCH, NEVER A SEND QUEUE (and the PO chose that order deliberately:
// a retry done wrong on an append-only spine writes two asientos for one act).
// Nothing below asserts a retry because nothing in the screen performs one —
// `recordPetEvent` is called when, and only when, a person presses the button.
// ---------------------------------------------------------------------------

/**
 * SPIED ON THE PUBLIC API and left calling through — the idiom
 * `use-qr-spotlight.test.tsx` states for this same platform surface. The point
 * is only to get hold of the listener the hook registered.
 */
const appStateListener = jest.spyOn(AppState, "addEventListener");

/** Take the app out of the foreground, the way an incoming call does. */
function emitAppState(next: AppStateStatus): void {
  const listener = appStateListener.mock.calls.at(-1)?.[1] as
    | ((state: AppStateStatus) => void)
    | undefined;
  if (listener === undefined) throw new Error("the form registered no AppState listener");
  act(() => listener(next));
}

/** Every key the draft store owns, right now. */
async function storedDraftKeys(): Promise<readonly string[]> {
  return (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith("mimar.eventDraft."));
}

/**
 * Let every queued storage write and delete settle.
 *
 * IT IS NOT A CONVENIENCE AND ITS ABSENCE COSTS A REAL FENCE. Writes are
 * chained on one promise so a delete cannot overtake the write before it, which
 * means there is a MOMENT between "the success deleted the draft" and "the
 * unmount wrote it back" in which the phone genuinely holds no draft. A
 * `waitFor` that only has to be right once passes in that moment and calls the
 * bug fixed. Measured: without this flush, deleting the seal from
 * `use-event-draft.ts` left all thirteen draft cases green.
 */
async function flushStorage(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Wait until exactly `count` drafts are on the phone, and STAY there. */
async function expectStoredDrafts(count: number): Promise<void> {
  await flushStorage();
  await waitFor(async () => {
    expect(await storedDraftKeys()).toHaveLength(count);
  });
}

/** Fill in Peso and leave — the shortest complete interruption there is. */
async function typeAndLeave(value = "12,5"): Promise<void> {
  const { unmount } = render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
  fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), value);
  unmount();
  await expectStoredDrafts(1);
}

describe("RecordEventScreen — the draft survives the interruption", () => {
  it("keeps what was typed when the form goes away", async () => {
    await typeAndLeave();
  });

  it("writes NOTHING for somebody who opened a form and typed nothing", async () => {
    // The same case that kept the discard guard off eight screens, one layer
    // down: a draft created by merely OPENING a form means the next visit is
    // met by a banner announcing the recovery of an empty form.
    const { unmount } = render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    unmount();

    await expectStoredDrafts(0);
  });

  it("writes when the app leaves the foreground, without waiting to be unmounted", async () => {
    // THE PHONE RINGS. No blur, no unmount, no navigation: the app simply stops
    // being in front of the person, and on a cheap phone that is the last
    // moment before the OS reclaims the process. `inactive` counts, because on
    // iOS it is the FIRST thing an incoming call raises and the `background`
    // that may follow is not something to bet somebody's typing on.
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "12,5");

    emitAppState("inactive");

    await expectStoredDrafts(1);
  });

  it("puts it back on screen, and says where it came from", async () => {
    await typeAndLeave();

    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);

    await waitFor(() =>
      expect(screen.getByText("Recuperamos lo que estabas escribiendo")).toBeOnTheScreen(),
    );
    expect(screen.getByDisplayValue("12,5")).toBeOnTheScreen();
    // ANNOUNCED AND NOT SILENT, and this sentence is what earns the banner:
    // somebody who does not remember typing this is one tap from appending it
    // to a national registry, and the fact they need first is that nothing has
    // been registered yet.
    expect(screen.getByText(/Todavía no se registró nada/)).toBeOnTheScreen();
  });

  it("does not offer one form's draft inside another form", async () => {
    await typeAndLeave();

    render(<RecordEventScreen publicToken={TOKEN} initialKind="note" />);

    await waitFor(() => expect(screen.getByLabelText("Nota, obligatorio")).toBeOnTheScreen());
    expect(screen.queryByText("Recuperamos lo que estabas escribiendo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A write that fires AFTER the session ended must not land (A2b)
//
// Signing out sweeps every draft on the device (`forgetAllEventDrafts`), and
// that sweep takes its list of keys ONCE. The form does not necessarily
// re-render on the way out: it can unmount straight from the last render in
// which somebody was signed in, and its idle timer may still be pending. Both
// writers close over the key from that render. Without a check at WRITE time,
// a bite victim's name and phone typed less than two seconds before "Cerrar
// sesión" are written back after the sweep has already looked — and survive
// the exit that promised to remove them.
// ---------------------------------------------------------------------------

/** A deliberate "Cerrar sesión": nobody signed in, and the drafts swept. */
function signOutDeliberately(): void {
  mockSession.userId = undefined;
  mockSession.sweepEpoch += 1;
}

describe("RecordEventScreen — a write that fires after the session ended", () => {
  it("the pending idle write does not land after a deliberate sign-out", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
      fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "12,5");

      // Signed out WITHOUT the form re-rendering, then the idle timer fires.
      signOutDeliberately();
      act(() => {
        jest.advanceTimersByTime(2_000);
      });
    } finally {
      jest.useRealTimers();
    }

    await expectStoredDrafts(0);
  });

  it("the unmount write does not land after a deliberate sign-out", async () => {
    const { unmount } = render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "12,5");

    signOutDeliberately();
    unmount();

    await expectStoredDrafts(0);
  });

  it("the unmount write does not land once somebody else is signed in", async () => {
    const { unmount } = render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "12,5");

    mockSession.userId = "88888888-8888-4888-8888-888888888888";
    unmount();

    await expectStoredDrafts(0);
  });

  it("the unmount write does not land after a sweep, even once the same person is back", async () => {
    // The text was thrown away on their word; signing back in does not undo
    // that, and a write landing now would resurrect exactly what was swept.
    const { unmount } = render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "12,5");

    signOutDeliberately();
    mockSession.userId = mockSignedInUserId;
    unmount();

    await expectStoredDrafts(0);
  });
});

// ---------------------------------------------------------------------------
// A session that merely could not be CHECKED keeps the draft (A2c)
//
// Weak signal, the refresh times out, the phase becomes `session-unverified`
// and the gate swaps the form for the "revisá tu conexión" screen — the form
// UNMOUNTS. A2b refused every write outside `signed-in`, so that unmount write
// (the last edits, typed inside the two-second idle window) was thrown away and
// the person came back to an older draft. A refused refresh (`auth_expired`)
// is the same story with a sign-in at the end. Neither sweeps the drafts, so
// neither may refuse a write.
// ---------------------------------------------------------------------------

describe("RecordEventScreen — an involuntary session end keeps the latest text", () => {
  for (const [label, notSignedIn] of [
    ["the session could not be verified", { phase: "session-unverified", message: "Sin conexión" }],
    ["the refresh was refused (auth_expired)", { phase: "signed-out", reason: "auth_expired" }],
  ] as const) {
    it(`the unmount write lands when ${label}`, async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick"] });
      try {
        const { unmount } = render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
        // An OLDER draft is already on disk: the idle write of "12".
        fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "12");
        act(() => {
          jest.advanceTimersByTime(2_000);
        });
        // The last edit, inside the idle window, then the session drops and
        // the gate unmounts the form.
        fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "12,5");
        mockSession.userId = undefined;
        mockSession.notSignedIn = notSignedIn;
        unmount();
      } finally {
        jest.useRealTimers();
      }

      await expectStoredDrafts(1);
      // Back online, the same person: the LATEST text comes back, not "12".
      mockSession.userId = mockSignedInUserId;
      render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
      await waitFor(() => expect(screen.getByDisplayValue("12,5")).toBeOnTheScreen());
    });
  }

  it("a write refused in the queue does not mark the text as saved", async () => {
    // The check at `persistNow` passes, the write is queued, and by the time
    // the queue reaches it somebody else is signed in: refused. If the form
    // had already recorded those values as on disk, the next departure with
    // the same text — once its owner is back — would skip the write it needs.
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    let unmount: () => void = () => undefined;
    try {
      ({ unmount } = render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />));
      fireEvent.changeText(screen.getByLabelText("Peso (kg), obligatorio"), "12,5");
      act(() => {
        jest.advanceTimersByTime(2_000);
        // Synchronously, before the queued write's turn comes.
        mockSession.userId = "88888888-8888-4888-8888-888888888888";
      });
    } finally {
      jest.useRealTimers();
    }
    await expectStoredDrafts(0);

    mockSession.userId = mockSignedInUserId;
    unmount();

    await expectStoredDrafts(1);
  });
});

describe("RecordEventScreen — throwing a draft away on purpose", () => {
  // Declared the way the discard-guard block above declares its own: `Alert` is
  // already a spy by the time this file's first test runs, and a second
  // `spyOn` returns that same spy rather than stacking another one.
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});

  beforeEach(() => {
    alert.mockClear();
  });

  it("wipes the draft and empties the form when the person confirms", async () => {
    await typeAndLeave();
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    await waitFor(() => expect(screen.getByDisplayValue("12,5")).toBeOnTheScreen());

    fireEvent.press(screen.getByText("Descartar el borrador"));
    // CONFIRMED, because it is irreversible and because the text it destroys is
    // text its owner may not remember writing — which is exactly the state in
    // which a mis-tap is likeliest.
    expect(alert.mock.calls[0]?.[0]).toBe("¿Descartar el borrador?");
    const discard = alert.mock.calls[0]?.[2]?.[1];
    act(() => {
      discard?.onPress?.();
    });

    expect(screen.queryByDisplayValue("12,5")).toBeNull();
    expect(screen.queryByText("Recuperamos lo que estabas escribiendo")).toBeNull();
    await expectStoredDrafts(0);
  });

  it("keeps it when the person backs out of the confirm", async () => {
    await typeAndLeave();
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    await waitFor(() => expect(screen.getByDisplayValue("12,5")).toBeOnTheScreen());

    fireEvent.press(screen.getByText("Descartar el borrador"));

    expect(screen.getByDisplayValue("12,5")).toBeOnTheScreen();
    await expectStoredDrafts(1);
  });
});

describe("RecordEventScreen — the draft dies with its own success, and only there", () => {
  it("clears once the server has the asiento", async () => {
    await typeAndLeave();
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    await waitFor(() => expect(screen.getByDisplayValue("12,5")).toBeOnTheScreen());

    fireEvent.press(submitControl());
    await waitFor(() => expect(screen.getByText("Volver a la libreta")).toBeOnTheScreen());

    await expectStoredDrafts(0);
  });

  it("stays cleared when the screen leaves after the success", async () => {
    // THE SEAL. The unmount write fires a moment after the clear, when the
    // screen replaces itself with the libreta — and without it that write puts
    // the draft straight back, for an asiento already on the spine.
    await typeAndLeave();
    const { unmount } = render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    await waitFor(() => expect(screen.getByDisplayValue("12,5")).toBeOnTheScreen());
    fireEvent.press(submitControl());
    await waitFor(() => expect(screen.getByText("Volver a la libreta")).toBeOnTheScreen());

    unmount();

    await expectStoredDrafts(0);
  });

  it("clears on a replay, because a replay means the asiento is there", async () => {
    // `wasDuplicate` IS A SUCCESS: the server answering "this idempotency key
    // already appended" means the ledger has it. Keeping the draft here would
    // be the same lie as keeping it after a fresh append.
    mockRecordPetEvent.mockResolvedValue(recorded(true));
    await typeAndLeave();
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    await waitFor(() => expect(screen.getByDisplayValue("12,5")).toBeOnTheScreen());

    fireEvent.press(submitControl());
    await waitFor(() => expect(screen.getByText("Ya estaba registrado")).toBeOnTheScreen());

    await expectStoredDrafts(0);
  });

  it("KEEPS it when the submit never reached the server", async () => {
    // THE FAILED SUBMIT ON THE SUBTE IS THE WHOLE CASE. Clearing here would
    // destroy the writing at the one moment the person most needs it kept, and
    // would do it on a screen that says the save failed.
    mockRecordPetEvent.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    await typeAndLeave();
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    await waitFor(() => expect(screen.getByDisplayValue("12,5")).toBeOnTheScreen());

    fireEvent.press(submitControl());
    await waitFor(() => expect(screen.getByText("No se pudo guardar")).toBeOnTheScreen());

    await expectStoredDrafts(1);
    expect(screen.getByDisplayValue("12,5")).toBeOnTheScreen();
  });

  it("KEEPS it when the server refused the body", async () => {
    mockRecordPetEvent.mockResolvedValue({ outcome: "api-error", code: "event_date_future" });
    await typeAndLeave();
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    await waitFor(() => expect(screen.getByDisplayValue("12,5")).toBeOnTheScreen());

    fireEvent.press(submitControl());
    await waitFor(() => expect(screen.getByText("No se pudo guardar")).toBeOnTheScreen());

    await expectStoredDrafts(1);
  });

  it("KEEPS it while the same-day gate is still a question", async () => {
    // THE SOFT GATE IS NEITHER A REFUSAL NOR A SUCCESS: nothing was written and
    // the person is one tap from either answer. A draft cleared here would
    // vanish under somebody about to say "no, ya lo había registrado".
    mockRecordPetEvent.mockResolvedValue({
      outcome: "api-error",
      code: "same_day_duplicate_suspected",
    });
    await typeAndLeave();
    render(<RecordEventScreen publicToken={TOKEN} initialKind="weight" />);
    await waitFor(() => expect(screen.getByDisplayValue("12,5")).toBeOnTheScreen());

    fireEvent.press(submitControl());
    await waitFor(() => expect(screen.getByText("¿Registrar otro?")).toBeOnTheScreen());

    await expectStoredDrafts(1);
  });
});

describe("RecordEventScreen — la captura rápida, arriba del menú", () => {
  // Declarado como los dos bloques de arriba: `Alert` ya es un espía para
  // cuando corre el primer caso de este archivo, y un segundo `spyOn` devuelve
  // ese mismo espía en vez de apilar otro.
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});

  beforeEach(() => {
    alert.mockClear();
    mockNav.reset();
  });

  /** Escribir una frase en la caja y pedirle a la app que la lea. */
  function capture(text: string): void {
    fireEvent.changeText(screen.getByLabelText("Contá qué pasó"), text);
    fireEvent.press(screen.getByText("Identificar"));
  }

  it("no reemplaza al menú: la caja está, y las filas siguen estando", () => {
    // LA LISTA ES LA ÚNICA ENUMERACIÓN COMPLETA de lo que se puede escribir, y
    // el matcher no llega a todos los tipos. Una caja que reemplazara al menú
    // dejaría formularios sin puerta.
    render(<RecordEventScreen publicToken={TOKEN} />);

    expect(screen.getByLabelText("Contá qué pasó")).toBeOnTheScreen();
    expect(screen.getByText("Antiparasitario")).toBeOnTheScreen();
    expect(screen.getByText("Terminar una medicación")).toBeOnTheScreen();
  });

  it("muestra lo que entendió y NO abre nada hasta que la persona lo confirma", () => {
    // EL MODO DE FALLAR QUE IMPORTA no es "abrió el formulario equivocado y me
    // di cuenta": es "lo abrió bien llenado, con el valor equivocado, y firmé".
    // Un campo lleno se lee como un campo revisado, y esto asienta en una
    // libreta que no se edita. La tarjeta es el único momento en que se lee la
    // INTERPRETACIÓN de la app en vez de un formulario.
    render(<RecordEventScreen publicToken={TOKEN} />);
    capture("le di la antirrábica hoy");

    expect(screen.getByText("Entendimos esto:")).toBeOnTheScreen();
    expect(screen.getByText(/antirrábica/)).toBeOnTheScreen();
    // Ni el formulario ni su botón: sigue siendo el menú.
    expect(screen.queryByText("Registrar vacuna")).toBeNull();
    expect(screen.getByText("Abrir vacuna")).toBeOnTheScreen();
  });

  it("también pregunta cuando la lectura es floja, en vez de guardársela", () => {
    // Sin umbral: la confianza cambia la FRASE y nunca la acción. Ver
    // `captureConfidenceNote`.
    render(<RecordEventScreen publicToken={TOKEN} />);
    capture("le hicieron una ecografía");

    expect(screen.getByText("No estamos seguros. Revisalo antes de seguir:")).toBeOnTheScreen();
    expect(screen.getByText("Abrir información clínica")).toBeOnTheScreen();
  });

  it("abre el formulario con lo entendido ya puesto", () => {
    render(<RecordEventScreen publicToken={TOKEN} />);
    capture("le di la antirrábica hoy");
    fireEvent.press(screen.getByText("Abrir vacuna"));

    expect(screen.getByDisplayValue("antirrábica")).toBeOnTheScreen();
    expect(screen.getByText("Registrar vacuna")).toBeOnTheScreen();
  });

  it("identifica con la tecla del teclado, sin tocar el botón", () => {
    // El campo es de UNA línea justamente para esto: en uno multilínea esa tecla
    // escribe un salto, que es su trabajo. Es el toque que la caja ahorra.
    render(<RecordEventScreen publicToken={TOKEN} />);
    fireEvent.changeText(screen.getByLabelText("Contá qué pasó"), "pesó 12,5 kilos");
    fireEvent(screen.getByLabelText("Contá qué pasó"), "submitEditing");

    expect(screen.getByText("Abrir peso")).toBeOnTheScreen();
  });

  it("borra la tarjeta apenas cambia el texto que la produjo", () => {
    // Una tarjeta que dice "Vacuna" arriba de un campo que ahora dice otra cosa
    // es el formulario equivocado esperando un toque.
    render(<RecordEventScreen publicToken={TOKEN} />);
    capture("le di la antirrábica hoy");
    fireEvent.changeText(screen.getByLabelText("Contá qué pasó"), "pesó 12,5 kilos");

    expect(screen.queryByText("Abrir vacuna")).toBeNull();
  });

  it("volver de una captura equivocada no pregunta nada", () => {
    // LA RAZÓN POR LA QUE EL PREFILL ENTRA EN EL INICIALIZADOR Y NO EN UN
    // EFECTO. `useIsDirty` compara contra el primer valor que vio: si los campos
    // los puso la app, nadie escribió nada, y preguntar "¿Salir de este
    // asiento?" a quien sólo quiere corregir una lectura equivocada convierte un
    // error de la app en una fricción de la persona.
    render(<RecordEventScreen publicToken={TOKEN} />);
    capture("le di la antirrábica hoy");
    fireEvent.press(screen.getByText("Abrir vacuna"));
    fireEvent.press(screen.getByText("Elegir otro tipo"));

    expect(alert).not.toHaveBeenCalled();
    expect(screen.getByText("¿Qué querés registrar?")).toBeOnTheScreen();
  });

  it("no deja borrador de un formulario que sólo abrió una captura", async () => {
    // La otra mitad de lo mismo: un borrador escrito por una lectura que nadie
    // tocó vuelve días después como "recuperamos lo que estabas escribiendo"
    // sobre un formulario que la persona nunca eligió.
    const { unmount } = render(<RecordEventScreen publicToken={TOKEN} />);
    capture("le di la antirrábica hoy");
    fireEvent.press(screen.getByText("Abrir vacuna"));
    unmount();

    await expectStoredDrafts(0);
  });

  it("no tira la frase que no entendió: la ofrece como nota, tal cual", () => {
    // El peor final posible de una captura es que alguien escriba una oración,
    // la app no la entienda, y la oración desaparezca. Es la misma salida que
    // la caja de la web ofrece.
    render(<RecordEventScreen publicToken={TOKEN} />);
    capture("se portó bárbaro en la plaza");

    expect(screen.getByText("No lo reconocimos")).toBeOnTheScreen();
    fireEvent.press(screen.getByText("Abrir una nota con este texto"));

    expect(screen.getByDisplayValue("se portó bárbaro en la plaza")).toBeOnTheScreen();
    expect(screen.getByText("Guardar la nota")).toBeOnTheScreen();
  });

  it("lo que se hace en otra puerta lo dice, y no abre un formulario", () => {
    // "Terminé el tratamiento" SÍ se reconoce. Contestar "no lo reconocimos"
    // mandaría a la persona a buscar en una lista que no lo tiene.
    render(<RecordEventScreen publicToken={TOKEN} />);
    capture("terminé el tratamiento");

    expect(screen.getByText("Medicación · fin")).toBeOnTheScreen();
    // DOS VECES A PROPÓSITO, y es la afirmación que vale: la frase de la caja es
    // palabra por palabra la del `ListRow` inerte que ya está en el menú. Quien
    // lee una y después va a buscarla tiene que encontrar la misma palabra.
    expect(screen.getAllByText(/Terminar medicación/)).toHaveLength(2);
    expect(screen.queryByText("Confirmar cierre de medicación")).toBeNull();
  });
});

describe("RecordEventScreen — cuando la captura y un borrador quieren el mismo formulario", () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});

  beforeEach(() => {
    alert.mockClear();
  });

  /** Dejar un borrador de Peso a medio escribir y volver por la caja. */
  async function draftThenCapture(): Promise<void> {
    await typeAndLeave("9,4");
    render(<RecordEventScreen publicToken={TOKEN} />);
    fireEvent.changeText(screen.getByLabelText("Contá qué pasó"), "pesó 12,5 kilos");
    fireEvent.press(screen.getByText("Identificar"));
    fireEvent.press(screen.getByText("Abrir peso"));
    await waitFor(() =>
      expect(screen.getByText("Recuperamos lo que estabas escribiendo")).toBeOnTheScreen(),
    );
  }

  it("gana el borrador, porque es lo único de los dos que alguien tipeó", async () => {
    await draftThenCapture();

    expect(screen.getByDisplayValue("9,4")).toBeOnTheScreen();
    expect(screen.queryByDisplayValue("12,5")).toBeNull();
  });

  it("pero lo dice, para que nadie firme un peso viejo creyendo que es el que dijo", async () => {
    // La mitad silenciosa de este problema es peor que la ruidosa: el
    // formulario abierto con un valor VIEJO adentro, después de que la persona
    // acaba de decir otro, a un toque de un asiento que no se puede editar.
    await draftThenCapture();

    expect(screen.getByText(/no se aplicó, para no pisar el borrador/)).toBeOnTheScreen();
  });

  it("descartar el borrador deja los datos de la captura", async () => {
    // Sin una línea de código extra: `discardRestored` devuelve el formulario al
    // valor con el que la pantalla arrancó, y ese valor ES el prefill.
    await draftThenCapture();

    fireEvent.press(screen.getByText("Descartar el borrador"));
    // La frase del diálogo cambia con el comportamiento: acá el formulario NO
    // "empieza de nuevo". Ver `DISCARD_COPY.draftOverCapture`.
    expect(String(alert.mock.calls[0]?.[1])).toContain("lo que acabás de contar");
    const discard = alert.mock.calls[0]?.[2]?.[1];
    act(() => {
      discard?.onPress?.();
    });

    expect(screen.getByDisplayValue("12,5")).toBeOnTheScreen();
    expect(screen.queryByDisplayValue("9,4")).toBeNull();
  });
});
