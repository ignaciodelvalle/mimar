// /denuncias/codigo/[code] — the constancia stub. NOT the denuncia.
//
// WHAT THIS PAGE USED TO BE, because the diff is the argument. A holder of a
// shareable DEN-XXXX-XXXX string, with no session of any kind, was served: the
// denunciante's full free-text account, the description of the ACCUSED, the
// locality and province, a coarsened map point, the reporter's masked contact,
// and signed URLs to every photo and video of evidence.
//
// The mitigations that were in place protected the wrong subject. Redacting the
// pet's name, dropping the credential deep-link, hiding internal notes and
// operator names all lower re-identification of the ANIMAL and of the STAFF. The
// person at risk is the accused, and the fields that identify them were exactly
// the ones rendered. Coarsening a coordinate defends against a precision
// attack; it does nothing against a sentence. In a town of five thousand, a
// physical description plus a coarse point is one person — and this is an
// UNVERIFIED allegation of a crime that carries prison (Ley 14.346 art. 1),
// published to an indeterminate audience at a permanently addressable URL with
// nothing telling a crawler to stay away.
//
// WHAT IT IS NOW. Existence + the date + a door. Nothing else. Specifically:
//
//   • "Este código corresponde a una denuncia registrada" — the code holder
//     typed the code, so this confirms only what they already asserted.
//   • The date it was registered — the constancia function. A date says nothing
//     about the accused, the place, or the facts.
//   • A prompt to prove they are the denunciante (see SolicitarAccesoForm).
//
// STATUS IS DELIBERATELY WITHHELD, even though it names nobody. Status is
// process information about an investigation into a person named in the file,
// and a bare string is not an identity. The reporter gets the full timeline one
// factor later, on /denuncias/seguimiento.
//
// The full reporter view lives at /denuncias/seguimiento behind
// lib/infra/denuncia-reporter-token.ts. Nothing on THIS page is gated by
// anything, so nothing on this page may be sensitive.

import { LnButton } from "@/components/ui/Button";
import { db, welfareReports } from "@/db";
import {
  REPORTER_SESSION_COOKIE_NAME,
  readReporterSessionCookie,
} from "@/lib/infra/denuncia-reporter-token";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { formatDateTime } from "@/lib/utils/format";
import {
  isValidReferenceCodeFormat,
  normalizeReferenceCode,
} from "@/src/modules/welfare/domain/reference-code";
import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CopyCodeButton } from "./CopyCodeButton";
import { SolicitarAccesoForm } from "./SolicitarAccesoForm";

// A denuncia URL must never be indexable. There is no robots.txt in this repo,
// so a leaked URL had nothing at all telling a crawler to stay out. Belt and
// braces: this metadata plus the `X-Robots-Tag` + `Referrer-Policy: no-referrer`
// headers scoped to this subtree in next.config.ts — the header also covers
// non-HTML responses and any redirect, which page metadata cannot.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

async function callerIpFromHeaders(): Promise<string> {
  try {
    const reqHeaders = await headers();
    return callerIp(reqHeaders);
  } catch {
    return "unknown";
  }
}

// Soft throttle notice (not a hard error) so a legitimate reporter refreshing
// their own code is never locked out — mirrors the /p/[publicToken] guard.
function ReceiptThrottleNotice() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-ln-paper)]">
      <div className="mx-auto max-w-[400px] px-6 py-12 text-center text-[var(--color-ln-ink)]">
        <p className="mb-3 text-lg font-semibold" style={{ fontFamily: "var(--font-ln-serif)" }}>
          Demasiadas consultas
        </p>
        <p className="text-md leading-[1.6] text-[var(--color-ln-ink-2)]">
          Estás realizando demasiadas consultas desde esta conexión. Esperá unos minutos y volvé a
          intentarlo.
        </p>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="text-xs uppercase tracking-[.1em] font-semibold text-[var(--color-ln-mute)]"
      style={{ fontFamily: "var(--font-ln-mono)" }}
    >
      {children}
    </h2>
  );
}

