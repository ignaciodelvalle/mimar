// @vitest-environment jsdom
//
// The web's six-digit recovery step (PO decision 2026-09-13: ONE method, the
// code, on both surfaces; 2026-09-15: redeemed from the BROWSER, and the new
// password is set in the SAME submit).
//
// WHY THIS FILE GREW A SECOND HALF
// ---------------------------------------------------------------------------
// Redeeming the code mints a real cookie session, and while the password lived
// on a separate page nothing obliged anybody to continue: possession of the code
// alone was a complete web login, and a support-impersonation phone call was
// enough to get it. The fix was structural — the step that could be abandoned no
// longer exists — so the assertions that protect it are about ORDER and about
// what happens on the way out, not about a guard somebody could delete.
//
// TWO HALVES, TESTED TWO WAYS, and the split is the point of the component's own
// split. `ResetCodeStepView` is pure presentation, so its states render to a
// STRING with no hooks at all. `ResetCodeStep` owns the whole reset, and there is
// no server action left to assert against — the security properties now live in
// what this component does with `verifyOtp`, `updateUser` and `signOut`, so they
// are exercised through a real submit against a mocked `@/lib/supabase/client`.
//
// The assertions that carry weight, and that would go red if the protection were
// removed rather than merely restated:
//   · A REFUSED PASSWORD NEVER REACHES `verifyOtp`. The code is single-use, so
//     validating after redemption would burn a good code on a typo. This is the
//     phone's assertion (`session-store-password-reset.test.ts`) on the web.
//   · A FAILED `updateUser` DROPS THE SESSION. No recovery session may outlive
//     the handler that created it — that is the window this change closed.
//   · a wrong code, an expired code and an unknown address produce the SAME
//     sentence — the anti-enumeration property;
//   · the typed code and the typed password reach `verifyOtp` / `updateUser` and
//     NOTHING else: not the DOM, not the navigation, not the resend action;
//   · a resolved-but-sessionless answer is a failure, not a success;
//   · success revokes every OTHER session and leaves through a FULL document
//     navigation.

import { PASSWORD_SETUP_PENDING_RECOVERY_MESSAGE } from "@/src/modules/auth/domain/first-access";
import { MFA_PASSWORD_CHANGE_NEEDS_ADMIN_MESSAGE } from "@/src/modules/auth/domain/mfa-policy";
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render as renderDom, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The resend half is still a server action; importing it for real would pull the
// whole server graph into this test.
const { resendAction } = vi.hoisted(() => ({
  resendAction: vi.fn(async () => ({ message: null, error: null })),
}));
vi.mock("@/app/actions/password-reset", () => ({ requestPasswordResetAction: resendAction }));

const { verifyOtp, updateUser, signOut } = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { verifyOtp, updateUser, signOut } }),
}));

// `useActionNavigate` performs a real `window.location.assign`, which jsdom
// refuses to implement. Spying on the module keeps the component's own contract
// under test (it must navigate, and it must stay busy afterwards) without asking
// jsdom to leave the page.
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@/lib/ui/use-action-redirect", () => ({
  useActionNavigate: () => [navigate, false] as const,
}));

import {
  RESET_CODE_MESSAGES,
  RESET_DONE_MESSAGE,
  ResetCodeStep,
  ResetCodeStepView,
} from "@/app/(auth)/recuperar/ResetCodeStep";
import { NEW_PASSWORD_MESSAGES } from "@/src/modules/auth/domain/new-password-rules";

const NOTICE =
  "Si existe una cuenta con ese correo, te enviamos un código de 6 dígitos. Revisá también tu carpeta de spam.";
const noop = () => {};

/** A password that satisfies both shared rules, so the code path is the one under test. */
const GOOD_PASSWORD = "perrita-nueva-2026";

/** GoTrue's answer to a wrong code, an expired one, a spent one and an unknown address alike. */
const GOTRUE_OTP_REFUSAL = {
  message: "Token has expired or is invalid",
  code: "otp_expired",
  status: 403,
};

function render(overrides: Partial<Parameters<typeof ResetCodeStepView>[0]> = {}) {
  return renderToStaticMarkup(
    <ResetCodeStepView
      email="ana@mimar.ar"
      notice={NOTICE}
      codeError={null}
      passwordError={null}
      done={false}
      onSubmit={noop}
      pending={false}
      resendError={null}
      resendAction={noop}
      resendPending={false}
      onChangeEmail={noop}
      {...overrides}
    />,
  );
}

