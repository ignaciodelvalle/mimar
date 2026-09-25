// The native privacidad screen — the two Ley 25.326 rights, from the phone.
//
// WHAT THESE CASES STAND IN FOR
// ---------------------------------------------------------------------------
// Every one of them is a way this screen could be wrong that nothing else in the
// app would notice, and three of them are ways it could be wrong AND still look
// right to whoever built it:
//
//   · the destructive button live before the motivo is usable → somebody taps
//     "Confirmar borrado" with "no" in the box, the server refuses, and the
//     screen has taught them that the red button is a suggestion;
//   · the confirm button on screen with no disclosure step in front of it → the
//     irreversible control sits under a thumb aiming at "Pedir mis datos";
//   · a failed erasure that clears the form or navigates → the person is left
//     unable to tell whether their account still exists;
//   · the export's VALUES painted onto the screen → the summary stops being a
//     table of contents and becomes a second rendering of the PII it decided
//     not to render.
//
// The store is mocked at `session-store`, not at the endpoint: what this screen
// owes the user is that pressing the red button runs the one function that both
// erases AND drops the session. Mocking one layer deeper would let a version
// that called the endpoint directly — and left the keychain holding a token for
// a deleted account — pass every case here.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockFetchExport = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockEraseAccount = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("../api/endpoints", () => ({
  fetchMySubjectDataExport: (...args: unknown[]) => mockFetchExport(...args),
}));

jest.mock("../auth/session-store", () => ({
  eraseAccount: (...args: unknown[]) => mockEraseAccount(...args),
  sessionPort: { accessToken: async () => "t" },
}));

// The file modules are the global spies from jest.setup.js (M13). The export
// now leaves as a FILE: `__written` is the in-memory file system's record of
// what was written where, so the case below can prove the bytes on disk are the
// export itself.
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";

import { PrivacyScreen } from "./PrivacyScreen";

const shareAsync = Sharing.shareAsync as unknown as jest.Mock<
  (uri: string, options?: unknown) => Promise<void>
>;
const isAvailableAsync = Sharing.isAvailableAsync as unknown as jest.Mock<() => Promise<boolean>>;
const written = () => (FileSystem as unknown as { __written: Map<string, string> }).__written;

const READY_EXPORT = {
  payloadVersion: 1 as const,
  issuedAt: "2026-08-29T12:00:00.000Z",
  staleAfter: "2026-08-29T12:00:00.000Z",
  subject: { schema_version: 5, pets: [{}, {}], dni_last4: "4821" },
};

beforeEach(() => {
  mockFetchExport.mockReset();
  mockEraseAccount.mockReset();
  shareAsync.mockClear();
  shareAsync.mockResolvedValue(undefined);
  isAvailableAsync.mockResolvedValue(true);
  written().clear();
});

