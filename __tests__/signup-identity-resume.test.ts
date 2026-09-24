// Route test — /signup, the authenticated-visitor guard.
//
// THE BUG (staging, 2026-08-01): 15 of 25 owner profiles were stuck on the
// handle_new_user trigger's provisional, email-derived display_name, the newest
// created that same morning. The reported symptom was "our new accounts went
// straight to /mis-mascotas after email and password".
//
// The two-step form was already correct. This page was not:
//
//     if (user) redirect(returnTo ?? "/mis-mascotas");
//
// Signup step 1 is a Server Action ON THIS ROUTE. supabase.auth.signUp writes
// the session cookie, Next.js re-renders the page as part of the same action
// response, getUser() now returns the new user, and this guard fired — the
// client router left for /mis-mascotas before the form's step-2 effect could
// paint. Email confirmation was never involved (enable_confirmations = false,
// supabase/config.toml — accounts are auto-confirmed at creation, which is why
// all 15 read as "confirmed").
//
// The contract pinned here:
//   - authenticated + identity COMPLETE   → redirect away (unchanged)
//   - authenticated + identity PROVISIONAL → stay, render step 2 (the fix)
//   - anonymous                            → stay, render step 1 (unchanged)
//
// Note on assertion style: `rejects.toThrow(/REDIRECT/)` alone proves nothing —
// it passes for any throw from anywhere in the page. Every redirect case below
// also asserts the captured TARGET, and every stay case asserts redirect was
// never called at all.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRedirect } = vi.hoisted(() => ({
  mockRedirect: vi.fn((url: string): never => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => mockRedirect(url),
}));

const { mockGetUser, mockGetProfileCached } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockGetProfileCached: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: () => mockGetUser() },
  })),
}));

vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: (userId: string) => mockGetProfileCached(userId),
}));

import SignupPage from "@/app/(auth)/registro/page";

const EMAIL = "qa-maintainer+cursor-owner2@example.com";
const PROVISIONAL = "qa-maintainer+cursor-owner2";
const USER_ID = "user-0001";

function anonymous() {
  mockGetUser.mockResolvedValue({ data: { user: null } });
}

function authenticatedWith(displayName: string) {
  mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID, email: EMAIL } } });
  mockGetProfileCached.mockResolvedValue({ id: USER_ID, displayName, role: "owner" });
}

/** Render the page and return its element tree, failing loudly on a redirect. */
async function renderPage(searchParams: Record<string, string> = {}) {
  return SignupPage({ searchParams: Promise.resolve(searchParams) });
}

beforeEach(() => {
  mockRedirect.mockClear();
  mockGetUser.mockReset();
  mockGetProfileCached.mockReset();
});

