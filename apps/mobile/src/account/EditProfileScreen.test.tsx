// "Editar mis datos" — the first native screen that writes a person's own row.
//
// WHAT THESE CASES STAND IN FOR
// ---------------------------------------------------------------------------
//   · a form that does not re-read after saving → the writer trims the display
//     name, so the field keeps showing what was typed while the server holds
//     something else, and the next save posts the untrimmed value again;
//   · a save button live on a two-character name → the server refuses with
//     `invalid_request` and the person is told their request was malformed,
//     about a field their own screen could have flagged;
//   · a phone warning that BLOCKS → the server accepts older landlines,
//     satellite numbers and foreign numbers by explicit decision
//     (`update-profile.ts`), and a native form refusing them would be inventing
//     a rule on behalf of somebody in Salta;
//   · a failure that renders nothing → a blank where an explanation should be.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";

import { createNavigationFake } from "../ui/navigation-fake";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSave = jest.fn<(...args: unknown[]) => Promise<unknown>>();

// A REAL LISTENER REGISTRY — a stable object and a working unsubscribe. See
// `ui/navigation-fake.ts`; the screen had no `expo-router` mock at all before
// the discard guard, so this is also what keeps `useNavigation` resolvable.
const mockNav = createNavigationFake();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useNavigation: () => mockNav.navigation,
}));

jest.mock("../api/endpoints", () => ({
  fetchMyProfile: (...args: unknown[]) => mockFetch(...args),
  saveMyProfile: (...args: unknown[]) => mockSave(...args),
}));

jest.mock("../auth/session-store", () => ({
  sessionPort: { accessToken: async () => "t" },
}));

import { EditProfileScreen } from "./EditProfileScreen";

const STORED = {
  displayName: "Lucía",
  phone: "+54 9 11 1234-5678",
  preferredVetName: "Vet Bariloche",
  preferredVetPhone: "",
  emergencyContactName: "",
  emergencyContactPhone: "",
};

function payload(profile: typeof STORED = STORED) {
  return {
    outcome: "ok",
    payload: {
      payloadVersion: 1,
      issuedAt: "2026-08-29T12:00:00.000Z",
      staleAfter: "2026-08-29T12:01:00.000Z",
      profile,
    },
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockSave.mockReset();
  mockFetch.mockResolvedValue(payload());
  mockSave.mockResolvedValue({ outcome: "ok", payload: { saved: true } });
});

describe("loading", () => {
  it("pre-fills every field from the server", async () => {
    render(<EditProfileScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText("Nombre, obligatorio").props.value).toBe("Lucía");
      expect(screen.getByLabelText("Teléfono").props.value).toBe("+54 9 11 1234-5678");
      expect(screen.getByLabelText("Veterinaria de cabecera").props.value).toBe("Vet Bariloche");
    });
  });

  it("says why it failed, with a way back in", async () => {
    mockFetch.mockResolvedValue({ outcome: "unreachable" });
    render(<EditProfileScreen />);

    await waitFor(() => {
      expect(screen.getByText("No pudimos conectarnos. Revisá tu conexión.")).toBeTruthy();
      expect(screen.getByText("Reintentar")).toBeTruthy();
    });
  });
});

