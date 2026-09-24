// `ClaimScreen` — the render tests for the most consequential act in this app.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. "RECLAMARLA" IS DRAWN ONLY WHEN THE SERVER SAID SO. Not when the variant
//      looks free, not when a name came back — when `canClaim` is true. The
//      dangerous direction is the flattering one: a button over an animal
//      somebody else holds is an interface promising custody of a stranger's
//      dog, and the server would refuse the tap anyway. Asserted BY CONTRADICTION
//      as well as by agreement — a `free` ack carrying `canClaim: false` must
//      draw nothing, which is the case that separates "reads the flag" from
//      "reads the variant and the flag happens to agree".
//   2. THE CLAIM SENDS THE IDENTIFIER AGAIN, NOT A HANDLE FROM THE LOOKUP. The
//      writer re-resolves the animal from the value inside its own transaction;
//      there is no lookup-issued handle to replay, and this screen must not
//      invent one.
//   3. THE SUCCESS NAVIGATES WITH THE WRITER'S TOKEN. The lookup does not carry
//      one for a free animal precisely so this cannot be got wrong.
//   4. A FAILED CALL IS NOT A RESULT. Every non-ok outcome returns to the form
//      with a sentence; none of them silently draws a card.
//   5. THE SCREEN SAYS WHAT IT CANNOT DO. No camera, and no disputa — both are
//      named in the interface with somewhere to go, rather than left as a
//      missing control somebody hunts for.

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";

const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockOpenURL = jest.fn<(url: string) => Promise<unknown>>();

jest.mock("expo-linking", () => ({ openURL: (url: string) => mockOpenURL(url) }));

