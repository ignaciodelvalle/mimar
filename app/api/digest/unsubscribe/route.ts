// Public unsubscribe endpoint for the daily operator digest (T2-N1) —
// "works without login". The mailed link carries `u` (userId, opaque — not
// PII) and `t` (a signed, non-expiring, per-user token, see
// lib/infra/digest-unsubscribe-token.ts). No session, no cookie, no CSRF
// token: the capability to opt THIS user out lives entirely in the MAC, which
// can never flip any other account's flag.
//
// GET NEVER WRITES (security review, 2026-09-18). The first version flipped
// the flag on GET and called link prefetch "harmless" because the write is
// idempotent. Idempotent is not harmless: mail security scanners (Microsoft
// Defender Safe Links, Mimecast, Proofpoint) and some clients FETCH every link
// in a message on delivery. On a government mailbox that meant the operator
// was opted out of the digest before a human ever opened it — a silent loss
// of exactly the reminder this feature exists to deliver. So:
//
//   GET   validates the token and renders a CONFIRM page whose only action is
//         a `<form method="post">` carrying `u` and `t`. A scanner that
//         fetches the link sees a page and changes nothing.
//   POST  re-validates and flips. Two callers:
//           - the confirm page's form (u, t in the form body);
//           - RFC 8058 one-click: the mail provider POSTs
//             `List-Unsubscribe=One-Click` to the List-Unsubscribe URL, whose
//             query string carries u and t. That request is made on the
//             user's explicit "unsubscribe" click in the mail client, which
//             is what RFC 8058 guarantees and why it may flip directly.
//
// No auth guard from lib/infra/auth-guards.ts applies here on purpose — this
// route is the one deliberate exception to "every write is behind a session",
// the same way the denuncia reporter's magic link is
// (lib/infra/denuncia-reporter-token.ts).
//
// XSS: nothing request-derived is rendered before it is validated, and what is
// rendered (u is a UUID, t is base64url) is still HTML-escaped.

import { type NextRequest, NextResponse } from "next/server";

import { validateDigestUnsubscribeToken } from "@/lib/infra/digest-unsubscribe-token";
import { setDailyDigestOptOutForUser } from "@/src/modules/pets/application/profile/set-daily-digest-opt-out";

export const dynamic = "force-dynamic";

const ONE_CLICK_FIELD = "List-Unsubscribe";
const ONE_CLICK_VALUE = "One-Click";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `inner` is trusted markup built by this file; every value in it is escaped. */
function htmlPage(title: string, inner: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="es-AR"><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(title)} · miMAR</title></head>
    <body style="font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 16px;color:#1a1a1a;">
      <h1 style="font-size:20px;">${escapeHtml(title)}</h1>
      ${inner}
      <p><a href="/cuenta">Ir a tu cuenta</a></p>
    </body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // A capability URL: never cache it, never leak it onward.
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

function paragraph(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

function invalidLinkPage(): NextResponse {
  return htmlPage(
    "Enlace inválido",
    paragraph(
      "Este enlace para dejar de recibir el resumen diario no es válido o ya no funciona. Podés gestionar esta preferencia desde tu cuenta.",
    ),
  );
}

function confirmPage(userId: string, token: string): NextResponse {
  return htmlPage(
    "Dejar de recibir el resumen diario",
    `${paragraph(
      "Vas a dejar de recibir por correo el resumen diario de pendientes de miMAR. Podés reactivarlo cuando quieras desde tu cuenta.",
    )}
      <form method="post" action="/api/digest/unsubscribe">
        <input type="hidden" name="u" value="${escapeHtml(userId)}" />
        <input type="hidden" name="t" value="${escapeHtml(token)}" />
        <button type="submit" style="font:inherit;padding:10px 16px;border-radius:8px;border:0;background:#1a1a1a;color:#fff;cursor:pointer;">Confirmar baja</button>
      </form>`,
  );
}

async function optOut(userId: string): Promise<NextResponse> {
  try {
    await setDailyDigestOptOutForUser(userId, true);
  } catch (err) {
    console.error("[digest/unsubscribe] failed to opt out", userId, err);
    return htmlPage(
      "No pudimos procesar tu pedido",
      paragraph("Ocurrió un error. Probá de nuevo más tarde o gestionalo desde tu cuenta."),
      500,
    );
  }
  return htmlPage(
    "Listo",
    paragraph(
      "No vas a recibir más el resumen diario de pendientes por correo. Podés reactivarlo cuando quieras desde tu cuenta.",
    ),
  );
}

// @no-auth-required: this endpoint IS the authentication step — the mailed link carries a signed, per-user token (validateDigestUnsubscribeToken) that is the whole capability. GET only validates and renders a confirm form; it never writes.
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("u") ?? "";
  const token = request.nextUrl.searchParams.get("t") ?? "";

  if (!validateDigestUnsubscribeToken(userId, token)) return invalidLinkPage();
  return confirmPage(userId, token);
}

// @no-auth-required: the signed per-user token (validateDigestUnsubscribeToken) is the whole capability, re-validated here; it can only opt that one user out. Serves the confirm form and RFC 8058 one-click POSTs from mail providers, which carry no session by design.
export async function POST(request: NextRequest) {
  let form: FormData | null = null;
  try {
    form = await request.formData();
  } catch {
    // An empty or non-form body is fine for one-click senders that put
    // everything in the URL; the fields below then come from the query.
    form = null;
  }

  const field = (name: string): string => {
    const fromBody = form?.get(name);
    if (typeof fromBody === "string" && fromBody !== "") return fromBody;
    return request.nextUrl.searchParams.get(name) ?? "";
  };

  const userId = field("u");
  const token = field("t");
  const oneClick = form?.get(ONE_CLICK_FIELD) === ONE_CLICK_VALUE;

  if (!validateDigestUnsubscribeToken(userId, token)) {
    // RFC 8058 senders only read the status; a person reads the page.
    if (oneClick) return new NextResponse(null, { status: 400 });
    return invalidLinkPage();
  }

  const response = await optOut(userId);
  if (oneClick) return new NextResponse(null, { status: response.status });
  return response;
}
