// LoginFormView submit-contract tests (task #39).
//
// The GO-blocker "login clicks silently dropped" class is only survivable
// because the submit button is a plain type="submit" INSIDE the
// <form action={…}>: React/Next serialize that into a progressively-enhanced
// native POST (action="" method="POST" + $ACTION hidden inputs), so a click
// works even before hydration completes or with JS disabled. These tests pin
// that structural contract plus the two feedback states (pending, error) so a
// refactor can't silently reintroduce the dead button.
//
// Pattern: renderToStaticMarkup (same as skeleton.test.tsx) against the
// presentational LoginFormView — no React-hook mocking needed.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The view only needs the AuthFormState *type* from the actions module, but
// importing it at runtime would pull the whole server graph into the test.
vi.mock("@/app/actions/auth", () => ({ loginAction: vi.fn() }));

import { LoginFormView } from "@/app/(auth)/iniciar-sesion/LoginForm";

const noopAction = () => {};

function render(overrides: Partial<Parameters<typeof LoginFormView>[0]> = {}) {
  return renderToStaticMarkup(
    <LoginFormView
      state={{ error: null }}
      formAction={noopAction}
      isPending={false}
      returnTo={null}
      {...overrides}
    />,
  );
}

describe("LoginFormView — submit contract", () => {
  it("renders an enabled type=submit button INSIDE the form (progressive-enhancement contract)", () => {
    const html = render();
    const formEnd = html.indexOf("</form>");
    expect(formEnd).toBeGreaterThan(-1);
    const insideForm = html.slice(0, formEnd);
    // The submit button lives inside the form element…
    expect(insideForm).toContain('type="submit"');
    expect(insideForm).toContain("Iniciar sesión");
    // …and is not disabled at rest (a disabled submit drops clicks silently).
    const buttonStart = insideForm.indexOf('type="submit"');
    const buttonTag = insideForm.slice(insideForm.lastIndexOf("<button", buttonStart), buttonStart);
    expect(buttonTag).not.toContain("disabled");
  });

  it("carries the returnTo round-trip as a hidden input when present", () => {
    const html = render({ returnTo: "/adoptar/DIM-XXXX" });
    expect(html).toContain('name="returnTo"');
    expect(html).toContain('value="/adoptar/DIM-XXXX"');
    // And omits it entirely when absent.
    expect(render()).not.toContain('name="returnTo"');
  });

  it("disables the button and shows the pending label while submitting", () => {
    const html = render({ isPending: true });
    expect(html).toContain("Ingresando...");
    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain(">Iniciar sesión<");
  });

  it("surfaces a failed submit as a visible role=alert block (never silent)", () => {
    const html = render({ state: { error: "Correo o contraseña incorrectos." } });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Correo o contraseña incorrectos.");
  });

  it("renders no alert at rest", () => {
    expect(render()).not.toContain('role="alert"');
  });
});