jest.mock("../api/endpoints", () => ({
  sendPetClaimCommand: (...args: unknown[]) => mockSend(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import type { PetClaimLookupAckV1 } from "@dim/contract/api";

import {
  type ChipScanViewProps,
  resetChipScannerPort,
  setChipScannerPort,
} from "../native/chip-scanner-port";
import { ClaimScreen } from "./ClaimScreen";

const CHIP = "982000123456789";

/**
 * A scan view that records its props, so a test can BE the camera: call
 * `onCode`/`onCancel` exactly as an adapter would, without any native module.
 */
let lastScanProps: ChipScanViewProps | null = null;
function FakeScanView(props: ChipScanViewProps) {
  lastScanProps = props;
  return <Text>cámara-falsa</Text>;
}

/** The camera, as the scan view hands it over. Throws when it is not mounted. */
function cameraProps(): ChipScanViewProps {
  if (lastScanProps === null) throw new Error("the fake scan view is not mounted");
  return lastScanProps;
}

function lookupAck(over: Partial<PetClaimLookupAckV1> = {}): { outcome: "ok"; payload: unknown } {
  return {
    outcome: "ok",
    payload: {
      command: "lookup",
      variant: "free",
      petName: "Rocky",
      petToken: null,
      ownerInitials: null,
      canClaim: true,
      ...over,
    },
  };
}

/** Type the chip and tap Buscar. */
async function search(value = CHIP) {
  fireEvent.changeText(screen.getByLabelText("Número de microchip, obligatorio"), value);
  fireEvent.press(screen.getByText("Buscar"));
  await waitFor(() => expect(mockSend).toHaveBeenCalled());
}

beforeEach(() => {
  mockSend.mockReset();
  mockOpenURL.mockReset();
  lastScanProps = null;
});

afterEach(() => {
  resetChipScannerPort();
});

describe("the ask", () => {
  it("says out loud that the camera is not here, instead of hiding a missing button", () => {
    // Somebody standing in front of a stray is the person this screen is for.
    // Telling them the number goes in by hand beats letting them hunt for a scan
    // control that does not exist in this build.
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    expect(screen.getByText("Todavía no se puede escanear")).toBeTruthy();
  });

  it("refuses a 14-digit microchip locally, without a round trip", async () => {
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    fireEvent.changeText(
      screen.getByLabelText("Número de microchip, obligatorio"),
      "12345678901234",
    );
    fireEvent.press(screen.getByText("Buscar"));

    await waitFor(() => expect(screen.getByText(/15 dígitos/)).toBeTruthy());
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("swaps the field and clears the value when the kind changes", () => {
    // The web's radio clears it too: a tattoo code left under "Microchip" is a
    // value that gets refused for a reason the person did not cause.
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    fireEvent.changeText(screen.getByLabelText("Número de microchip, obligatorio"), CHIP);
    fireEvent.press(screen.getByText("Tatuaje"));

    const field = screen.getByLabelText("Código del tatuaje, obligatorio");
    expect(field.props.value).toBe("");
  });

  it("sends the LOOKUP command with the trimmed identifier", async () => {
    mockSend.mockResolvedValue(lookupAck());
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    await search(`  ${CHIP}  `);

    expect(mockSend.mock.calls[0]?.[1]).toEqual({
      command: "lookup",
      identifierKind: "microchip",
      identifierValue: CHIP,
    });
  });
});

describe("the confirmation card — what a person is allowed to do next", () => {
  it("offers `Reclamarla` when the server said `canClaim`", async () => {
    mockSend.mockResolvedValue(lookupAck({ canClaim: true }));
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    await search();

    await waitFor(() => expect(screen.getByText("Reclamarla")).toBeTruthy());
    expect(screen.getByText(/no tiene dueño\/a registrado\/a/)).toBeTruthy();
  });

  it("draws NO claim button on a `free` ack that says `canClaim: false`", async () => {
    // THE CASE THAT SEPARATES "READS THE FLAG" FROM "READS THE VARIANT". The two
    // agree today; the flag is the authority, and the server re-checks custody
    // inside the claiming transaction under a row lock. A screen that trusted the
    // variant would draw a button the server refuses.
    mockSend.mockResolvedValue(lookupAck({ variant: "free", canClaim: false }));
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    await search();

    await waitFor(() => expect(screen.getByText(/no tiene dueño/)).toBeTruthy());
    expect(screen.queryByText("Reclamarla")).toBeNull();
  });

  it("draws no claim button for an animal somebody already holds, and names the web", async () => {
    mockSend.mockResolvedValue(
      lookupAck({ variant: "active_owner", canClaim: false, ownerInitials: "L.F." }),
    );
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    await search();

    await waitFor(() => expect(screen.getByText(/\(L\.F\.\)/)).toBeTruthy());
    expect(screen.queryByText("Reclamarla")).toBeNull();
    expect(screen.getByText("Iniciar una disputa desde la web")).toBeTruthy();
  });

  it("opens the web claim wizard for the disputa this build cannot run", async () => {
    mockSend.mockResolvedValue(lookupAck({ variant: "active_owner", canClaim: false }));
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    await search();

    await waitFor(() => expect(screen.getByText("Iniciar una disputa desde la web")).toBeTruthy());
    fireEvent.press(screen.getByText("Iniciar una disputa desde la web"));

    expect(mockOpenURL).toHaveBeenCalledTimes(1);
    expect(String(mockOpenURL.mock.calls[0]?.[0])).toContain("/mis-mascotas/reclamar");
  });

  it("sends a lost animal to the avistaje form, with the token the server gave", async () => {
    mockSend.mockResolvedValue(
      lookupAck({ variant: "lost", canClaim: false, petToken: "DIM-PAMP-0001" }),
    );
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    await search();

    await waitFor(() => expect(screen.getByText("Reportar un avistaje")).toBeTruthy());
    fireEvent.press(screen.getByText("Reportar un avistaje"));

    expect(String(mockOpenURL.mock.calls[0]?.[0])).toContain("/p/DIM-PAMP-0001/sighting");
    expect(screen.queryByText("Reclamarla")).toBeNull();
  });

  it("clears the identifier when the person goes back to look for another one", async () => {
    // Parity with the web's "Volver" (it resets the wizard), and the half that
    // is not cosmetic: the value in that field is the evidence that authorizes a
    // claim, and leaving a stranger's chip on screen after "ya tiene dueño/a" is
    // the one number `/p/{token}` refuses to render.
    mockSend.mockResolvedValue(lookupAck({ variant: "active_owner", canClaim: false }));
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    await search();

    await waitFor(() => expect(screen.getByText("Buscar otro identificador")).toBeTruthy());
    fireEvent.press(screen.getByText("Buscar otro identificador"));

    expect(screen.getByLabelText("Número de microchip, obligatorio").props.value).toBe("");
  });

  it("offers nothing at all for a deceased animal", async () => {
    mockSend.mockResolvedValue(lookupAck({ variant: "deceased", canClaim: false, petToken: null }));
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    await search();

    // The exact heading, not `/fallecida/`: the body says the word too, and a
    // regex that matches both would pass on a screen that lost the heading.
    await waitFor(() =>
      expect(screen.getByText("Rocky figura como fallecida en miMAR.")).toBeTruthy(),
    );
    expect(screen.queryByText("Reclamarla")).toBeNull();
    expect(screen.queryByText("Reportar un avistaje")).toBeNull();
    expect(screen.queryByText("Iniciar una disputa desde la web")).toBeNull();
  });
});

describe("the claim", () => {
  it("re-sends the IDENTIFIER, never a handle the lookup issued", async () => {
    // The writer re-resolves the animal from this value inside its own
    // transaction. There is no lookup-issued handle to replay or steal, and this
    // screen must not invent one — see the contract's `pet-claim.ts`.
    mockSend.mockResolvedValue(lookupAck({ canClaim: true }));
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    await search();
    await waitFor(() => expect(screen.getByText("Reclamarla")).toBeTruthy());

    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "claim_free",
        changed: true,
        petToken: "DIM-REAL-TOKN",
        petName: "Rocky",
      },
    });
    fireEvent.press(screen.getByText("Reclamarla"));

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
    expect(mockSend.mock.calls[1]?.[1]).toEqual({
      command: "claim_free",
      identifierKind: "microchip",
      identifierValue: CHIP,
    });
  });

  it("navigates with the token the WRITER resolved", async () => {
    const onOpenPet = jest.fn();
    mockSend.mockResolvedValue(lookupAck({ canClaim: true }));
    render(<ClaimScreen onOpenPet={onOpenPet} />);
    await search();
    await waitFor(() => expect(screen.getByText("Reclamarla")).toBeTruthy());

    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "claim_free",
        changed: true,
        petToken: "DIM-REAL-TOKN",
        petName: "Rocky",
      },
    });
    fireEvent.press(screen.getByText("Reclamarla"));

    await waitFor(() => expect(screen.getByText("Ver a Rocky")).toBeTruthy());
    fireEvent.press(screen.getByText("Ver a Rocky"));
    expect(onOpenPet).toHaveBeenCalledWith("DIM-REAL-TOKN");
  });
});