describe("art. 14 — descargar mis datos", () => {
  it("does not call the endpoint until the person asks", () => {
    // A screen that fetched on mount would mint a full PII export — and spend
    // the tightest budget on this project — for anybody who merely opened
    // ajustes and scrolled.
    render(<PrivacyScreen />);

    expect(mockFetchExport).not.toHaveBeenCalled();
  });

  it("draws the file's SHAPE, and none of its values", () => {
    mockFetchExport.mockResolvedValue({ outcome: "ok", payload: READY_EXPORT });
    render(<PrivacyScreen />);

    fireEvent.press(screen.getByText("Pedir mis datos"));

    return waitFor(() => {
      // PO decision 13A: a human Spanish label, not the raw "pets" key.
      expect(screen.getByText("Tus mascotas")).toBeTruthy();
      expect(screen.getByText("2 registros")).toBeTruthy();
      // The scalar is reported as present and NEVER printed.
      expect(screen.queryByText("4821")).toBeNull();
    });
  });

  it("never shows a raw developer key, on a fixture shaped like the real export", () => {
    // PO decision 13A's own complaint, pinned: "Operator feed watermarks",
    // "Push targets", "Audit log", "Subject user id" reaching the screen
    // verbatim. This fixture carries one of each family — a hidden watermark,
    // a kept-but-relabeled technical section, and envelope metadata — plus an
    // unrecognised key that must still show, generically labeled.
    const SHAPED_EXPORT = {
      payloadVersion: 1 as const,
      issuedAt: "2026-09-23T12:00:00.000Z",
      staleAfter: "2026-09-23T12:00:00.000Z",
      subject: {
        pets: [{}],
        push_targets: [{ device_id: "abc" }],
        audit_log: [{ action: "subject_data_exported" }],
        operator_feed_watermarks: [{ surface: "novedades" }],
        subject_user_id: "11111111-1111-1111-1111-111111111111",
        schema_version: 5,
        una_tabla_que_no_existia: [{}],
      },
    };
    mockFetchExport.mockResolvedValue({ outcome: "ok", payload: SHAPED_EXPORT });
    render(<PrivacyScreen />);

    fireEvent.press(screen.getByText("Pedir mis datos"));

    return waitFor(() => {
      expect(screen.getByText("Tus mascotas")).toBeTruthy();
      expect(screen.getByText("Avisos activados (celular)")).toBeTruthy();
      expect(screen.getByText("Historial de tus acciones")).toBeTruthy();
      expect(screen.getByText("Otros datos")).toBeTruthy();

      // No raw snake_case key, and no lightly-unshouted version of one, ever
      // reaches the screen.
      for (const rawLeak of [
        "operator_feed_watermarks",
        "Operator feed watermarks",
        "push_targets",
        "Push targets",
        "audit_log",
        "Audit log",
        "subject_user_id",
        "Subject user id",
        "schema_version",
        "una_tabla_que_no_existia",
      ]) {
        expect(screen.queryByText(rawLeak)).toBeNull();
      }
    });
  });

  async function openFileSheet() {
    mockFetchExport.mockResolvedValue({ outcome: "ok", payload: READY_EXPORT });
    render(<PrivacyScreen />);
    fireEvent.press(screen.getByText("Pedir mis datos"));
    await waitFor(() => expect(screen.getByText("Guardar o compartir el archivo")).toBeTruthy());
    fireEvent.press(screen.getByText("Guardar o compartir el archivo"));
  }

  it("writes the raw JSON to a dated .json FILE and hands that file to the sheet", async () => {
    await openFileSheet();

    await waitFor(() => expect(shareAsync).toHaveBeenCalledTimes(1));
    const [uri, options] = shareAsync.mock.calls[0] as [string, { mimeType: string }];
    expect(uri).toBe("file:///cache/mimar-mis-datos-2026-08-29.json");
    expect(options.mimeType).toBe("application/json");
    // The bytes on disk are the export, unaltered — not a message, not a summary.
    expect(written().get(uri)).toBe(JSON.stringify(READY_EXPORT.subject, null, 2));
  });

  it("says, after the sheet closes, that closing it without a choice saved nothing", async () => {
    // The sheet cannot tell a saved file from a dismissed one; the screen must
    // not stay silent (the old Share.share path lost the export without a word).
    await openFileSheet();

    await waitFor(() => {
      expect(screen.getByText(/el archivo no se guardó/)).toBeTruthy();
    });
    // And the way back is still there.
    expect(screen.getByText("Guardar o compartir el archivo")).toBeTruthy();
  });

  it("says so when the phone has nowhere to send a file", async () => {
    isAvailableAsync.mockResolvedValue(false);
    await openFileSheet();

    await waitFor(() => {
      expect(screen.getByText(/no tiene ninguna app para guardar o compartir/)).toBeTruthy();
    });
    expect(shareAsync).not.toHaveBeenCalled();
  });

  it("reports a failed hand-over as a failure, not as a closed sheet", async () => {
    shareAsync.mockRejectedValue(new Error("activity gone"));
    await openFileSheet();

    await waitFor(() => {
      expect(screen.getByText("No pudimos preparar el archivo. Probá de nuevo.")).toBeTruthy();
    });
    expect(screen.queryByText(/el archivo no se guardó/)).toBeNull();
  });

  it("says why it failed instead of leaving the button spinning", async () => {
    mockFetchExport.mockResolvedValue({ outcome: "unreachable" });
    render(<PrivacyScreen />);

    fireEvent.press(screen.getByText("Pedir mis datos"));

    await waitFor(() => {
      expect(screen.getByText("No pudimos conectarnos. Revisá tu conexión.")).toBeTruthy();
    });
  });
});

