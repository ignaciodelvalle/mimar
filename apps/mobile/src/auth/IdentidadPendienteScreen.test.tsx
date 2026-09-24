// `IdentidadPendienteScreen` — signup step 2, now that it happens HERE.
//
// WHAT THIS HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE REDIRECT STILL FIRES. The screen and the redirect are the SAME
//      component on purpose — `profilePending` is a prop, not a hook read,
//      precisely so this can be asserted without expo-router's real navigation
//      stack. Its absence was the redirect-loop bug fixed 2026-09-04, and the
//      form makes it MORE load-bearing rather than less: the success path has no
//      navigation call of its own, it just stops being pending.
//   2. NOTHING IS SENT UNTIL THE CONTRACT'S SCHEMA SAYS SO, and what is sent is
//      TRIMMED. A blank surname gets a field sentence, not a round trip.
//   3. A REFUSAL KEEPS THE TYPED VALUES. The web form had to fight React 19's
//      automatic reset for this property (bug #46) and echo the names back
//      through `IdentityFormState`; here they are component state, and the
//      assertion is what stops somebody "cleaning up" by clearing the draft.
//   4. THE BROWSER IS NEVER REACHED FROM HERE, AT ALL. This used to say the web
//      door "is still there for the DNI"; it is not, since 2026-09-07. The DNI
//      left `/registro` and the link left with it, so the assertion below is now
//      an absence — a fence against re-offering a hand-off that costs a re-login
//      and lands on a form without the field it promises.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockOpenURL = jest.fn();
const mockSignOut = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockCompleteIdentity =
  jest.fn<(...args: unknown[]) => Promise<{ ok: boolean; message?: string }>>();
const mockRedirect = jest.fn();

jest.mock("expo-linking", () => ({ openURL: (...args: unknown[]) => mockOpenURL(...args) }));

// A TEST DOUBLE, NOT THE REAL COMPONENT: expo-router's `Redirect` navigates
// through a live router context this render has none of. Recording its props and
// rendering nothing is enough to prove WHICH href this screen chose, without
// standing up a router.
jest.mock("expo-router", () => ({
  Redirect: (props: { href: string }) => {
    mockRedirect(props);
    return null;
  },
}));

jest.mock("./session-store", () => ({
  signOut: (...args: unknown[]) => mockSignOut(...args),
  completeIdentity: (...args: unknown[]) => mockCompleteIdentity(...args),
}));

import { ROUTES } from "../ui/routes";
import { IdentidadPendienteScreen } from "./IdentidadPendienteScreen";

function fill(firstName = "Ana", lastName = "Pérez") {
  fireEvent.changeText(screen.getByLabelText("Nombre, obligatorio"), firstName);
  fireEvent.changeText(screen.getByLabelText("Apellido, obligatorio"), lastName);
}

beforeEach(() => {
  mockOpenURL.mockReset();
  mockSignOut.mockReset();
  mockRedirect.mockReset();
  mockCompleteIdentity.mockReset();
  mockCompleteIdentity.mockResolvedValue({ ok: true });
});

