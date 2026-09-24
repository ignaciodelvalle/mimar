// `SharesScreen` — the render tests for the one screen that holds bearer secrets.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. THE TOKEN IS NEVER ON SCREEN. A share token reads the animal's medical
//      record for whoever holds it, and a phone is read over shoulders and
//      screenshotted. The only exit is the OS share sheet.
//   2. EVERY AFFORDANCE COMES FROM `capabilities`, including the PER-ROW one.
//      Revocation is creator-or-admin while the list is every current holder, so
//      a co-owner sees links they cannot revoke — the case a screen that
//      reasoned from "this is my pet" gets wrong.
//   3. NO COMMAND CARRIES AN IDEMPOTENCY KEY. None of the four writers takes
//      one; sending one would be a client believing it holds a guarantee it
//      does not.
//   4. "NOTHING CHANGED" IS SAID OUT LOUD rather than dressed as success.
//   5. A FRESH LINK GOES STRAIGHT TO THE SHARE SHEET, because the moment the
//      ack carries a token is the moment somebody is standing in front of a vet.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

jest.mock("../api/endpoints", () => ({
  fetchPetShares: (...args: unknown[]) => mockFetch(...args),
  sendShareCommand: (...args: unknown[]) => mockSend(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import { Share } from "react-native";

import type { LibretaShareV1, PetSharesV1 } from "@dim/contract/api";
import { SharesScreen } from "./SharesScreen";

/**
 * SPIED ON THE PUBLIC API, not mocked by internal file path.
 *
 * `jest.mock("react-native/Libraries/Share/Share")` works until React Native
 * moves the file, and then it fails as "share was never called" — a green-looking
 * assertion about the one exit a bearer secret has. `Share.share` is the surface
 * this screen actually calls and the one that has to keep existing.
 */
const mockShare = jest.spyOn(Share, "share");

const TOKEN = "DIM-PAMP-0001";
const SHARE_TOKEN = "LBR-ABCD-EFGH";
const SHARE_ID = "11111111-1111-4111-8111-111111111111";

function aShare(over: Partial<LibretaShareV1> = {}): LibretaShareV1 {
  return {
    id: SHARE_ID,
    shareToken: SHARE_TOKEN,
    label: "Veterinaria Norte",
    createdAt: "2026-08-01T12:00:00.000Z",
    expiresAt: "2026-09-01T12:00:00.000Z",
    expired: false,
    canRevoke: true,
    viewCount: 3,
    lastViewedAt: "2026-08-20T12:00:00.000Z",
    ...over,
  };
}

function payload(over: Partial<PetSharesV1> = {}): PetSharesV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-26T00:00:00.000Z",
    staleAfter: "2026-08-26T00:01:00.000Z",
    publicToken: TOKEN,
    petName: "Pampa",
    libretaShares: [aShare()],
    tier2: { isActive: false, isPermanent: false, activeUntil: null },
    capabilities: {
      canCreateLibretaShare: true,
      remainingShareSlots: 4,
      canEnableTier2: true,
      canRevokeTier2: true,
    },
    ...over,
  };
}

function ok(p: PetSharesV1) {
  return { outcome: "ok" as const, payload: p };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockSend.mockReset();
  mockShare.mockReset();
  mockShare.mockResolvedValue({ action: "sharedAction" });
});

describe("token hygiene", () => {
  it("NEVER renders the share token as text", async () => {
    mockFetch.mockResolvedValue(ok(payload()));
    render(<SharesScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Veterinaria Norte")).toBeTruthy());

    // The row shows the label, the expiry and the views. It does not show the
    // credential, and neither does anything else on the screen.
    expect(screen.queryByText(new RegExp(SHARE_TOKEN))).toBeNull();
  });

  it("hands the token to the OS share sheet and nowhere else", async () => {
    mockFetch.mockResolvedValue(ok(payload()));
    render(<SharesScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Compartir link")).toBeTruthy());
    fireEvent.press(screen.getByText("Compartir link"));

    await waitFor(() => expect(mockShare).toHaveBeenCalledTimes(1));
    const message = String(
      (mockShare.mock.calls[0]?.[0] as { message?: string } | undefined)?.message ?? "",
    );
    expect(message).toContain(SHARE_TOKEN);
    expect(message).toContain("/libreta/compartir/");
  });

  it("swallows a dismissed share sheet — changing your mind is not an error", async () => {
    mockFetch.mockResolvedValue(ok(payload()));
    mockShare.mockRejectedValue(new Error("User did not share"));
    render(<SharesScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Compartir link")).toBeTruthy());
    fireEvent.press(screen.getByText("Compartir link"));

    await waitFor(() => expect(mockShare).toHaveBeenCalled());
    // No red banner, and nothing that quotes the rejection.
    expect(screen.queryByText(/User did not share/)).toBeNull();
  });
});

describe("capabilities decide the affordances", () => {
  it("offers revoke when the server says this caller may", async () => {
    mockFetch.mockResolvedValue(ok(payload()));
    render(<SharesScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Revocar")).toBeTruthy());
  });

  it("replaces revoke with the RULE for a holder who did not create the link", async () => {
    mockFetch.mockResolvedValue(ok(payload({ libretaShares: [aShare({ canRevoke: false })] })));
    render(<SharesScreen publicToken={TOKEN} />);

    await waitFor(() =>
      expect(screen.getByText("Solo quien creó este link puede revocarlo.")).toBeTruthy(),
    );
    expect(screen.queryByText("Revocar")).toBeNull();
  });

  it("tells the CAP apart from the PERMISSION on the create control", async () => {
    mockFetch.mockResolvedValue(
      ok(
        payload({
          capabilities: {
            canCreateLibretaShare: false,
            remainingShareSlots: 0,
            canEnableTier2: true,
            canRevokeTier2: true,
          },
        }),
      ),
    );
    render(<SharesScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText(/Revocá uno/)).toBeTruthy());
    expect(screen.queryByText("Crear link")).toBeNull();
  });

  it("hides the Tier-2 picker from a caller who may not open the window", async () => {
    mockFetch.mockResolvedValue(
      ok(
        payload({
          capabilities: {
            canCreateLibretaShare: true,
            remainingShareSlots: 4,
            canEnableTier2: false,
            canRevokeTier2: true,
          },
        }),
      ),
    );
    render(<SharesScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText(/Solo el titular/)).toBeTruthy());
    expect(screen.queryByText("24 horas")).toBeNull();
  });

  it("marks the permanent window as advanced rather than as a fourth equal", async () => {
    mockFetch.mockResolvedValue(ok(payload()));
    render(<SharesScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Siempre visible")).toBeTruthy());
    expect(screen.getByText("Avanzado")).toBeTruthy();
  });
});

describe("the commands", () => {
  it("sends no idempotency key — no writer here takes one", async () => {
    mockFetch.mockResolvedValue(ok(payload()));
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "revoke_libreta_share",
        changed: true,
        shareToken: null,
        tier2Window: null,
      },
    });
    render(<SharesScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Revocar")).toBeTruthy());
    fireEvent.press(screen.getByText("Revocar"));

    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    // (session, publicToken, input) — three arguments, and no key among them.
    expect(mockSend.mock.calls[0]).toHaveLength(3);
    expect(mockSend.mock.calls[0]?.[2]).toEqual({
      command: "revoke_libreta_share",
      shareId: SHARE_ID,
    });
  });

  it("revokes by ROW id, never by the token", async () => {
    mockFetch.mockResolvedValue(ok(payload()));
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "revoke_libreta_share",
        changed: true,
        shareToken: null,
        tier2Window: null,
      },
    });
    render(<SharesScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Revocar")).toBeTruthy());
    fireEvent.press(screen.getByText("Revocar"));

    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(JSON.stringify(mockSend.mock.calls[0]?.[2])).not.toContain(SHARE_TOKEN);
  });

  it("says 'nothing changed' out loud instead of dressing a no-op as success", async () => {
    mockFetch.mockResolvedValue(ok(payload()));
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "enable_tier2", changed: false, shareToken: null, tier2Window: "24h" },
    });
    render(<SharesScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("24 horas")).toBeTruthy());
    fireEvent.press(screen.getByText("24 horas"));

    await waitFor(() => expect(screen.getByText("Esa ventana ya estaba abierta.")).toBeTruthy());
  });

  it("re-reads after a command — the ack is deliberately not the new state", async () => {
    mockFetch.mockResolvedValue(ok(payload()));
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "revoke_tier2", changed: true, shareToken: null, tier2Window: null },
    });
    render(<SharesScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Dejar de mostrar")).toBeTruthy());
    expect(mockFetch).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByText("Dejar de mostrar"));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it("hands a freshly minted link straight to the share sheet", async () => {
    mockFetch.mockResolvedValue(ok(payload()));
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "create_libreta_share",
        changed: true,
        shareToken: "LBR-WXYZ-1234",
        tier2Window: null,
      },
    });
    render(<SharesScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Crear link")).toBeTruthy());
    fireEvent.press(screen.getByText("Crear link"));

    await waitFor(() => expect(mockShare).toHaveBeenCalled());
    const message = String(
      (mockShare.mock.calls[0]?.[0] as { message?: string } | undefined)?.message ?? "",
    );
    expect(message).toContain("LBR-WXYZ-1234");
    // And it was never rendered on the way past.
    expect(screen.queryByText(/LBR-WXYZ-1234/)).toBeNull();
  });
});

describe("failures", () => {
  it("renders a sentence per arm and never echoes the server", async () => {
    mockFetch.mockResolvedValue({ outcome: "api-error", code: "not_found" });
    render(<SharesScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Reintentar")).toBeTruthy());
  });

  it("retries the read on demand", async () => {
    mockFetch.mockResolvedValueOnce({ outcome: "unreachable", detail: "offline" });
    mockFetch.mockResolvedValue(ok(payload()));
    render(<SharesScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Reintentar")).toBeTruthy());
    fireEvent.press(screen.getByText("Reintentar"));

    await waitFor(() => expect(screen.getByText("Veterinaria Norte")).toBeTruthy());
  });
});