describe("the discard guard (A2-alta-asentar-08)", () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});

  beforeEach(() => {
    alert.mockClear();
    mockNav.reset();
  });

  it("does NOT ask anything of somebody who only opened the screen", async () => {
    render(<EditProfileScreen />);
    await screen.findByDisplayValue("Lucía");
    expect(mockNav.pressBack().blocked).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("asks before the back gesture discards an edited field", async () => {
    render(<EditProfileScreen />);
    fireEvent.changeText(await screen.findByDisplayValue("Lucía"), "Lucía Pérez");

    expect(mockNav.pressBack().blocked).toBe(true);
    expect(alert.mock.calls[0]?.[0]).toBe("¿Salir sin guardar?");
  });

  it("goes back to CLEAN once the save landed and the form was re-seeded", async () => {
    // The baseline is the SERVER'S payload rather than the value at mount, and
    // this screen is where that matters most: `load` re-seeds the draft after
    // every save because the writer TRIMS `displayName`, so the field ends up
    // saying what was stored. A guard keyed to the mount value would go on
    // asking about an edit that is already on the server.
    render(<EditProfileScreen />);
    fireEvent.changeText(await screen.findByDisplayValue("Lucía"), "Lucía Pérez");
    mockFetch.mockResolvedValue(payload({ ...STORED, displayName: "Lucía Pérez" }));
    fireEvent.press(screen.getByText("Guardar cambios"));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    expect(mockNav.pressBack().blocked).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("is CLEAN after a save that landed even when the re-read could not confirm it", async () => {
    // FINDING F1, review 2026-09-07. The case above uses a re-read that WORKED,
    // and every screen passes that one. This is the one that hurts: one bar of
    // signal, the write lands, the reload does not.
    //
    // `reloadFailed` keeps the PRE-SAVE payload on an outage — correctly; the
    // alternative is a full-screen error over a save that succeeded — so a guard
    // that compares the draft against `state.view` finds the OLD name there and
    // blocks the back gesture with "Lo que escribiste hasta acá se pierde." over
    // a value that is already on the server.
    render(<EditProfileScreen />);
    fireEvent.changeText(await screen.findByDisplayValue("Lucía"), "Lucía Pérez");
    mockFetch.mockResolvedValue({ outcome: "unreachable" });
    fireEvent.press(screen.getByText("Guardar cambios"));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    // The save landed and the screen says so; only the confirming read failed.
    expect(screen.getByText("Tus datos fueron actualizados.")).toBeTruthy();
    expect(screen.getByDisplayValue("Lucía Pérez")).toBeTruthy();

    expect(mockNav.pressBack().blocked).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("goes dirty again when somebody keeps typing after that failed re-read", async () => {
    // The control that keeps the latch from being a blanket "never ask again":
    // it is the baseline, not an off switch. An edit made AFTER the save still
    // has to stop the back gesture.
    render(<EditProfileScreen />);
    fireEvent.changeText(await screen.findByDisplayValue("Lucía"), "Lucía Pérez");
    mockFetch.mockResolvedValue({ outcome: "unreachable" });
    fireEvent.press(screen.getByText("Guardar cambios"));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    fireEvent.changeText(screen.getByDisplayValue("Lucía Pérez"), "Lucía Pérez Gómez");

    expect(mockNav.pressBack().blocked).toBe(true);
    expect(alert.mock.calls[0]?.[0]).toBe("¿Salir sin guardar?");
  });
});

describe("saving", () => {
  it("posts all six fields, with the empties intact", async () => {
    render(<EditProfileScreen />);
    await waitFor(() => expect(screen.getByText("Guardar cambios")).toBeTruthy());

    fireEvent.press(screen.getByText("Guardar cambios"));

    await waitFor(() => {
      const [, input] = mockSave.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(Object.keys(input).sort()).toEqual([
        "displayName",
        "emergencyContactName",
        "emergencyContactPhone",
        "phone",
        "preferredVetName",
        "preferredVetPhone",
      ]);
      expect(input.preferredVetPhone).toBe("");
    });
  });

  it("RE-READS after a save rather than trusting the draft", async () => {
    // The mutation this catches: dropping the reload. The writer trims the
    // display name, so a form that kept its own state would go on showing
    // "  Lucía  " while the server holds "Lucía" — and would post the untrimmed
    // value again on the next save.
    render(<EditProfileScreen />);
    await waitFor(() => expect(screen.getByText("Guardar cambios")).toBeTruthy());
    expect(mockFetch).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByText("Guardar cambios"));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it("says so when it worked", async () => {
    render(<EditProfileScreen />);
    await waitFor(() => expect(screen.getByText("Guardar cambios")).toBeTruthy());

    fireEvent.press(screen.getByText("Guardar cambios"));

    await waitFor(() => expect(screen.getByText("Tus datos fueron actualizados.")).toBeTruthy());
  });

  it("renders the server's refusal instead of a blank", async () => {
    mockSave.mockResolvedValue({ outcome: "api-error", code: "profile_failed" });
    render(<EditProfileScreen />);
    await waitFor(() => expect(screen.getByText("Guardar cambios")).toBeTruthy());

    fireEvent.press(screen.getByText("Guardar cambios"));

    await waitFor(() =>
      expect(screen.getByText("No pudimos guardar los cambios. Volvé a intentar.")).toBeTruthy(),
    );
  });

  it("refuses to save a display name under the contract's minimum", async () => {
    // The mutation this catches: dropping `!nameUsable` from the button. The
    // server refuses anyway — with `invalid_request`, which says "your client
    // sent nonsense" to somebody who can fix one visible field.
    render(<EditProfileScreen />);
    await waitFor(() => expect(screen.getByText("Guardar cambios")).toBeTruthy());

    fireEvent.changeText(screen.getByLabelText("Nombre, obligatorio"), "L");
    fireEvent.press(screen.getByText("Guardar cambios"));

    expect(mockSave).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only name as too short", async () => {
    render(<EditProfileScreen />);
    await waitFor(() => expect(screen.getByText("Guardar cambios")).toBeTruthy());

    fireEvent.changeText(screen.getByLabelText("Nombre, obligatorio"), "    ");
    fireEvent.press(screen.getByText("Guardar cambios"));

    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe("the phone hint", () => {
  it("warns about an unusual format WITHOUT blocking the save", async () => {
    // The server accepts these by explicit decision. A native form that refused
    // what the server accepts would be inventing a rule on behalf of somebody
    // with an old landline.
    render(<EditProfileScreen />);
    await waitFor(() => expect(screen.getByText("Guardar cambios")).toBeTruthy());

    fireEvent.changeText(screen.getByLabelText("Teléfono"), "no es un teléfono");

    expect(screen.getByText(/Formato inusual para Argentina/)).toBeTruthy();

    fireEvent.press(screen.getByText("Guardar cambios"));
    await waitFor(() => expect(mockSave).toHaveBeenCalled());
  });

  it("stays quiet for an empty field and for a valid one", async () => {
    render(<EditProfileScreen />);
    await waitFor(() => expect(screen.getByText("Guardar cambios")).toBeTruthy());

    // Seeded value is a well-formed AR number, and the three contact phones are
    // empty — so nothing should be warning about anything.
    expect(screen.queryByText(/Formato inusual para Argentina/)).toBeNull();
  });
});