describe("art. 16 — eliminar mi cuenta", () => {
  it("keeps the destructive control behind a disclosure step", () => {
    // The mutation this catches: rendering the motivo field and "Confirmar
    // borrado" straight away. The irreversible control would then sit on the
    // first paint of a screen people open to download a file.
    render(<PrivacyScreen />);

    expect(screen.getByText("Quiero eliminar mi cuenta")).toBeTruthy();
    expect(screen.queryByText("Confirmar borrado")).toBeNull();
  });

  it("says the supresión is definitive, in those words", () => {
    render(<PrivacyScreen />);

    expect(screen.getByText(/No hay forma de deshacerlo/)).toBeTruthy();
  });

  it("names what SURVIVES it, rather than implying everything goes", () => {
    render(<PrivacyScreen />);

    expect(screen.getByText(/se conservan como historial de salud del animal/)).toBeTruthy();
  });

  it("refuses to run with a motivo under the contract's minimum", () => {
    // The mutation this catches: dropping the `reasonUsable` guard on the
    // button. The server would refuse anyway — with `erasure_reason_required` —
    // but a live red button that answers with an error is how a person learns
    // that the destructive control is negotiable.
    render(<PrivacyScreen />);
    fireEvent.press(screen.getByText("Quiero eliminar mi cuenta"));
    fireEvent.changeText(screen.getByLabelText("Motivo, obligatorio"), "no");

    fireEvent.press(screen.getByText("Confirmar borrado"));

    expect(mockEraseAccount).not.toHaveBeenCalled();
  });

  it("runs the store's erase — the one call that also drops the session", async () => {
    mockEraseAccount.mockResolvedValue({ ok: true });
    render(<PrivacyScreen />);
    fireEvent.press(screen.getByText("Quiero eliminar mi cuenta"));
    fireEvent.changeText(screen.getByLabelText("Motivo, obligatorio"), "ya no uso miMAR");

    fireEvent.press(screen.getByText("Confirmar borrado"));

    // THE SECOND ARGUMENT IS THIS SCREEN'S OWN PATH, and it is not decoration:
    // the gate suppresses the sign-in `next` parameter for the screen a
    // deliberate end happened on, and only that one. Passing nothing — or
    // passing somebody else's path — would either resurrect this screen at the
    // next sign-in or swallow the destination of a deep link tapped afterwards.
    await waitFor(() =>
      expect(mockEraseAccount).toHaveBeenCalledWith("ya no uso miMAR", "/cuenta/privacidad"),
    );
  });

  it("keeps the person on the form when the erasure is refused, and says why", async () => {
    mockEraseAccount.mockResolvedValue({ ok: false, message: "No pudimos completar la baja." });
    render(<PrivacyScreen />);
    fireEvent.press(screen.getByText("Quiero eliminar mi cuenta"));
    fireEvent.changeText(screen.getByLabelText("Motivo, obligatorio"), "ya no uso miMAR");

    fireEvent.press(screen.getByText("Confirmar borrado"));

    await waitFor(() => {
      expect(screen.getByText("No pudimos completar la baja.")).toBeTruthy();
      // The motivo survives the refusal — retyping it is not part of the price.
      expect(screen.getByLabelText("Motivo, obligatorio").props.value).toBe("ya no uso miMAR");
    });
  });

  it("cancelling clears the motivo and puts the disclosure step back", () => {
    render(<PrivacyScreen />);
    fireEvent.press(screen.getByText("Quiero eliminar mi cuenta"));
    fireEvent.changeText(screen.getByLabelText("Motivo, obligatorio"), "ya no uso miMAR");

    fireEvent.press(screen.getByText("Cancelar"));

    expect(screen.getByText("Quiero eliminar mi cuenta")).toBeTruthy();
    expect(screen.queryByText("Confirmar borrado")).toBeNull();
  });
});
