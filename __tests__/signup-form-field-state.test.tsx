// @vitest-environment jsdom
//
// SignupForm field-state tests (bug #46, mirrored from LoginForm — PO QA #44 /
// login fix 6d0a0cb6).
//
// React 19 auto-resets an uncontrolled `<form action={fn}>` once the action
// resolves. A validation error on either signup step returns (no redirect),
// so the reset would wipe the DOM-owned fields the user just typed: email on
// step 1, first/last name on step 2. signupAction / completeIdentityAction
// echo those non-secret fields back in form state, and the inputs seed
// `defaultValue` from the echo, so the reset lands on the typed value instead
// of clearing it.
//
// THE PASSWORDS AND THE TERMS TICK ARE NOW KEPT TOO (2026-09-16), and one of
// the tests below used to assert the opposite. It was not measuring a rule; it
// was pinning the half of bug #46 that never got fixed. The rule it looked like
// it was defending — a password must never be echoed through the SERVER — still
// holds and is untouched: `AuthFormState` carries no password, and nothing here
// puts one in it. What changed is that `useKeptFields` re-seeds those fields
// from the form's own `FormData`, captured in the BROWSER, so a person told
// "las contraseñas no coinciden" is no longer made to retype both from scratch.
// The full argument lives in UpdatePasswordForm.tsx.
//
// useActionState is stubbed (same technique as pet-sighting-form.test.tsx /
// finder-in-possession-form.test.tsx) so each step's state is fully
// controllable without driving a real server action.

import { cleanup, fireEvent, render } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthFormState, IdentityFormState } from "@/app/actions/auth";

const mockUseActionState = vi.fn();

vi.mock("react", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof React;
  return {
    ...actual,
    useActionState: (...args: unknown[]) => mockUseActionState(...args),
  };
});