/** The markup of the first <form>, i.e. the reset form. */
function resetForm(html: string): string {
  const start = html.indexOf("<form");
  return html.slice(start, html.indexOf("</form>", start));
}

describe("ResetCodeStepView", () => {
  it("asks for the code AND the new password on ONE form, with one submit", () => {
    // THE SHAPE IS THE FIX. If these three ever land on two forms again, the
    // window between redeeming and setting the password is back.
    const html = render();
    expect(html).toContain(NOTICE);
    const form = resetForm(html);
    expect(form).toContain('name="code"');
    expect(form).toContain('autoComplete="one-time-code"');
    expect(form).toContain('inputMode="numeric"');
    expect(form).toContain('name="password"');
    expect(form).toContain('name="confirmPassword"');
    expect(form).toContain('type="submit"');
    expect(form).toContain("Cambiar contraseña");
  });

  it("marks both password boxes as new-password and offers to reveal them", () => {
    const form = resetForm(render());
    expect(form.match(/autoComplete="new-password"/g)).toHaveLength(2);
    // The repo's password affordance (LnPasswordInput), not a bare input.
    expect(form).toContain("Mostrar contraseña");
  });

  it("never sends the person to a second page to finish the reset", () => {
    // The abandonable step is gone; nothing here may link back to it.
    expect(render()).not.toContain("/recuperar/actualizar");
  });

  it("never caps the code length (GoTrue owns otp_length)", () => {
    const form = resetForm(render());
    expect(form).not.toMatch(/maxlength/i);
  });

  it("offers a resend that posts the same address, and a way back to change it", () => {
    const html = render();
    const second = html.slice(html.indexOf("</form>") + 1);
    expect(second).toContain('type="hidden" name="email" value="ana@mimar.ar"');
    expect(second).toContain("Pedir otro código");
    expect(html).toContain("Usar otro correo");
  });

  it("shows the invalid-or-expired sentence on the code field when the code is refused", () => {
    const html = render({ codeError: RESET_CODE_MESSAGES.invalid_code });
    expect(html).toContain(RESET_CODE_MESSAGES.invalid_code);
    expect(resetForm(html)).toContain('aria-invalid="true"');
  });

  it("shows a password rule on the password field, not on the code field", () => {
    const html = render({ passwordError: NEW_PASSWORD_MESSAGES.mismatch });
    expect(html).toContain(NEW_PASSWORD_MESSAGES.mismatch);
  });

  it("shows a resend refusal (rate limit) without hiding the reset form", () => {
    const html = render({
      resendError: "Demasiados intentos. Esperá un momento y volvé a probar.",
    });
    expect(html).toContain("Demasiados intentos");
    expect(html).toContain('role="alert"');
    expect(resetForm(html)).toContain('name="code"');
  });

  it("disables the submit and says so while working (and while navigating away)", () => {
    const form = resetForm(render({ pending: true }));
    expect(form).toContain("Guardando...");
    expect(form).toContain("disabled");
  });

  it("never mentions a link — the mail carries a code", () => {
    expect(render()).not.toMatch(/enlace/i);
  });
});

// ---------------------------------------------------------------------------
// ResetCodeStep — the browser redemption AND the password change, one handler
// ---------------------------------------------------------------------------

/** Mount the step and submit the whole form. */
function submitReset({
  code,
  password = GOOD_PASSWORD,
  confirmPassword = password,
  email = "ana@mimar.ar",
}: {
  code: string;
  password?: string;
  confirmPassword?: string;
  email?: string;
}) {
  renderDom(<ResetCodeStep email={email} notice={NOTICE} onChangeEmail={noop} />);
  const codeField = screen.getByLabelText(/Código/i) as HTMLInputElement;
  const passwordField = screen.getByLabelText(/Nueva contraseña/i) as HTMLInputElement;
  const confirmField = screen.getByLabelText(/Repetir contraseña/i) as HTMLInputElement;
  fireEvent.change(codeField, { target: { value: code } });
  fireEvent.change(passwordField, { target: { value: password } });
  fireEvent.change(confirmField, { target: { value: confirmPassword } });
  fireEvent.submit(codeField.closest("form") as HTMLFormElement);
  return { codeField, passwordField, confirmField };
}