describe("the failures", () => {
  it("returns to the form with a sentence, and never draws a card, on a refusal", async () => {
    // `claim_not_claimable` is what a replay looks like AND what "somebody else
    // got there first" looks like. Either way the person still holds the number
    // and the next thing they will do is look again.
    mockSend.mockResolvedValue({
      outcome: "api-error",
      code: "claim_not_claimable",
      retryAfterSeconds: null,
    });
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    await search();

    await waitFor(() => expect(screen.getByText(/ya no se puede reclamar/)).toBeTruthy());
    expect(screen.getByText("Buscar")).toBeTruthy();
    expect(screen.queryByText("Reclamarla")).toBeNull();
  });

  it("does not blame the connection for a body it could not parse", async () => {
    mockSend.mockResolvedValue({ outcome: "malformed", detail: "bad json" });
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    await search();

    await waitFor(() =>
      expect(screen.getByText("La respuesta del servidor no se pudo leer.")).toBeTruthy(),
    );
  });

  it("says the connection failed when it did", async () => {
    mockSend.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    await search();

    await waitFor(() => expect(screen.getByText(/Revisá tu conexión/)).toBeTruthy());
  });
});

describe("the scanner behind the seam", () => {
  it("offers no scan control when the module is missing — the callout instead", () => {
    // The default port. The seam makes the missing camera unrepresentable as a
    // mountable control, and this screen must not invent a button over it.
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    expect(screen.queryByText("Escanear el chip")).toBeNull();
    expect(screen.getByText("Todavía no se puede escanear")).toBeTruthy();
  });

  it("offers the scan when the seam carries a view, and drops the hand-typed callout", () => {
    setChipScannerPort({ name: "fake", ScanView: FakeScanView });
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    expect(screen.getByText("Escanear el chip")).toBeTruthy();
    // The callout says the number goes in by hand BECAUSE this build cannot
    // scan. With a camera on board it would be false, so it goes.
    expect(screen.queryByText("Todavía no se puede escanear")).toBeNull();
  });

  it("offers no scan under Tatuaje, even with a camera on board", () => {
    // A tattoo is letters on skin, not a barcode. The control would promise a
    // read that cannot happen.
    setChipScannerPort({ name: "fake", ScanView: FakeScanView });
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    fireEvent.press(screen.getByText("Tatuaje"));
    expect(screen.queryByText("Escanear el chip")).toBeNull();
  });

  it("a scan fills the SAME field the keyboard writes, normalized, and runs nothing", () => {
    setChipScannerPort({ name: "fake", ScanView: FakeScanView });
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    fireEvent.press(screen.getByText("Escanear el chip"));
    expect(screen.getByText("cámara-falsa")).toBeTruthy();

    act(() => cameraProps().onCode("982 000 123 456 789"));

    // Back on the form, with the digits where the keyboard would have put them.
    expect(screen.queryByText("cámara-falsa")).toBeNull();
    expect(screen.getByLabelText("Número de microchip, obligatorio").props.value).toBe(CHIP);
    // A scan is an input method, not a command: NOTHING was sent. The person
    // still reads the number the camera read and still taps Buscar.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("a scanned chip flows into the SAME lookup the keyboard feeds", async () => {
    setChipScannerPort({ name: "fake", ScanView: FakeScanView });
    mockSend.mockResolvedValue(lookupAck());
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    fireEvent.press(screen.getByText("Escanear el chip"));
    act(() => cameraProps().onCode(CHIP));

    fireEvent.press(screen.getByText("Buscar"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend.mock.calls[0]?.[1]).toEqual({
      command: "lookup",
      identifierKind: "microchip",
      identifierValue: CHIP,
    });
  });

  it("a barcode that is not a chip leaves the field alone and says so", () => {
    setChipScannerPort({ name: "fake", ScanView: FakeScanView });
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    fireEvent.changeText(screen.getByLabelText("Número de microchip, obligatorio"), "98200");
    fireEvent.press(screen.getByText("Escanear el chip"));

    // The sticker's OTHER barcode — a lot number. The field keeps what the
    // person had typed; planting the wrong read would be worse than the miss.
    act(() => cameraProps().onCode("LOT-2026-08-A"));

    expect(screen.getByLabelText("Número de microchip, obligatorio").props.value).toBe("98200");
    expect(screen.getByText(/no es un número de microchip/)).toBeTruthy();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("backing out of the camera returns to the form unchanged", () => {
    setChipScannerPort({ name: "fake", ScanView: FakeScanView });
    render(<ClaimScreen onOpenPet={jest.fn()} />);
    fireEvent.changeText(screen.getByLabelText("Número de microchip, obligatorio"), CHIP);
    fireEvent.press(screen.getByText("Escanear el chip"));

    act(() => cameraProps().onCancel());

    expect(screen.getByLabelText("Número de microchip, obligatorio").props.value).toBe(CHIP);
    expect(screen.queryByText(/no es un número de microchip/)).toBeNull();
  });
});
