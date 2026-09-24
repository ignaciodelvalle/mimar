import { type IntentCopy, getIntentCopy } from "@/lib/domain/auth-intent-copy";
import { isIdentityPending } from "@/lib/domain/identity-completeness";
import { getProfileCached } from "@/lib/infra/request-cache";
import { safeReturnTo } from "@/lib/infra/role-landing";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SignupForm } from "./SignupForm";

// `intent=apply` + `returnTo=/adoptar/{token}/postular` come from the
// adoption listing's startApplyIntentAction. When that intent is present
// we swap the headline copy, skip the first-pet step after signup, and
// drop the visitor onto the postular page.
//
// Item 24.1: intent-aware copy map covers all supported intents (apply,
// foster, and future ones). SignupForm still receives the raw "apply" |
// null value because it drives flow logic (not copy), and today only
// "apply" has a flow branch. Other intents use the same form flow as the
// default path.

/**
 * The heading and subheading, as ONE decision over the four faces this page has.
 *
 * Extracted rather than inlined as nested ternaries: the two strings always move
 * together (a "Completá tu perfil" headline over "Creá la libreta digital de tu
 * mascota" is nonsense), and writing them as two independent ternary chains made
 * that pairing something the reader has to re-derive — as well as pushing the
 * page past biome's cognitive-complexity ceiling.
 *
 * ORDER IS PRECEDENCE. Resume beats the handoff (an authenticated visitor with
 * a provisional name is finishing, not choosing a door), and both beat the
 * intent copy — telling somebody who already has an account to "create" one is
 * the confusing part.
 */
