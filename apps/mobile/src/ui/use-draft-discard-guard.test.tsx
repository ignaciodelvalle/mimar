// The guard, as every writer screen now gets it — one test instead of twelve.
//
// `use-discard-guard.test.tsx` (src/pets) pins the POLICY against a two-method
// fake: it answers "does a dirty form stop the exit, does a clean one not, does
// `allowLeave` let a programmatic exit through". This file pins the BINDING: the
// wrapper reads the router's navigation object, subscribes to the same event,
// and carries the form wording rather than the alta wizard's.
//
// Why that is worth its own file: the wrapper is the only place in `src/` that
// imports expo-router, and the failure it exists to prevent — a screen that
// looks guarded and silently is not — is invisible from the policy's side.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { Alert, Text } from "react-native";

import { createNavigationFake } from "./navigation-fake";

// THE SHARED FAKE, AND NOT A HAND-WRITTEN ONE (finding F5, review 2026-09-07).
// This file is the authority the screen tests defer to for "what the guard
// DOES", and it was itself built on the two properties `navigation-fake.ts`
// exists to fix: `useNavigation` returned a FRESH object per call, so the
// guard's effect re-subscribed on every render, and the unsubscribe was
// `() => undefined`, so nothing ever came off the list and `pressBack()` fired
// every accumulated stale listener. Both defects flatter a guard — more
// listeners, none of them removable — which is exactly the wrong direction for
// the file everything else cites.
const mockNav = createNavigationFake();

jest.mock("expo-router", () => ({
  useNavigation: () => mockNav.navigation,
}));

import { DISCARD_COPY } from "../pets/use-discard-guard";
import { useDraftDiscardGuard } from "./use-draft-discard-guard";

function Form({ dirty }: { dirty: boolean }) {
  useDraftDiscardGuard(dirty);
  return <Text>form</Text>;
}

let alerts: { title: string; body?: string; buttons?: { text?: string }[] }[] = [];

beforeEach(() => {
  mockNav.reset();
  alerts = [];
  jest
    .spyOn(Alert, "alert")
    .mockImplementation((title: string, body?: string, buttons?: { text?: string }[]) => {
      alerts.push({ title, body, buttons });
    });
});

describe("useDraftDiscardGuard", () => {
  it("stops the back gesture on a form that has been typed in", () => {
    render(<Form dirty />);

    expect(mockNav.pressBack().blocked).toBe(true);
    expect(alerts).toHaveLength(1);
    // The FORM wording, not the alta wizard's: there is nothing to "seguir
    // cargando" on a single form, and "¿Salir del alta?" on the denuncia screen
    // would name a flow the person is not in.
    expect(alerts[0]?.title).toBe(DISCARD_COPY.form.title);
    expect(alerts[0]?.body).toBe(DISCARD_COPY.form.body);
    expect(alerts[0]?.buttons?.map((button) => button.text)).toEqual([
      DISCARD_COPY.form.stay,
      DISCARD_COPY.form.leave,
    ]);
  });

  it("lets an untouched form go without a word", () => {
    // The control that makes the test above mean something. A guard that always
    // asks is a guard that gets dismissed without reading, and it would fire on
    // every person who opened a screen and changed their mind.
    render(<Form dirty={false} />);
    expect(mockNav.pressBack().blocked).toBe(false);
    expect(alerts).toHaveLength(0);
  });

  it("subscribes through the ROUTER's navigation object", () => {
    // The binding, which is the only thing this file adds over the policy test:
    // a wrapper that built its own object, or that read the wrong hook, would
    // pass every assertion above against a listener nobody ever fires.
    render(<Form dirty />);
    expect(mockNav.pressBack().blocked).toBe(true);
    // Nothing dispatched yet — the person has not answered the question.
    expect(mockNav.dispatched).toEqual([]);
  });

  it("UNSUBSCRIBES, so a form that went clean stops asking", () => {
    // What the old hand-written fake could not see: its unsubscribe was
    // `() => undefined`, so the dirty render's listener stayed on the list
    // forever and answered for every later one. A guard whose teardown does not
    // work looks identical to a guard that works, right up to the day a screen
    // that already navigated away blocks somebody else's back gesture.
    const view = render(<Form dirty />);
    view.rerender(<Form dirty={false} />);

    expect(mockNav.pressBack().blocked).toBe(false);
    expect(alerts).toHaveLength(0);
  });
});