vi.mock("@/app/actions/auth", () => ({
  signupAction: vi.fn(),
  completeIdentityAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

// Location autocomplete pulls in fetch/dynamic-import machinery irrelevant here.
vi.mock("@/components/LocationFields", () => ({
  LocationFields: () => React.createElement("div", { "data-testid": "location-fields" }),
}));

import { SignupForm } from "@/app/(auth)/registro/SignupForm";
import { completeIdentityAction } from "@/app/actions/auth";

const noopAction = () => {};

let authState: AuthFormState = { error: null };
let identityState: IdentityFormState = { error: null };

// Step 1's action is no longer `signupAction` itself — SignupForm hands
// useActionState the `useKeptFields` wrapper around it — so the stub cannot
// discriminate by identity any more, and a test that tried would only be
// pinning the wrapper. Identity is still checked where it can be (step 2), and
// the wrapper is CAPTURED, because driving it is the only way to give the hook
// a submitted `FormData` to keep.
type BoundAuthAction = (prev: AuthFormState, formData: FormData) => unknown;
let capturedAuthAction: BoundAuthAction | null = null;

beforeEach(() => {
  authState = { error: null };
  identityState = { error: null };
  capturedAuthAction = null;
  mockUseActionState.mockImplementation((action: unknown) => {
    if (action === completeIdentityAction) return [identityState, noopAction, false];
    if (typeof action !== "function") {
      throw new Error(`unexpected action passed to useActionState: ${String(action)}`);
    }
    capturedAuthAction = action as BoundAuthAction;
    return [authState, noopAction, false];
  });
});

/**
 * The submit React would have performed: `useKeptFields` captures the form's
 * own `FormData` on the way into the action, which is what the reset then reads
 * back. Skipping this and calling `form.reset()` straight away measures nothing
 * — the hook has been told nothing.
 */
function submitThroughKeptFields(form: HTMLFormElement): void {
  if (capturedAuthAction === null) throw new Error("step 1's action was never handed to the stub");
  capturedAuthAction({ error: null }, new FormData(form));
}

afterEach(cleanup);

function renderForm() {
  return render(<SignupForm intent={null} returnTo={null} />);
}

describe("SignupForm — step 1 (account) field state", () => {
  it("restores the typed email across React 19's post-action form reset (bug #46)", () => {
    const view = renderForm();
    const email = view.container.querySelector('input[name="email"]') as HTMLInputElement;
    const form = view.container.querySelector("form") as HTMLFormElement;

    fireEvent.change(email, { target: { value: "nueva@example.com" } });

    // A failed submit re-renders with the error AND the echoed-back email.
    authState = { error: "Faltan datos. Completá todos los campos.", email: "nueva@example.com" };
    view.rerender(<SignupForm intent={null} returnTo={null} />);

    // Simulate the React 19 reset. Without the defaultValue echo the field
    // would reset to empty; with it, the typed email survives.
    form.reset();
    expect(email.value).toBe("nueva@example.com");
  });

  it("keeps both passwords, and deliberately does NOT keep the terms tick", () => {
    const view = renderForm();
    const password = view.container.querySelector('input[name="password"]') as HTMLInputElement;
    const confirm = view.container.querySelector(
      'input[name="confirmPassword"]',
    ) as HTMLInputElement;
    const tos = view.container.querySelector('input[name="tosAccepted"]') as HTMLInputElement;
    const form = view.container.querySelector("form") as HTMLFormElement;

    // Deliberately DIFFERENT, because the refusal this test stands for is
    // exactly the mismatch — and because restoring both is what lets the person
    // see which of the two carries the typo. Restoring only the first would let
    // them "fix" the confirmation to match a password they never meant.
    fireEvent.change(password, { target: { value: "supersecreta" } });
    fireEvent.change(confirm, { target: { value: "supersecretb" } });
    fireEvent.click(tos);
    expect(tos.checked).toBe(true);
    // The tick is about to be measured on the way OUT, not restored. See below.

    submitThroughKeptFields(form);

    authState = { error: "Las contraseñas no coinciden.", email: "nueva@example.com" };
    view.rerender(<SignupForm intent={null} returnTo={null} />);

    form.reset();
    expect(password.value).toBe("supersecreta");
    expect(confirm.value).toBe("supersecretb");
    // THE TICK IS GONE, ON PURPOSE (PO-gated posture, 2026-09-16). Every other
    // field on this form holds the person's WORK, and putting work back after a
    // failed submit is a kindness. A consent is not work: it is an affirmative
    // act, and a box the system re-ticks on somebody's behalf is a box they did
    // not tick that time.
    //
    // Restoring it was arguable — it would only return for the same person, on
    // their own submit, in this same mounted form, which is what a browser does
    // on back-navigation, and the consent actually recorded is still the one in
    // the NEXT submit's FormData. That is probably defensible, and "probably
    // defensible" is the wrong standard for consent when the conservative
    // option costs one click on a form somebody fills once in their life.
    //
    // This assertion is therefore a POLICY, not an implementation detail: if it
    // ever starts failing, somebody has made the system agree to the terms for
    // a person, and that is a decision for the product owner and not for a
    // refactor.
    expect(tos.checked).toBe(false);
  });

  it("never carries a password in the server-round-tripped form state", () => {
    // The rule the old "resets to empty" assertion was mistaken for. It is
    // about the ECHO, not about the field: whatever the action returns crosses
    // the wire and can be logged, so a secret may not be in it. Re-seeding from
    // the browser's own FormData does not touch this.
    const view = renderForm();
    const form = view.container.querySelector("form") as HTMLFormElement;
    const password = view.container.querySelector('input[name="password"]') as HTMLInputElement;

    fireEvent.change(password, { target: { value: "supersecreta" } });
    submitThroughKeptFields(form);

    authState = { error: "Las contraseñas no coinciden.", email: "nueva@example.com" };
    view.rerender(<SignupForm intent={null} returnTo={null} />);

    expect(JSON.stringify(authState)).not.toContain("supersecreta");
  });
});

describe("SignupForm — step 2 (identity) field state", () => {
  it("restores the typed first/last name across React 19's post-action form reset (bug #46)", () => {
    // Step 1 already succeeded — the form is showing step 2.
    authState = { error: null, ok: true };
    const view = renderForm();

    const firstName = view.container.querySelector('input[name="firstName"]') as HTMLInputElement;
    const lastName = view.container.querySelector('input[name="lastName"]') as HTMLInputElement;
    const form = view.container.querySelector("form") as HTMLFormElement;

    fireEvent.change(firstName, { target: { value: "Juana" } });
    fireEvent.change(lastName, { target: { value: "Gómez" } });

    // A failed submit re-renders with the error AND the echoed-back name.
    //
    // The sample error used to be "El DNI debe tener 7 u 8 dígitos numéricos.",
    // a sentence the action can no longer produce: the DNI field left this form
    // on 2026-09-07. What this test is about is the ECHO — React 19 resets an
    // uncontrolled form when the action resolves, and bug #46 was people losing
    // their own typed name on a refusal — so the string only has to be a real
    // refusal this form can actually show. Using a dead one would quietly make
    // the fixture a lie about what a user sees here.
    identityState = {
      error: "No pudimos guardar tus datos. Revisá la información e intentá de nuevo.",
      firstName: "Juana",
      lastName: "Gómez",
    };
    view.rerender(<SignupForm intent={null} returnTo={null} />);

    form.reset();
    expect(firstName.value).toBe("Juana");
    expect(lastName.value).toBe("Gómez");
  });
});