describe("/signup — authenticated visitor guard", () => {
  it("keeps an authenticated user whose display_name is still the email local part", async () => {
    authenticatedWith(PROVISIONAL);

    await renderPage();

    // The whole bug in one assertion: this user must NOT be bounced out.
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("mounts the form at step 2 for that user, not step 1", async () => {
    authenticatedWith(PROVISIONAL);

    const tree = await renderPage();
    const form = findSignupForm(tree);

    expect(form.props.initialStep).toBe("identity");
  });

  it("keeps an authenticated user whose display_name is blank", async () => {
    authenticatedWith("");

    const tree = await renderPage();

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(findSignupForm(tree).props.initialStep).toBe("identity");
  });

  it("still bounces an authenticated user who already has a real name", async () => {
    authenticatedWith("Ignacio Del Valle");

    await expect(renderPage()).rejects.toThrow(/REDIRECT/);

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    expect(mockRedirect).toHaveBeenCalledWith("/mis-mascotas");
  });

  it("honours returnTo when bouncing a user who already has a real name", async () => {
    authenticatedWith("Ignacio Del Valle");

    await expect(renderPage({ returnTo: "/adoptar" })).rejects.toThrow(/REDIRECT/);

    expect(mockRedirect).toHaveBeenCalledWith("/adoptar");
  });

  it("leaves an anonymous visitor on step 1 and never reads a profile", async () => {
    anonymous();

    const tree = await renderPage();

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockGetProfileCached).not.toHaveBeenCalled();
    expect(findSignupForm(tree).props.initialStep).toBe("account");
  });

  it("swaps the headline to resume copy instead of telling an existing user to 'Crear cuenta'", async () => {
    authenticatedWith(PROVISIONAL);

    const text = renderedText(await renderPage());

    expect(text).toContain("Completá tu perfil");
    expect(text).not.toContain("Crear cuenta");
    // "¿Ya tenés cuenta? Iniciar sesión" is nonsense for someone already signed in.
    expect(text).not.toContain("Iniciar sesión");
  });

  it("keeps the normal signup headline for an anonymous visitor", async () => {
    anonymous();

    const text = renderedText(await renderPage());

    expect(text).toContain("Crear cuenta");
    expect(text).not.toContain("Completá tu perfil");
  });
});

// ---------------------------------------------------------------------------
// THE WAY BACK OUT OF THIS PAGE (native QA batch 2, D6)
//
// Two defects, one screen. A signed-out visitor's only exit is the "¿Ya tenés
// cuenta? Iniciar sesión" link, and it DROPPED the destination unless an
// `intent` happened to be present too — so the round trip this page and the
// login page both document was only half real. And the native app opens this
// URL for somebody who already HAS an account (apps/mobile/app/
// identidad-pendiente.tsx), on a browser that does not carry the app's session,
// so what they were shown was "Crear cuenta — Paso 1 de 2": the natural action
// on the screen was to create a SECOND account.
//
// The other half of the round trip — loginAction honouring a same-origin
// returnTo and refusing an off-origin one — is pinned in
// __tests__/auth-actions.test.ts ("honors a safe returnTo…", "ignores an unsafe
// (off-origin) returnTo…"). What is pinned HERE is that the link hands it one.
// ---------------------------------------------------------------------------

describe("/registro — the login link carries the destination", () => {
  it("carries returnTo even when there is no intent", async () => {
    anonymous();

    const href = loginHrefFrom(await renderPage({ returnTo: "/mis-mascotas/DIM-ABCD-1234" }));

    expect(href).toBe("/iniciar-sesion?returnTo=%2Fmis-mascotas%2FDIM-ABCD-1234");
  });

  it("carries intent and returnTo together", async () => {
    anonymous();

    const href = loginHrefFrom(
      await renderPage({ intent: "apply", returnTo: "/adoptar/DIM-ABCD-1234/postular" }),
    );

    expect(href).toBe(
      "/iniciar-sesion?intent=apply&returnTo=%2Fadoptar%2FDIM-ABCD-1234%2Fpostular",
    );
  });

  it("refuses to put an off-origin returnTo on the link", async () => {
    anonymous();

    const href = loginHrefFrom(await renderPage({ returnTo: "//evil.example/phish" }));

    // Sanitized by safeReturnTo before it is ever written into an href: a
    // protocol-relative path leaves the origin, and a login link that carried it
    // would send somebody's next credential entry to another host.
    expect(href).toBe("/iniciar-sesion");
    expect(href).not.toContain("evil.example");
  });

  it("refuses a returnTo with a scheme", async () => {
    anonymous();

    const href = loginHrefFrom(await renderPage({ returnTo: "https://evil.example/phish" }));

    expect(href).toBe("/iniciar-sesion");
    expect(href).not.toContain("evil.example");
  });

  it("leaves the link bare when there is nothing to carry", async () => {
    anonymous();

    expect(loginHrefFrom(await renderPage())).toBe("/iniciar-sesion");
  });
});

describe("/registro — the app handoff (?from=app), signed out", () => {
  it("says the visitor already has an account instead of offering only a signup form", async () => {
    anonymous();

    const text = renderedText(await renderPage({ from: "app" }));

    expect(text).toContain("Ya tenés cuenta en miMAR");
    expect(text).toContain("Completá tu registro");
  });

  it("points the login CTA back at this page so the missing step is waiting after sign-in", async () => {
    anonymous();

    const href = loginHrefFrom(await renderPage({ from: "app" }));

    // Back to /registro, not to the role landing: the identity-pending guard at
    // the top of this page then keeps the visitor here and mounts step 2.
    expect(href).toBe("/iniciar-sesion?returnTo=%2Fregistro%3Ffrom%3Dapp");
  });

  it("puts the login CTA BEFORE the signup form", async () => {
    anonymous();

    const order = ctaThenFormOrder(await renderPage({ from: "app" }));

    expect(order.loginIndex).toBeGreaterThanOrEqual(0);
    expect(order.formIndex).toBeGreaterThanOrEqual(0);
    expect(order.loginIndex).toBeLessThan(order.formIndex);
  });

  it("still renders the signup form — the marker is a query param, not an authorization", async () => {
    anonymous();

    const tree = await renderPage({ from: "app" });

    expect(findSignupForm(tree).props.initialStep).toBe("account");
  });

  // SAYING THE FORM WAS SECONDARY WAS NOT ENOUGH (batch-4 QA, 2026-09-05). The
  // panel above already led with "Ya tenés cuenta en miMAR" and the signup form
  // still rendered underneath at full prominence — four labelled inputs and a
  // filled CTA read as THE form on the page whatever the paragraph above says.
  // Testers filled it in and created a second account for an address that
  // already had one; the duplicate masquerade then answered "ya podés ingresar"
  // with no explanation, because the server must not confirm the address exists.
  it("collapses the signup form behind a disclosure on the handoff face", async () => {
    anonymous();

    const tree = await renderPage({ from: "app" });

    expect(isInsideDetails(tree, "SignupForm")).toBe(true);
  });

  it("leaves the signup form open on every other face", async () => {
    anonymous();

    // The default face and the resume face both LEAD with the form; hiding it
    // there would collapse the only thing the page is for.
    expect(isInsideDetails(await renderPage(), "SignupForm")).toBe(false);

    authenticatedWith(PROVISIONAL);
    expect(isInsideDetails(await renderPage({ from: "app" }), "SignupForm")).toBe(false);
  });

  it("lets an explicit returnTo win over the self-return", async () => {
    anonymous();

    const href = loginHrefFrom(await renderPage({ from: "app", returnTo: "/mis-mascotas" }));

    expect(href).toBe("/iniciar-sesion?returnTo=%2Fmis-mascotas");
  });

  it("shows no handoff panel without the marker", async () => {
    anonymous();

    const text = renderedText(await renderPage());

    expect(text).not.toContain("Ya tenés cuenta en miMAR");
    // The ordinary trailing link is still the way out on that face.
    expect(text).toContain("¿Ya tenés cuenta?");
  });

  it("shows no handoff panel to an authenticated visitor resuming step 2", async () => {
    authenticatedWith(PROVISIONAL);

    const text = renderedText(await renderPage({ from: "app" }));

    expect(text).not.toContain("Ya tenés cuenta en miMAR");
    expect(text).toContain("Completá tu perfil");
  });
});

// ---------------------------------------------------------------------------
// Tiny element-tree helpers. The page is a Server Component returning plain
// React elements — no renderer needed, and walking the tree lets us assert on
// the props actually handed to SignupForm.
// ---------------------------------------------------------------------------

type Node = { type?: unknown; props?: { children?: unknown; [k: string]: unknown } };

function walk(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  visit(n);
  walk(n.props?.children, visit);
}

/**
 * Whether the named component sits inside a `<details>` on this page.
 *
 * Walks the tree keeping a depth counter of open `details` ancestors, so the
 * answer is about CONTAINMENT rather than about the two elements both existing.
 * `walk` is depth-first pre-order and only descends through `props.children`,
 * which is the same containment the DOM will have.
 */
function isInsideDetails(tree: unknown, componentName: string): boolean {
  let found = false;
  const visit = (node: unknown, insideDetails: boolean): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, insideDetails);
      return;
    }
    if (!node || typeof node !== "object") return;
    const n = node as Node;
    if (
      insideDetails &&
      typeof n.type === "function" &&
      (n.type as { name?: string }).name === componentName
    ) {
      found = true;
    }
    visit(n.props?.children, insideDetails || n.type === "details");
  };
  visit(tree, false);
  return found;
}

