// The account-deletion card, held to the Play policy that produced it.
//
// These are not "it renders" assertions. Each one stands in for a rejection or
// a support ticket that has no other alarm:
//
//   · no control at all → Play rejects an app that offers account creation and
//     no in-app deletion route, and the rejection arrives after the upload;
//   · a control that goes to the wrong place → a reviewer lands somewhere that
//     is not the deletion screen, which reads to them exactly like no deletion
//     screen;
//   · what survives the deletion going unsaid → somebody deletes their account
//     expecting their animals' sanitary history to go with it, and finds out
//     afterwards that it did not.
//
// WHAT CHANGED ON 2026-08-29, AND WHICH ASSERTIONS WENT WITH IT
// ---------------------------------------------------------------------------
// This card used to open `ACCOUNT_DELETION_URL` in a browser, and four of the
// cases here pinned the copy that made that honest — "the browser does not
// share this app's session", "this app does not notice the deletion". Those
// sentences are GONE from the card because the facts behind them are gone: the
// erasure is a bearer call now, and its 200 drops the session. Deleting a test
// whose subject no longer exists is right; what would have been wrong is
// keeping it green by keeping the sentence.
//
// The two URL assertions STAY, and they are not vestigial. `PrivacyScreen`
// still shows that URL as its secondary affordance — it is the only way to get
// a real `.json` onto a device — and the Data safety form still names it. The
// URL is asserted against `API_BASE_URL` rather than a literal on purpose: a
// literal would pass while the constant drifted to a different origin, which is
// the whole failure these two are here to catch.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

const mockPush = jest.fn();

jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush }) }));

import { ACCOUNT_DELETION_URL, API_BASE_URL } from "../config/api";
import { ROUTES } from "../ui/routes";
import { AccountDeletionCard } from "./AccountDeletionCard";

describe("the deletion URL", () => {
  it("is the web account-privacy page on the SAME origin the app already talks to", () => {
    expect(ACCOUNT_DELETION_URL).toBe(`${API_BASE_URL}/cuenta/privacidad`);
  });

  it("carries no hardcoded hostname of its own", () => {
    expect(ACCOUNT_DELETION_URL.startsWith(API_BASE_URL)).toBe(true);
  });
});

beforeEach(() => {
  mockPush.mockReset();
});

describe("the card", () => {
  it("offers a control that reaches account deletion", () => {
    render(<AccountDeletionCard />);
    expect(screen.getByText("Ver mis datos o eliminar mi cuenta")).toBeTruthy();
  });

  it("names BOTH rights, not only the destructive one", () => {
    // The screen behind this card carries the art. 14 export too, and a card
    // that advertised only the deletion would hide the one right a person is far
    // more likely to want to exercise.
    render(<AccountDeletionCard />);
    expect(screen.getByText(/art\. 14/)).toBeTruthy();
    expect(screen.getByText(/art\. 16/)).toBeTruthy();
  });

  it("names what survives the deletion, rather than implying everything goes", () => {
    render(<AccountDeletionCard />);
    expect(screen.getByText(/se conservan como historial de salud del animal/)).toBeTruthy();
  });

  it("navigates to the privacidad route, and deletes nothing itself", () => {
    // The mutation this catches: pointing the card at `/ajustes` or at a path
    // that does not exist. expo-router answers an unknown path with `+not-found`
    // and nothing throws — a reviewer would find the deletion route missing and
    // every local gate would still be green.
    render(<AccountDeletionCard />);
    fireEvent.press(screen.getByText("Ver mis datos o eliminar mi cuenta"));
    expect(mockPush).toHaveBeenCalledWith(ROUTES.privacidad);
  });

  it("pushes rather than replaces, so changing your mind lands back on ajustes", () => {
    render(<AccountDeletionCard />);
    fireEvent.press(screen.getByText("Ver mis datos o eliminar mi cuenta"));
    expect(mockPush).toHaveBeenCalledTimes(1);
  });
});

describe("the route it points at", () => {
  it("matches the web's leaf, which is the URL already printed on the Data safety form", () => {
    // `ROUTES.privacidad` and `ACCOUNT_DELETION_URL` must name the same page in
    // the two clients. The mutation this catches: moving the native screen to
    // `/ajustes/privacidad` because that is where the entry point is, leaving a
    // store reviewer's URL and the app's own route describing different places.
    expect(`${API_BASE_URL}${ROUTES.privacidad}`).toBe(ACCOUNT_DELETION_URL);
  });
});
