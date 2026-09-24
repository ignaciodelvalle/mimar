// `AdoptionApplyScreen` — the one write in this app that lands in somebody
// else's queue, and the guard that must not stand in front of its own success.
//
// WHY THIS FILE EXISTS AT ALL (finding H1, review 2026-09-07). It did not. The
// longest form in the app — the letter a person writes to a shelter about an
// animal they want to take home — had no test of any kind, and it shipped with
// `useDraftDiscardGuard(...)`'s `allowLeave` thrown away. So a postulación the
// shelter ALREADY HAD asked "¿Salir sin guardar?" on the way out, and "Seguir
// editando" left the person sitting on a form they had already sent. The three
// sibling screens that got the same guard in the same batch mocked
// `useNavigation` as `() => ({ addListener: () => () => {} })`, which is why
// none of their tests could see it either: the listener was never fired.
//
// So the registry below is the point of the file. What the guard DOES is pinned
// in `ui/use-draft-discard-guard.test.tsx`; what this pins is that THIS screen
// exempts the exit it makes itself.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";

import { createNavigationFake } from "../ui/navigation-fake";

const mockSubmit = jest.fn<(...args: unknown[]) => Promise<unknown>>();

// THE SHARED FAKE, not a fourth hand-written copy of it (finding F4, review
// 2026-09-07). The two properties this needs — a STABLE object and a REAL
// unsubscribe — are subtle enough that `ui/navigation-fake.ts` exists to own
// them once; a per-file copy is how one of them degrades back into the no-op
// stub without anybody noticing.
const mockNav = createNavigationFake();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useNavigation: () => mockNav.navigation,
}));

jest.mock("../api/endpoints", () => ({
  submitAdoptionApplication: (...args: unknown[]) => mockSubmit(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import { AdoptionApplyScreen } from "./AdoptionApplyScreen";

const TOKEN = "DIM-ADOP-0001";
/** Over the contract's 30-character floor, so the parse is not what refuses. */
const MOTIVATION = "Tengo patio, trabajo desde casa y quiero acompañarla todos los días.";

function renderScreen(overrides: { onSubmitted?: () => void } = {}) {
  return render(
    <AdoptionApplyScreen
      petToken={TOKEN}
      petName="Pampa"
      applicantName="Ana Gómez"
      applicantEmail="ana@example.com"
      onSubmitted={overrides.onSubmitted ?? (() => {})}
      onBackToFicha={() => {}}
    />,
  );
}

/** Everything the contract requires, typed the way a person would type it. */
function fillTheForm() {
  fireEvent.press(screen.getByText("Casa con patio"));
  fireEvent.press(screen.getByText("Nunca tuve"));
  fireEvent.changeText(screen.getByLabelText("¿Por qué querés adoptar?, obligatorio"), MOTIVATION);
  fireEvent(
    screen.getByLabelText("Autorizo a compartir mis datos de contacto con el refugio"),
    "valueChange",
    true,
  );
}

/** Fire the back gesture at whatever the guard subscribed. */
function pressBack(): { prevented: boolean } {
  return { prevented: mockNav.pressBack().blocked };
}

let alerts: string[] = [];

beforeEach(() => {
  mockSubmit.mockReset();
  mockNav.reset();
  alerts = [];
  jest.spyOn(Alert, "alert").mockImplementation((title: string) => {
    alerts.push(title);
  });
});

describe("the form", () => {
  it("shows the applicant what the shelter will see before asking for consent", () => {
    // Consent to share a profile is not consent to a mystery: a checkbox over an
    // unseen payload is a checkbox nobody can honestly tick.
    renderScreen();
    expect(screen.getByText("Adoptar a Pampa")).toBeTruthy();
    expect(screen.getByText("Ana Gómez")).toBeTruthy();
    expect(screen.getByText("ana@example.com")).toBeTruthy();
  });

  it("refuses locally, with the CONTRACT's own code, before spending a round trip", async () => {
    renderScreen();
    fireEvent.press(screen.getByText("Casa con patio"));
    fireEvent.press(screen.getByText("Nunca tuve"));
    fireEvent.changeText(screen.getByLabelText("¿Por qué querés adoptar?, obligatorio"), "corto");
    fireEvent(
      screen.getByLabelText("Autorizo a compartir mis datos de contacto con el refugio"),
      "valueChange",
      true,
    );
    fireEvent.press(screen.getByText("Enviar postulación"));

    await waitFor(() => expect(screen.getByText(/mínimo 30 caracteres/)).toBeTruthy());
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});

describe("the back guard, and the exit it must let through", () => {
  it("asks before discarding an application somebody typed and never sent", () => {
    // The control. Without it the test below would pass against a screen with no
    // guard at all.
    renderScreen();
    fillTheForm();

    expect(pressBack().prevented).toBe(true);
    expect(alerts).toEqual(["¿Salir sin guardar?"]);
  });

  it("does NOT ask once the shelter has the postulación", async () => {
    // THE DEFECT. `onSubmitted` navigates, the guard intercepted that navigation,
    // and "Seguir editando" stranded the person on a form whose letter had
    // already been delivered.
    const onSubmitted = jest.fn();
    mockSubmit.mockResolvedValue({ outcome: "ok", payload: {} });
    renderScreen({ onSubmitted });

    fillTheForm();
    fireEvent.press(screen.getByText("Enviar postulación"));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));

    expect(pressBack().prevented).toBe(false);
    expect(alerts).toEqual([]);
  });

  it("keeps asking when the send FAILED — the letter is still only on the phone", async () => {
    // The other half of the rule, and the one an `allowLeave()` written at the
    // top of `onSubmit` instead of inside the success arm would break.
    mockSubmit.mockResolvedValue({ outcome: "unreachable", detail: null });
    renderScreen();

    fillTheForm();
    fireEvent.press(screen.getByText("Enviar postulación"));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));

    expect(pressBack().prevented).toBe(true);
    expect(alerts).toEqual(["¿Salir sin guardar?"]);
  });
});