function findSignupForm(tree: unknown): { props: Record<string, unknown> } {
  let found: { props: Record<string, unknown> } | null = null;
  walk(tree, (n) => {
    if (typeof n.type === "function" && (n.type as { name?: string }).name === "SignupForm") {
      found = { props: (n.props ?? {}) as Record<string, unknown> };
    }
  });
  if (!found) throw new Error("SignupForm was not rendered");
  return found;
}

/**
 * The one href on the page that points at the login form.
 *
 * Deliberately looks for ANY node with a `/iniciar-sesion` href rather than a
 * named component: the page renders the link from two places (the handoff panel
 * and the trailing "¿Ya tenés cuenta?" line) and never both at once, so "the
 * login link" is unambiguous — and this helper fails loudly if that stops being
 * true instead of silently asserting on whichever one it found first.
 */
function loginHrefFrom(tree: unknown): string {
  const hrefs: string[] = [];
  walk(tree, (n) => {
    const href = n.props?.href;
    if (typeof href === "string" && href.startsWith("/iniciar-sesion")) hrefs.push(href);
  });
  if (hrefs.length !== 1) {
    throw new Error(`expected exactly one login link, found ${hrefs.length}: ${hrefs.join(", ")}`);
  }
  return hrefs[0] as string;
}

/**
 * Where the login CTA and the signup form sit relative to each other.
 *
 * `walk` is depth-first pre-order, which for this tree is document order — the
 * property the assertion is about. Visual order is CSS's problem; DOM order is
 * what a screen reader and a keyboard follow, and it is what "the login CTA
 * first" has to mean to be worth pinning.
 */
function ctaThenFormOrder(tree: unknown): { loginIndex: number; formIndex: number } {
  let index = 0;
  let loginIndex = -1;
  let formIndex = -1;
  walk(tree, (n) => {
    const position = index++;
    const href = n.props?.href;
    if (loginIndex === -1 && typeof href === "string" && href.startsWith("/iniciar-sesion")) {
      loginIndex = position;
    }
    if (
      formIndex === -1 &&
      typeof n.type === "function" &&
      (n.type as { name?: string }).name === "SignupForm"
    ) {
      formIndex = position;
    }
  });
  return { loginIndex, formIndex };
}

function renderedText(tree: unknown): string {
  const parts: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const c of node) collect(c);
      return;
    }
    if (!node || typeof node !== "object") return;
    collect((node as Node).props?.children);
  };
  collect(tree);
  return parts.join(" ");
}