export default async function WelfareReportByCodePage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ nueva?: string }>;
}) {
  const { code: rawCode } = await params;
  const { nueva } = await searchParams;
  const code = normalizeReferenceCode(decodeURIComponent(rawCode));
  if (!isValidReferenceCodeFormat(code)) notFound();

  // Per-IP rate limit BEFORE any data fetch. The page no longer discloses the
  // report, but it is still an unauthenticated read that issues a DB query on
  // every hit, and it still answers "does this code exist" — which is precisely
  // the oracle an enumeration attack needs. The code is high entropy (~31^8) so
  // blind enumeration is impractical, and this guard keeps it that way.
  const ip = await callerIpFromHeaders();
  try {
    await enforceRateLimit("denuncia_receipt", ip, { maxPerMinute: 30, maxPerHour: 200 });
  } catch (err) {
    if (err instanceof RateLimitError) return <ReceiptThrottleNotice />;
    throw err;
  }

  // Only the two columns this page is allowed to render. Selecting the row with
  // `select()` would pull description/subjectDescription/coordinates into the
  // render scope and leave the boundary one careless JSX line away; a projection
  // makes the leak impossible rather than merely absent.
  const [report] = await db
    .select({ id: welfareReports.id, createdAt: welfareReports.createdAt })
    .from(welfareReports)
    .where(eq(welfareReports.referenceCode, code))
    .limit(1);
  if (!report) notFound();

  // Is the caller already authenticated as THIS report's reporter? Almost always
  // the person who submitted seconds ago and arrived with a fresh session cookie.
  //
  // WHY A LINK AND NOT A REDIRECT. This URL is the one the reporter keeps — the
  // post-submit landing, the thing they screenshot, the entry in their history
  // that carries the constancia code. Bouncing them to /denuncias/seguimiento
  // would strip the code out of the address bar at the exact moment they are
  // being told to save it. So the code stays in a URL that discloses nothing, and
  // the sensitive view lives at a URL that carries no identifier at all — which
  // is also why nothing on THAT page is worth leaking through a `Referer`.
  const jar = await cookies();
  const session = readReporterSessionCookie(jar.get(REPORTER_SESSION_COOKIE_NAME)?.value);
  const isReporter = session !== null && session.reportId === report.id;

  // S8-F03, preserved: `?nueva=1` declares an INTENTION, but anyone can type a
  // URL, and this banner asserts a FACT in the present tense. Check it against
  // the data. Pasting `?nueva=1` onto a three-month-old code used to make the
  // receipt claim it had just been sent.
  const JUST_SUBMITTED_WINDOW_MS = 10 * 60 * 1000;
  const justSubmitted =
    nueva === "1" && Date.now() - new Date(report.createdAt).getTime() < JUST_SUBMITTED_WINDOW_MS;

  return (
    <div className="p-6 bg-[var(--color-ln-paper)]">
      <div className="max-w-lg mx-auto pt-6 space-y-8">
        <Link
          href="/denuncias/buscar"
          className="inline-block text-sm font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)] hover:text-[var(--color-ln-ink-2)] transition-colors no-underline"
          style={{ fontFamily: "var(--font-ln-mono)" }}
        >
          ← Buscar otra denuncia
        </Link>

        {justSubmitted && (
          <div className="rounded-[var(--radius-md)] border border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] px-5 py-5 space-y-2">
            <p className="text-sm font-semibold text-[var(--color-ln-ok)]">
              Tu denuncia fue registrada.
            </p>
            <p className="text-xs text-[var(--color-ln-ok)] leading-relaxed">
              Guardá el código de abajo. Es tu número de constancia y lo vas a necesitar para volver
              a ver el estado de tu denuncia.
            </p>
          </div>
        )}

        <header className="space-y-3">
          <h1
            className="text-3xl font-semibold tracking-[-0.015em] leading-tight text-[var(--color-ln-ink)]"
            style={{ fontFamily: "var(--font-ln-serif)" }}
          >
            Denuncia registrada
          </h1>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            Este código corresponde a una denuncia que quedó registrada. Guardalo: es tu número de
            constancia.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <p
              className="text-sm text-[var(--color-ln-mute)]"
              style={{ fontFamily: "var(--font-ln-mono)" }}
            >
              {code}
            </p>
            <CopyCodeButton code={code} />
          </div>
          <div
            className="text-xs text-[var(--color-ln-mute)]"
            style={{ fontFamily: "var(--font-ln-mono)" }}
          >
            Registrada {formatDateTime(report.createdAt)}
          </div>
        </header>

        {/* Why this page no longer shows the denuncia. The reporter deserves the
            reason: without it, the page reads as broken or as data loss. */}
        <section className="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-5 py-4">
          <SectionLabel>Por qué no se muestra el contenido</SectionLabel>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            Una denuncia describe a una persona que todavía no fue investigada. Antes, cualquiera
            que tuviera este código podía leer lo que contaste, la descripción de la persona
            denunciada y ver las fotos. Ya no: el código sirve para identificar tu denuncia, no para
            abrirla.
          </p>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            Tu denuncia está guardada y el organismo la recibe completa.
          </p>
        </section>

        {/* Already-authenticated reporter → straight through. Everyone else gets
            the second factor. Note the branch reveals nothing to a stranger: it
            can only be taken by someone whose cookie already carries a valid MAC
            over THIS report's id. */}
        {isReporter ? (
          <LnButton href="/denuncias/seguimiento" variant="primary" size="lg" block>
            Ver el seguimiento de mi denuncia →
          </LnButton>
        ) : (
          <SolicitarAccesoForm code={code} />
        )}
      </div>
    </div>
  );
}