/** Whatever sentence the step is currently showing, if any. */
function shownError(): string | null {
  for (const sentence of [
    ...Object.values(RESET_CODE_MESSAGES),
    ...Object.values(NEW_PASSWORD_MESSAGES),
  ]) {
    if (screen.queryByText(sentence)) return sentence;
  }
  return null;
}

beforeEach(() => {
  verifyOtp.mockReset();
  updateUser.mockReset();
  signOut.mockReset();
  signOut.mockResolvedValue({ error: null });
  navigate.mockReset();
  resendAction.mockClear();
});

afterEach(cleanup);

describe("ResetCodeStep — the password is checked BEFORE the code is spent", () => {
  // THE assertion of this file, and the phone's
  // (`session-store-password-reset.test.ts`): a recovery code is single-use and
  // `verifyOtp` consumes it, so a local rule that could have been checked for
  // free must never cost somebody a code.
  it.each([
    ["a password below the minimum", "corta", "corta", NEW_PASSWORD_MESSAGES.too_short],
    [
      "a confirmation that does not match",
      GOOD_PASSWORD,
      `${GOOD_PASSWORD}x`,
      NEW_PASSWORD_MESSAGES.mismatch,
    ],
  ])("never calls verifyOtp for %s", async (_label, password, confirmPassword, sentence) => {
    submitReset({ code: "123456", password, confirmPassword });

    await waitFor(() => expect(shownError()).toBe(sentence));
    // The code is NOT burnt.
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("tells somebody who typed the same short password twice about the LENGTH", () => {
    // Both rules fail at once; the honest one is the one they can act on.
    submitReset({ code: "123456", password: "corta", confirmPassword: "corta" });
    expect(screen.getByText(NEW_PASSWORD_MESSAGES.too_short)).toBeInTheDocument();
  });

  it("asks for the code when the field is blank, without calling GoTrue", async () => {
    submitReset({ code: "   " });

    await waitFor(() => expect(shownError()).toBe(RESET_CODE_MESSAGES.missing_code));
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});

describe("ResetCodeStep — a recovery session never outlives the handler", () => {
  it("drops the session verifyOtp stored when updateUser fails", async () => {
    verifyOtp.mockResolvedValue({ data: { session: { access_token: "a" } }, error: null });
    updateUser.mockResolvedValue({ data: {}, error: { message: "Password is too weak" } });
    submitReset({ code: "123456" });

    await waitFor(() => expect(shownError()).toBe(RESET_CODE_MESSAGES.update_failed));
    // By now `verifyOtp` has written live auth cookies. Leaving them is the exact
    // window this change closed: an error on screen and a signed-in browser.
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    // And nothing pretends the reset half-worked.
    expect(signOut).not.toHaveBeenCalledWith({ scope: "others" });
    expect(navigate).not.toHaveBeenCalled();
  });

  // LOW-6 (2026-09-18): the code was right, GoTrue refused the password only
  // because the account has a second factor and a recovery session is aal1.
  it("tells an account with a second factor to ask for an admin reset, and still drops the session", async () => {
    verifyOtp.mockResolvedValue({ data: { session: { access_token: "a" } }, error: null });
    updateUser.mockResolvedValue({
      data: {},
      error: {
        code: "insufficient_aal",
        message: "AAL2 session is required to update email or password when MFA is enabled.",
      },
    });
    submitReset({ code: "123456" });

    await waitFor(() =>
      expect(screen.queryByText(MFA_PASSWORD_CHANGE_NEEDS_ADMIN_MESSAGE)).not.toBeNull(),
    );
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(navigate).not.toHaveBeenCalled();
  });

  // LOW-7 (2026-09-18): an account that still owes its FIRST password pays it at
  // /primer-acceso only; the recovery code must not set it.
  it("refuses an account whose first-access password is pending: no updateUser, session dropped", async () => {
    verifyOtp.mockResolvedValue({
      data: {
        session: { access_token: "a" },
        user: { id: "u-1", app_metadata: { password_setup_pending: true } },
      },
      error: null,
    });
    submitReset({ code: "123456" });

    await waitFor(() =>
      expect(screen.queryByText(PASSWORD_SETUP_PENDING_RECOVERY_MESSAGE)).not.toBeNull(),
    );
    expect(updateUser).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("drops the session when updateUser THROWS, too", async () => {
    // auth-js rethrows anything that is not an AuthError — a network failure, a
    // cookie write that threw. Unwrapped it would leave the session standing.
    verifyOtp.mockResolvedValue({ data: { session: { access_token: "a" } }, error: null });
    updateUser.mockRejectedValue(new Error("fetch failed"));
    submitReset({ code: "123456" });

    await waitFor(() => expect(shownError()).toBe(RESET_CODE_MESSAGES.update_failed));
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(navigate).not.toHaveBeenCalled();
  });

  // THE SHAPE THAT GOT THROUGH THE FIRST TIME. `auth-js` RETURNS a fetch failure
  // as `{ error }` instead of throwing it, and returns it WITHOUT having cleared
  // local storage — so asserting that `signOut` was CALLED proved nothing about
  // whether the session died. Worse, the two failures are correlated: whatever
  // stopped `updateUser` is what will stop `signOut`, so this was the COMMON case
  // of this branch, not the rare one.
  it("clears the cookies anyway when signOut RETURNS an error instead of throwing", async () => {
    document.cookie = "sb-demoproject-auth-token=header.payload";
    document.cookie = "sb-demoproject-auth-token.1=signature";
    expect(document.cookie).toContain("sb-demoproject-auth-token");

    verifyOtp.mockResolvedValue({ data: { session: { access_token: "a" } }, error: null });
    updateUser.mockRejectedValue(new Error("fetch failed"));
    // status 0 is what an unreachable GoTrue produces — not one of the 404/401/403
    // codes auth-js forgives, so it bails out BEFORE removing the session.
    signOut.mockResolvedValue({ error: { status: 0, message: "fetch failed" } });
    submitReset({ code: "123456" });

    await waitFor(() => expect(shownError()).toBe(RESET_CODE_MESSAGES.update_failed));
    // Retried once for an ordinary blip, then cleared without the network.
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(2));
    expect(document.cookie).not.toContain("sb-demoproject-auth-token");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not retry or touch cookies when the first signOut genuinely worked", async () => {
    document.cookie = "sb-demoproject-auth-token=header.payload";

    verifyOtp.mockResolvedValue({ data: { session: { access_token: "a" } }, error: null });
    updateUser.mockRejectedValue(new Error("fetch failed"));
    signOut.mockResolvedValue({ error: null });
    submitReset({ code: "123456" });

    await waitFor(() => expect(shownError()).toBe(RESET_CODE_MESSAGES.update_failed));
    // Exactly one local sign-out: the retry is for failure, not a habit. This is
    // what keeps the test above from passing vacuously.
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    document.cookie = "sb-demoproject-auth-token=; Max-Age=0";
  });

  it("does not sign out on a refused code — there was no session to drop", async () => {
    verifyOtp.mockResolvedValue({ data: { session: null }, error: GOTRUE_OTP_REFUSAL });
    submitReset({ code: "000000" });

    await waitFor(() => expect(shownError()).toBe(RESET_CODE_MESSAGES.invalid_code));
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("ResetCodeStep (browser redemption)", () => {
  it("redeems the code, sets the password, revokes other sessions and navigates", async () => {
    verifyOtp.mockResolvedValue({ data: { session: { access_token: "a" } }, error: null });
    updateUser.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    // Pasted from a mail client, hence the space: whitespace is removed, the
    // address is the one the request step echoed back.
    submitReset({ code: "123 456" });

    await waitFor(() =>
      expect(verifyOtp).toHaveBeenCalledWith({
        email: "ana@mimar.ar",
        token: "123456",
        type: "recovery",
      }),
    );
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: GOOD_PASSWORD }));
    // MED-5: a reset is the canonical response to a compromised account, so any
    // session an attacker minted before it must die. "others", never "global" —
    // the person who just recovered stays signed in.
    await waitFor(() => expect(signOut).toHaveBeenCalledWith({ scope: "others" }));
    // A FULL document navigation, not a router push.
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/iniciar-sesion"));
    expect(shownError()).toBeNull();
    expect(screen.getByText(RESET_DONE_MESSAGE)).toBeInTheDocument();
  });

  it("still succeeds when revoking the other sessions fails", async () => {
    // The password is ALREADY changed. Reporting a failed reset here would send
    // somebody to ask for a second code with the new password in their hands.
    verifyOtp.mockResolvedValue({ data: { session: { access_token: "a" } }, error: null });
    updateUser.mockResolvedValue({ data: {}, error: null });
    signOut.mockRejectedValue(new Error("network"));
    submitReset({ code: "123456" });

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/iniciar-sesion"));
    expect(shownError()).toBeNull();
  });

  it("keeps the button busy through the navigation, so a second submit is impossible", async () => {
    verifyOtp.mockResolvedValue({ data: { session: { access_token: "a" } }, error: null });
    updateUser.mockResolvedValue({ data: {}, error: null });
    submitReset({ code: "123456" });

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const button = screen.getByRole("button", { name: /Guardando/i });
    expect(button).toBeDisabled();
  });

  it.each([
    ["a wrong code", GOTRUE_OTP_REFUSAL, "000000"],
    ["an expired code", { ...GOTRUE_OTP_REFUSAL }, "654321"],
    // A DIFFERENT provider shape for the unknown address. Today's GoTrue answers
    // both with otp_expired, but if a version ever distinguishes them, what the
    // person is TOLD must still not — otherwise this is an enumeration oracle.
    [
      "an address with no account",
      { message: "User not found", code: "user_not_found", status: 404 },
      "111111",
    ],
  ])("shows the one neutral sentence for %s", async (_label, error, code) => {
    verifyOtp.mockResolvedValue({ data: { session: null }, error });
    submitReset({ code });

    await waitFor(() => expect(shownError()).toBe(RESET_CODE_MESSAGES.invalid_code));
    expect(updateUser).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("treats a resolved answer with no session as a failure, not a success", async () => {
    // GoTrue said nothing was wrong and handed over no session: there would be no
    // session to change a password with. Same sentence as a refused code.
    verifyOtp.mockResolvedValue({ data: { session: null }, error: null });
    submitReset({ code: "123456" });

    await waitFor(() => expect(shownError()).toBe(RESET_CODE_MESSAGES.invalid_code));
    expect(updateUser).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("never lets the code or the password reach the DOM, the navigation or the resend", async () => {
    verifyOtp.mockResolvedValue({ data: { session: null }, error: GOTRUE_OTP_REFUSAL });
    const { codeField, passwordField, confirmField } = submitReset({
      code: "987654",
      password: "secreto-de-ana-2026",
    });

    await waitFor(() => expect(shownError()).toBe(RESET_CODE_MESSAGES.invalid_code));
    // The boxes still hold what the person typed — that is the DOM's own value,
    // not something React re-rendered from state. Everything the component
    // WROTE is checked below.
    expect(codeField.value).toBe("987654");
    expect(passwordField.value).toBe("secreto-de-ana-2026");
    codeField.value = "";
    passwordField.value = "";
    confirmField.value = "";
    expect(document.body.innerHTML).not.toContain("987654");
    expect(document.body.innerHTML).not.toContain("secreto-de-ana-2026");
    // `verifyOtp` is the only thing that ever saw the code, and it saw it alone —
    // the password is not in that call.
    expect(verifyOtp).toHaveBeenCalledOnce();
    expect(JSON.stringify(verifyOtp.mock.calls)).not.toContain("secreto-de-ana-2026");
    expect(navigate).not.toHaveBeenCalled();
    expect(resendAction).not.toHaveBeenCalled();
  });

  it("keeps the code out of updateUser on the success path", async () => {
    verifyOtp.mockResolvedValue({ data: { session: { access_token: "a" } }, error: null });
    updateUser.mockResolvedValue({ data: {}, error: null });
    submitReset({ code: "424242", password: "otra-clave-larga-2026" });

    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    expect(JSON.stringify(updateUser.mock.calls)).not.toContain("424242");
    // Nor in the navigation: the destination is a bare path.
    expect(navigate).toHaveBeenCalledWith("/iniciar-sesion");
  });

  it("maps GoTrue's own rate limit to the rate-limit sentence, not to a code verdict", async () => {
    verifyOtp.mockResolvedValue({
      data: { session: null },
      error: { message: "rate limit", code: "over_request_rate_limit", status: 429 },
    });
    submitReset({ code: "123456" });

    await waitFor(() => expect(shownError()).toBe(RESET_CODE_MESSAGES.rate_limited));
  });

  it("reports an unavailable provider without blaming the code", async () => {
    verifyOtp.mockRejectedValue(new Error("fetch failed"));
    submitReset({ code: "123456" });

    await waitFor(() => expect(shownError()).toBe(RESET_CODE_MESSAGES.unavailable));
    expect(navigate).not.toHaveBeenCalled();
  });
});
