import Link from "next/link";

// Branded, Spanish 404 body shared by every route group's not-found.tsx, so a
// wrong/expired URL never lands on Next.js's black English default ("This page
// could not be found"). UX audit remediation — Fase 0 item 0.4, extended to the
// admin / gob / (app) groups (admin fresh-sweep A1). Each group passes copy +
// exit links suited to its context; the (public) credential case keeps its
// specific wording.
export function BrandedNotFound({
  title = "No encontramos esta página",
  body = "El enlace puede estar mal tipeado, o la página pudo haber cambiado de lugar o dado de baja.",
  primary = { href: "/", label: "Volver al inicio" },
  secondary,
}: {
  title?: string;
  body?: string;
  primary?: { href: string; label: string };
  secondary?: { href: string; label: string };
}) {
  return (
    // data-testid is a COPY-INDEPENDENT hook for the e2e "is this page the page
    // I think it is?" guard (e2e/_page-identity.ts). Matching on the heading
    // text alone already failed once: A7's assertRealPage() looked for
    // "No encontramos esta página" and therefore did not recognise the
    // (public) group's "No encontramos esa credencial" — the very boundary it
    // was written to catch. A wording change must not be able to disarm a gate.
    <div
      data-testid="branded-not-found"
      className="mx-auto flex max-w-md flex-col items-center px-6 py-20 text-center"
    >
      <div
        className="mb-5 inline-flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-ln-celeste-050)] text-3xl text-[var(--color-ln-azul)]"
        aria-hidden="true"
      >
        ?
      </div>
      <h1
        className="text-3xl font-semibold tracking-[-0.015em] text-[var(--color-ln-ink)]"
        style={{ fontFamily: "var(--font-ln-serif)" }}
      >
        {title}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--color-ln-ink-2)]">{body}</p>
      <div className="mt-6 flex w-full flex-col gap-3 sm:flex-row">
        <Link
          href={primary.href}
          className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full bg-[var(--color-ln-azul)] px-5 text-sm font-semibold text-white no-underline transition-opacity hover:opacity-90"
        >
          {primary.label}
        </Link>
        {secondary && (
          <Link
            href={secondary.href}
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full border border-[var(--color-ln-line-strong)] bg-white px-5 text-sm font-semibold text-[var(--color-ln-ink)] no-underline transition-colors hover:bg-[var(--color-ln-stripe)]"
          >
            {secondary.label}
          </Link>
        )}
      </div>
    </div>
  );
}
