import type { Metadata } from "next";
import Link from "next/link";

import { CONTACT_EMAILS, OPERATOR_HELP_EMAIL, mailtoHref } from "@/lib/ui/contact";

export const metadata: Metadata = {
  title: "Sugerencias — miMAR",
  description: "Escribinos tus sugerencias o problemas con miMAR — Mi Mascota Argentina.",
};

/**
 * /sugerencias — the written channel to a person (pilot T1-P5).
 *
 * It used to be a "muy pronto" placeholder with no way to send anything, while
 * /accesibilidad sent people here to report barriers. The smaller honest fix
 * was not a form nobody would triage but the mailbox that already exists and
 * is read: the same address the operator shells' "¿Necesitás ayuda?" and the
 * crons-down banner name (OPERATOR_HELP_EMAIL, lib/ui/contact.ts).
 */
export default function SugerenciasPage() {
  return (
    <div className="bg-[var(--color-ln-paper)]">
      <div className="mx-auto max-w-2xl px-6 py-16 space-y-6">
        <h1
          className="text-3xl font-semibold tracking-[-0.015em] leading-tight text-[var(--color-ln-ink)]"
          style={{ fontFamily: "var(--font-ln-serif)" }}
        >
          Hacer una sugerencia
        </h1>
        <div className="rounded-xl border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-6 py-8 space-y-3">
          <p className="text-base font-semibold text-[var(--color-ln-ink)]">
            Escribinos a{" "}
            <a
              href={mailtoHref(OPERATOR_HELP_EMAIL, { subject: "miMAR — sugerencia" })}
              className="text-[var(--color-ln-azul)] underline underline-offset-4"
            >
              {OPERATOR_HELP_EMAIL}
            </a>
          </p>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            Sirve para ideas, para contarnos algo que no funciona y para reportar una barrera de
            accesibilidad: decinos qué pasó, en qué pantalla y, si podés, sumá una captura.
          </p>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            Para pedir acceso, corrección o eliminación de tus datos personales, escribí a{" "}
            <a
              href={mailtoHref(CONTACT_EMAILS.privacy)}
              className="text-[var(--color-ln-azul)] underline underline-offset-4"
            >
              {CONTACT_EMAILS.privacy}
            </a>
            .
          </p>
        </div>
        <Link
          href="/"
          className="inline-block text-md text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          ← Volver al inicio
        </Link>
      </div>
    </div>
  );
}
