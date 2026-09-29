import type { Metadata } from "next";
import Link from "next/link";

import { OrgAccessForm } from "./OrgAccessForm";

export const metadata: Metadata = {
  title: "Solicitar acceso para organizaciones — miMAR",
  description:
    "Refugios, veterinarias y redes de rescate: pedí acceso verificado a miMAR — Mi Mascota Argentina.",
};

/**
 * /organizaciones/solicitar-acceso — where an organization asks for access
 * (critique 2026-09-29, M8).
 *
 * The landing's "Solicitar acceso" used to lead to /registro, the owner's
 * sign-up, so an organization landed in the wrong flow. Onboarding stays
 * admin-driven: this page only lets the organization ask, and says so. The
 * request is one email to our general mailbox; nothing is stored
 * (lib/outreach/org-access-request.ts).
 */
export default function SolicitarAccesoOrganizacionPage() {
  return (
    <div className="bg-[var(--color-ln-paper)]">
      <div className="mx-auto max-w-2xl space-y-6 px-6 py-16">
        <div className="space-y-3">
          <h1
            className="text-3xl font-semibold leading-tight tracking-[-0.015em] text-[var(--color-ln-ink)]"
            style={{ fontFamily: "var(--font-ln-serif)" }}
          >
            Solicitar acceso para tu organización
          </h1>
          <p className="text-md leading-relaxed text-[var(--color-ln-ink-2)]">
            Para refugios, veterinarias y redes de rescate. Contanos quiénes son: una persona del
            equipo verifica la organización y te escribe para darte acceso. No hace falta crear una
            cuenta antes.
          </p>
          <p className="text-md leading-relaxed text-[var(--color-ln-ink-2)]">
            ¿Querés registrar a tu propia mascota?{" "}
            <Link
              href="/registro"
              className="text-[var(--color-ln-azul)] underline underline-offset-4"
            >
              Creá tu cuenta de dueño
            </Link>
            .
          </p>
        </div>
        <div className="rounded-xl border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-6 py-8">
          <OrgAccessForm />
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