describe("the gate", () => {
  it("renders the form while profilePending is true", () => {
    render(<IdentidadPendienteScreen profilePending={true} />);

    expect(screen.getByText("Completá tu registro")).toBeTruthy();
    expect(screen.getByLabelText("Nombre, obligatorio")).toBeTruthy();
    expect(screen.getByLabelText("Apellido, obligatorio")).toBeTruthy();
    expect(screen.getByText("Guardar")).toBeTruthy();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("redirects to mis mascotas instead of rendering, once profilePending is false", () => {
    // THE LOAD-BEARING CASE (2026-09-04). Reached via a deep link, a stale
    // back-stack entry, the sign-in round trip `return-to.ts` used to carry
    // `next=/identidad-pendiente` through — and now, most often, via the save
    // that just landed. All of them used to land back on this exact screen even
    // after the server answered `profilePending: false`, because nothing here
    // ever asked.
    render(<IdentidadPendienteScreen profilePending={false} />);

    expect(screen.queryByText("Completá tu registro")).toBeNull();
    expect(mockRedirect).toHaveBeenCalledTimes(1);
    expect(mockRedirect).toHaveBeenCalledWith({ href: ROUTES.misMascotas });
  });

  // -------------------------------------------------------------------------
  // A4-custodia-03 — WHERE THEY WERE GOING, WHEN THERE WAS SOMEWHERE
  // -------------------------------------------------------------------------
  it("lands on the interrupted destination when the gate carried one", () => {
    // The person tapped a caretaker invitation in their mail, installed the app,
    // created an account, and reached this screen through the gate's SIGNED-IN
    // arm — which now carries `next` the way the signed-out arm has since WU-O.
    // Finishing step 2 must take them to the invitation, not to an empty list.
    render(<IdentidadPendienteScreen next="/cuidado/GRT-ABCD-2345" profilePending={false} />);

    expect(mockRedirect).toHaveBeenCalledWith({ href: "/cuidado/GRT-ABCD-2345" });
  });

  it("refuses a `next` that would leave the app", () => {
    // `mimar://identidad-pendiente?next=…` is a URL anybody can compose, so the
    // value is re-checked here through `returnHref` and not trusted because the
    // gate produced it. Same shape check as the sign-in round trip.
    render(<IdentidadPendienteScreen next="https://evil.example/phish" profilePending={false} />);

    expect(mockRedirect).toHaveBeenCalledWith({ href: ROUTES.misMascotas });
  });
});

describe("the form", () => {
  it("sends the TRIMMED names and lets the store take the person onward", async () => {
    const view = render(<IdentidadPendienteScreen profilePending={true} />);
    fill("  Ana  ", " Pérez ");

    fireEvent.press(screen.getByText("Guardar"));

    await waitFor(() => expect(mockCompleteIdentity).toHaveBeenCalledTimes(1));
    expect(mockCompleteIdentity).toHaveBeenCalledWith({ firstName: "Ana", lastName: "Pérez" });

    // THE SCREEN NAMES NO DESTINATION OF ITS OWN. `completeIdentity` swaps the
    // stored user, the route re-renders with `profilePending: false`, and the
    // redirect above is what moves. Re-rendering with the new prop is that, in a
    // test that has no store.
    view.rerender(<IdentidadPendienteScreen profilePending={false} />);
    expect(mockRedirect).toHaveBeenCalledWith({ href: ROUTES.misMascotas });
  });

  it("keeps the button dead until both fields have something in them", () => {
    const saveDisabled = () =>
      screen.getByRole("button", { name: "Guardar" }).props.accessibilityState.disabled;

    render(<IdentidadPendienteScreen profilePending={true} />);
    expect(saveDisabled()).toBe(true);

    fireEvent.changeText(screen.getByLabelText("Nombre, obligatorio"), "Ana");
    expect(saveDisabled()).toBe(true);

    fireEvent.changeText(screen.getByLabelText("Apellido, obligatorio"), "Pérez");
    expect(saveDisabled()).toBe(false);
  });

  it("refuses an empty surname from the return key, without spending a request", () => {
    // THE RETURN KEY IS A SECOND SUBMIT PATH and it does not consult the
    // button's disabled state — `useReturnKeyChain`'s last field calls `onDone`
    // directly. So the presence rules still have to be enforced by the verdict,
    // and the sentence still has to name the empty box.
    render(<IdentidadPendienteScreen profilePending={true} />);
    fireEvent.changeText(screen.getByLabelText("Nombre, obligatorio"), "Ana");

    fireEvent(screen.getByLabelText("Apellido, obligatorio"), "submitEditing");

    expect(mockCompleteIdentity).not.toHaveBeenCalled();
    expect(screen.getByText("Escribí tu apellido.")).toBeTruthy();
  });

  it("submits from the return key on Apellido, so nothing has to be tapped under the keyboard", async () => {
    render(<IdentidadPendienteScreen profilePending={true} />);
    fill();

    fireEvent(screen.getByLabelText("Apellido, obligatorio"), "submitEditing");

    await waitFor(() => expect(mockCompleteIdentity).toHaveBeenCalledTimes(1));
  });

  it("refuses a name past the shared display-name bound, with the length sentence", () => {
    render(<IdentidadPendienteScreen profilePending={true} />);
    fill("A".repeat(200), "Pérez");

    fireEvent.press(screen.getByText("Guardar"));

    expect(mockCompleteIdentity).not.toHaveBeenCalled();
    expect(screen.getByText(/hasta \d+ caracteres cada uno/)).toBeTruthy();
  });

  it("renders the server's refusal and KEEPS what the person typed", async () => {
    mockCompleteIdentity.mockResolvedValue({
      ok: false,
      message: "Ese nombre no nos sirve para identificarte. Escribí tu nombre y apellido reales.",
    });
    render(<IdentidadPendienteScreen profilePending={true} />);
    fill("Ana", "Pérez");

    fireEvent.press(screen.getByText("Guardar"));

    await waitFor(() =>
      expect(screen.getByText(/Ese nombre no nos sirve para identificarte/)).toBeTruthy(),
    );
    // The values survive. Somebody whose save was refused must not have to retype
    // their own name — the web form needed an explicit echo for this and this one
    // needs an assertion that nobody clears the draft "on failure".
    expect(screen.getByLabelText("Nombre, obligatorio").props.value).toBe("Ana");
    expect(screen.getByLabelText("Apellido, obligatorio").props.value).toBe("Pérez");
    // And the screen stays: a refused save is not a completed identity.
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("does not send twice while a save is in flight", async () => {
    // Held in an object rather than a `let`: TypeScript narrows a `let` assigned
    // only inside a callback to `never` at the call site below, and the test
    // would not compile.
    const inFlight: { release: () => void } = { release: () => {} };
    mockCompleteIdentity.mockReturnValue(
      new Promise((resolve) => {
        inFlight.release = () => resolve({ ok: true });
      }),
    );
    render(<IdentidadPendienteScreen profilePending={true} />);
    fill();

    fireEvent.press(screen.getByText("Guardar"));
    await waitFor(() => expect(screen.getByText("Guardando…")).toBeTruthy());

    // Dead while in flight, from BOTH submit paths. A second one here would be a
    // second request against a per-user budget, for an act already under way.
    fireEvent.press(screen.getByText("Guardando…"));
    fireEvent(screen.getByLabelText("Apellido, obligatorio"), "submitEditing");

    expect(mockCompleteIdentity).toHaveBeenCalledTimes(1);
    inFlight.release();
  });
});

describe("the web door and the way out", () => {
  it("offers NO browser handoff at all, by tap or otherwise", () => {
    // THIS ASSERTION USED TO BE ITS OWN OPPOSITE, and the inversion is the
    // change. It read `getByText("Prefiero completarlo en la web")` and pressed
    // it, pinning the demoted web link as a feature.
    //
    // That link existed for exactly one thing — the DNI — and `/registro`
    // stopped asking for one on 2026-09-07 (PO decision). A link that survives
    // the field it was for sends somebody through a re-login, into a browser
    // that does not carry this app's session, to reach a form that no longer has
    // what they were promised.
    //
    // The test is kept and inverted rather than deleted, because deleting it
    // would leave nothing standing between a future "let's offer the web as a
    // fallback" and a screen that silently hands people out of the app again.
    // The screen's whole job is to take a name; it must finish that here.
    render(<IdentidadPendienteScreen profilePending={true} />);
    expect(screen.queryByText("Prefiero completarlo en la web")).toBeNull();
    // Not the copy alone: nothing on this screen may reach the browser at all.
    expect(mockOpenURL).not.toHaveBeenCalled();
  });

  it("still offers Cerrar sesión", () => {
    render(<IdentidadPendienteScreen profilePending={true} />);
    fireEvent.press(screen.getByText("Cerrar sesión"));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