function signupPageCopy(face: {
  identityPending: boolean;
  appHandoff: boolean;
  intentCopy: IntentCopy | null;
}): { headline: string; subcopy: string } {
  if (face.identityPending) {
    return {
      headline: "Completá tu perfil",
      subcopy: "Tu cuenta ya está creada. Nos falta tu nombre para completar tu credencial.",
    };
  }
  if (face.appHandoff) {
    return {
      headline: "Completá tu registro",
      subcopy: "Seguí desde donde quedaste en la app.",
    };
  }
  if (face.intentCopy) {
    return { headline: face.intentCopy.headline, subcopy: face.intentCopy.subcopy };
  }
  return { headline: "Crear cuenta", subcopy: "Creá la libreta digital de tu mascota" };
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ intent?: string; returnTo?: string; from?: string }>;
}) {
  const sp = await searchParams;
  // Preserve raw intent for the copy map. SignupForm still gets only
  // "apply" | null because flow-branching is limited to that value today.
  const rawIntent = sp.intent ?? null;
  const intent = rawIntent === "apply" ? "apply" : null;
  const returnTo = safeReturnTo(sp.returnTo);
  // THE NATIVE HANDOFF MARKER (native QA batch 2, D6). THE HANDOFF ITSELF IS
  // GONE as of 2026-09-07 — `identidad-pendiente` no longer opens anything in a
  // browser, because the DNI it was for left the signup form — but this marker
  // handling STAYS, and deliberately: an app build already installed in the
  // field still carries the old link compiled in, and a stale bookmark outlives
  // both. So read the present tense below as "a visitor arriving this way",
  // which is still possible, rather than as a path the current app can take.
  //
  // What it used to do: `identidad-pendiente` opened IDENTITY_COMPLETION_URL in
  // the browser to finish a registration that already had an account behind it
  // — and the browser opened SIGNED OUT, because
  // the app holds a bearer token and this page resolves a cookie
  // (apps/mobile/app/identidad-pendiente.tsx says so out loud). Without this
  // marker the page has no way to tell that visitor from a stranger, so it
  // showed "Crear cuenta — Paso 1 de 2" and the natural action on the screen was
  // to create a SECOND account. The marker does not authorize anything and is
  // never trusted for a decision that matters: all it changes is which of the
  // two doors is offered first.
  const fromApp = sp.from === "app";
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // THE LEAK (staging finding, 2026-08-01) — 60% of owner profiles were stuck
  // on the trigger's provisional, email-derived display_name.
  //
  // This guard used to be an unconditional `if (user) redirect(...)`. Signup
  // step 1 runs as a Server Action ON THIS ROUTE: supabase.auth.signUp writes
  // the session cookie, and Next.js then re-renders this page as part of the
  // same action response. getUser() now returns the brand new user, the guard
  // fired, and the client router navigated to /mis-mascotas BEFORE the form's
  // step-2 effect could ever paint. The account was left with only a
  // provisional name, and nothing ever brought the user back.
  //
  // The step-2 form was never the problem; this line was racing it. The fix is
  // to make the guard identity-aware: an authenticated visitor whose identity
  // is COMPLETE is bounced (unchanged behaviour — no logged-in user should sit
  // on a signup form), but one whose identity is still provisional is kept here
  // and shown step 2 directly. That also turns /signup into the resume surface:
  // close the tab, come back a week later, and the missing step is waiting.
  const identityPending =
    user !== null &&
    isIdentityPending({
      displayName: (await getProfileCached(user.id))?.displayName,
      email: user.email,
    });
  if (user && !identityPending) redirect(returnTo ?? "/mis-mascotas");

  const intentCopy = getIntentCopy(rawIntent);

  // The handoff face of this page: signed out, arrived from the app. `user`
  // being null is what makes it the SIGNED-OUT case — an authenticated visitor
  // with the same marker is already covered by `identityPending` above, which
  // mounts step 2 directly and needs no login CTA at all.
  const appHandoff = fromApp && user === null;
  const copy = signupPageCopy({ identityPending, appHandoff, intentCopy });

  // Build the login link — preserve intent + returnTo.
  //
  // TWO FIXES LIVE IN THESE LINES (native QA batch 2, D6).
  //
  // 1. `returnTo` USED TO SURVIVE ONLY ALONGSIDE AN INTENT. The old expression
  //    was `intent && returnTo ? … : intent ? … : "/iniciar-sesion"`, so a
  //    visitor who arrived at `/registro?returnTo=/mis-mascotas/X` and clicked
  //    "¿Ya tenés cuenta?" lost the destination on the way to the login form —
  //    the one link out of this page dropped the reason they were on it.
  //    `loginAction` has honoured a same-origin `returnTo` all along
  //    (src/modules/auth/application/login.ts, sanitized by `safeReturnTo`:
  //    relative path only, no scheme, no protocol-relative `//`, no backslash);
  //    the link simply never handed it one.
  //
  // 2. WITH THE APP'S HANDOFF MARKER AND NO EXPLICIT DESTINATION, the login link
  //    comes BACK HERE rather than to the role landing. That is what closes the
  //    loop the tester walked: sign in, return to `/registro?from=app`, and the
  //    identity-pending guard above keeps them on the page and mounts step 2.
  //    Without it they land on `/mis-mascotas` and have to notice the "Falta tu
  //    nombre" banner to find the step they came here to finish.
  //
  //    DELIBERATELY NOT DONE FOR EVERY VISITOR. A blanket self-`returnTo` would
  //    route a vet or a govt operator who clicked "Iniciar sesión" from this page
  //    through `/registro`, whose complete-identity guard falls back to
  //    `/mis-mascotas` — it would cost them their role landing. The marker is the
  //    evidence that the person is mid-registration; nothing else here is.
  const loginParams = new URLSearchParams();
  if (rawIntent) loginParams.set("intent", rawIntent);
  const loginReturnTo = returnTo ?? (fromApp ? "/registro?from=app" : null);
  if (loginReturnTo) loginParams.set("returnTo", loginReturnTo);
  const loginQuery = loginParams.toString();
  const loginHref = loginQuery === "" ? "/iniciar-sesion" : `/iniciar-sesion?${loginQuery}`;

  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center p-6 bg-[var(--color-ln-paper)]"
    >
      {/* Back link — lean, keeps the centered layout intact */}
      <div className="w-full max-w-sm mb-2">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-[var(--color-ln-ink-2)] no-underline hover:text-[var(--color-ln-azul)]"
        >
          ← Volver al inicio
        </Link>
      </div>
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          {/* 24.1 Intent-aware heading: contextual label when an intent is present. */}
          <h1
            id="auth-heading"
            className="font-ln-serif text-3xl font-semibold tracking-[-0.02em] text-[var(--color-ln-ink)]"
          >
            {copy.headline}
          </h1>
          {/* 24.1 Subcopy: tied to the heading via aria-describedby.
              Resume copy wins over intent copy — telling someone who already
              has an account to "create" one is the confusing part. */}
          <p className="text-sm text-[var(--color-ln-ink-2)]" aria-describedby="auth-heading">
            {copy.subcopy}
          </p>
        </div>
        {/* THE LOGIN DOOR FIRST, AND THE SIGNUP FORM SECOND (native QA batch 2,
            D6). Somebody who got here from the app HAS an account: the app sent
            them precisely because the server answered `profilePending: true` for
            it. The form below stays — the marker is a query parameter and a
            stranger can paste it — but the natural action on the screen has to
            be the one that is right for the person the link was built for. */}
        {appHandoff && (
          <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-paper-2)] px-4 py-4">
            <p className="text-sm text-[var(--color-ln-ink)]">
              Ya tenés cuenta en miMAR: iniciá sesión para completar tu registro. Es el mismo correo
              y la misma contraseña que usás en la app.
            </p>
            <Link
              href={loginHref}
              className="block w-full rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] px-4 py-3 text-center font-medium text-white no-underline hover:bg-[var(--color-ln-azul-700)]"
            >
              Iniciar sesión
            </Link>
          </div>
        )}
        {/* SAYING THE FORM IS SECONDARY WAS NOT ENOUGH (batch-4 QA, 2026-09-05).
            The panel above already led with "Ya tenés cuenta en miMAR", and the
            signup form still rendered underneath at full prominence — four
            labelled inputs and a filled CTA, which reads as THE form on the page
            whatever the paragraph above it says. Testers filled it in and made a
            second account for an address that already had one; the server's
            duplicate masquerade then answered them with "ya podés ingresar" and
            no explanation, because it must not confirm the address exists.
            (2 duplicate signups and 8 invalid-credential attempts in one hour of
            GoTrue log.)

            So on THIS face the form is collapsed behind a disclosure. It is
            still present and still one tap away — the marker is a query
            parameter, a stranger can paste it, and a genuine new visitor must
            not be locked out of signing up — but it is no longer competing with
            the door this page was opened for. `<details>` and not a client
            toggle: it works with JavaScript off, it is keyboard-operable and
            screen-reader-announced without any ARIA of ours, and this page is a
            Server Component with no client state of its own to spend. */}
        {appHandoff ? (
          <details>
            {/* BOTH marker rules, because `list-none` alone is a Blink/Gecko fix:
                WebKit draws the disclosure triangle from a shadow pseudo-element
                that ignores `list-style`, so Safari and every iOS browser would
                show a stray triangle beside a centred sentence. Paired the way
                every other summary in this repo pairs them (components/ui/Tabs.tsx). */}
            <summary className="cursor-pointer list-none text-center text-sm text-[var(--color-ln-ink-2)] underline underline-offset-4 hover:text-[var(--color-ln-azul)] [&::-webkit-details-marker]:hidden">
              ¿Todavía no tenés cuenta? Creá una
            </summary>
            <div className="mt-6">
              <SignupForm intent={intent} returnTo={returnTo} initialStep="account" />
            </div>
          </details>
        ) : (
          <SignupForm
            intent={intent}
            returnTo={returnTo}
            initialStep={identityPending ? "identity" : "account"}
          />
        )}
        {/* Meaningless to someone who is already signed in and just finishing
            their profile — they HAVE the account. Suppressed for the app handoff
            too, and for the opposite reason: that face already leads with the
            same link, in a panel, above the form. Two "Iniciar sesión" links to
            one destination on one screen is furniture. */}
        {!identityPending && !appHandoff && (
          <p className="text-center text-sm text-[var(--color-ln-ink-2)]">
            ¿Ya tenés cuenta?{" "}
            <Link
              href={loginHref}
              className="font-medium text-[var(--color-ln-ink)] underline underline-offset-4"
            >
              Iniciar sesión
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
