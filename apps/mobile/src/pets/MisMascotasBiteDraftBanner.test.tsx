// The "Tenés una mordedura sin enviar" banner on "Mis mascotas" (M5 / Re-1,
// PO decision 3) — behaviour through the rendered screen, the same pattern
// `MisMascotasFooter.test.tsx` and `TransfersScreen.test.tsx` use.
//
// WHY THROUGH THE SCREEN AND NOT JUST THE HOOK. The account fence, the
// expiry refusal and the "is there a draft at all" question live in
// `event-draft-store.ts`; whether the screen asks again on every focus lives
// in `app/mascotas/index.tsx`; the CTA's route is built there too. A
// hook-only test could pass while the screen dropped the refresh-on-focus
// call, or wired the button to the wrong route. This exercises all three
// through what a person would actually see and press.
//
// It runs under JEST, same as every other `app/mascotas/index` test.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen } from "@testing-library/react-native";

const mockPush = jest.fn<(path: string) => void>();
const mockFetchMyPets = jest.fn<(...args: unknown[]) => Promise<unknown>>();

/**
 * Every focus callback currently mounted, so a test can fire a RE-focus — the
 * same stand-in `TransfersScreen.test.tsx` uses, and for the same reason: the
 * defect worth catching here is a banner that does not clear on an
 * ALREADY-MOUNTED screen, which a mount-only stand-in can never exercise. A
 * mount IS a first focus, which is what the real hook does too — and it is
 * the ONLY read the bite-draft banner gets, since (unlike the pets list's own
 * `mounted` guard) its `useFocusEffect` has none.
 */
const mockFocusCallbacks: Array<() => void> = [];

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (callback: () => void) => {
    const { useEffect } = require("react");
    useEffect(() => {
      mockFocusCallbacks.push(callback);
      callback();
      return () => {
        const at = mockFocusCallbacks.indexOf(callback);
        if (at >= 0) mockFocusCallbacks.splice(at, 1);
      };
    }, [callback]);
  },
}));

jest.mock("../api/endpoints", () => ({
  fetchMyPets: (...args: unknown[]) => mockFetchMyPets(...args),
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));

jest.mock("../auth/useGate", () => ({ useGate: () => ({ allowed: true }) }));

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";

/** Who the session store says is signed in RIGHT NOW. Reset before every case. */
const mockSession: { userId: string | undefined } = { userId: OWNER };
jest.mock("../auth/session-store", () => ({
  sessionPort: {},
  getSessionState: () =>
    mockSession.userId === undefined
      ? { phase: "signed-out", reason: "user_action" }
      : { phase: "signed-in", user: { id: mockSession.userId } },
}));

import MisMascotasScreen from "../../app/mascotas/index";
import {
  EVENT_DRAFT_MAX_AGE_MS,
  eventDraftKey,
  forgetEventDraft,
  writeEventDraft,
} from "./event-draft-store";
import { emptyDraft } from "./record-event-view-model";

const TOKEN = "DIM-PAMP-0001";
const OTHER_TOKEN = "DIM-PAMP-0002";
const BANNER_TITLE = "Tenés una mordedura sin enviar";
const CTA_LABEL = "Terminar de enviarla";

function emptyList() {
  return {
    outcome: "ok" as const,
    payload: { version: 1, pets: [], total: 0, truncated: false },
  };
}

async function seedBiteDraft(ownerId: string, publicToken: string, savedAt: number): Promise<void> {
  const key = eventDraftKey({ ownerId, publicToken, kind: "bite", sourceEventId: null });
  await writeEventDraft(key, emptyDraft(new Date(savedAt)), savedAt);
}

/** Re-focus every mounted screen, the way popping back to it does. */
async function refocus(): Promise<void> {
  await act(async () => {
    for (const callback of [...mockFocusCallbacks]) callback();
  });
}

describe("the bite-draft banner on Mis mascotas", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    mockPush.mockClear();
    mockFetchMyPets.mockReset();
    mockFetchMyPets.mockResolvedValue(emptyList());
    mockSession.userId = OWNER;
    mockFocusCallbacks.length = 0;
  });

  it("shows the banner while the signed-in account has an unsent bite draft", async () => {
    await seedBiteDraft(OWNER, TOKEN, Date.now());
    render(<MisMascotasScreen />);

    expect(await screen.findByText(BANNER_TITLE)).toBeTruthy();
  });

  it("does not show a draft written by another account", async () => {
    await seedBiteDraft(OTHER_OWNER, TOKEN, Date.now());
    render(<MisMascotasScreen />);

    // Wait for the ready arm to settle before asserting an absence — an
    // absence checked too early would pass for "still loading" too.
    await screen.findByText("Todavía no registraste ninguna mascota");
    expect(screen.queryByText(BANNER_TITLE)).toBeNull();
  });

  it("does not show an expired draft", async () => {
    const savedAt = Date.now() - (EVENT_DRAFT_MAX_AGE_MS + 60_000);
    await seedBiteDraft(OWNER, TOKEN, savedAt);
    render(<MisMascotasScreen />);

    await screen.findByText("Todavía no registraste ninguna mascota");
    expect(screen.queryByText(BANNER_TITLE)).toBeNull();
  });

  it("disappears once the draft is cleared, on the next focus", async () => {
    await seedBiteDraft(OWNER, TOKEN, Date.now());
    render(<MisMascotasScreen />);
    await screen.findByText(BANNER_TITLE);

    const key = eventDraftKey({
      ownerId: OWNER,
      publicToken: TOKEN,
      kind: "bite",
      sourceEventId: null,
    });
    await forgetEventDraft(key);

    await refocus();

    expect(screen.queryByText(BANNER_TITLE)).toBeNull();
  });

  it("picks the MOST RECENT draft when there is more than one", async () => {
    await seedBiteDraft(OWNER, OTHER_TOKEN, Date.now() - 60_000);
    await seedBiteDraft(OWNER, TOKEN, Date.now());
    render(<MisMascotasScreen />);
    await screen.findByText(BANNER_TITLE);

    fireEvent.press(screen.getByText(CTA_LABEL));

    expect(mockPush).toHaveBeenCalledWith(`/mascotas/${TOKEN}/asentar?kind=bite`);
  });

  it("routes the CTA to the bite form, with the pet's token and kind=bite", async () => {
    await seedBiteDraft(OWNER, TOKEN, Date.now());
    render(<MisMascotasScreen />);
    await screen.findByText(BANNER_TITLE);

    fireEvent.press(screen.getByText(CTA_LABEL));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(`/mascotas/${TOKEN}/asentar?kind=bite`);
  });
});
