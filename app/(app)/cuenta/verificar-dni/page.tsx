// Verificar DNI — Libreta Nacional redesign.
// DniVerifyForm (client component) unchanged.

import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { db, profiles } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { type RawSearchParam, firstSearchParam } from "@/lib/utils/search-params";

import { DniVerifyForm } from "./DniVerifyForm";

// Q1 straggler: `raw` was typed `string | undefined`, but a repeated
// `?next=a&next=b` hands Next a string[] at runtime — `raw.trim()` threw
// (500). firstSearchParam collapses that before trim/validate ever runs.
function sanitizeNext(raw: RawSearchParam): string {
  const trimmed = firstSearchParam(raw)?.trim();
  if (!trimmed) return "/cuenta";
  if (!trimmed.startsWith("/")) return "/cuenta";
  if (trimmed.includes("//") || trimmed.includes("://")) return "/cuenta";
  return trimmed;
}

export default async function VerificarDniPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { user } = await requireUserOrRedirect();
  const params = await searchParams;
  const next = sanitizeNext(params.next);

  const [profile] = await db
    .select({ dniVerified: profiles.dniVerified, dniLast4: profiles.dniLast4 })
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);

  // "Nothing left to do" is the flag AND a DNI actually on file — the same
  // condition verifyDniForUser uses to short-circuit. Bouncing on the flag alone
  // sent a half-state profile away from the only screen that could repair it
  // (master test CIU, N2b: the sheet no-oped and this route redirected, so both
  // doors were shut on the same non-state).
  if (profile?.dniVerified && profile.dniLast4) {
    redirect(next);
  }

  return (
    <div className="mx-auto max-w-md px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href="/cuenta"
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Mi cuenta
      </Link>

      {/* Header */}
      <div className="mb-7">
        {/* Page title uses "Declarar" because DNI is trust-on-input (self-declared) until the
            Mi Argentina OAuth integration lands. Avoids overclaiming identity assurance. */}
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Declarar DNI
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Ingresá tu número de DNI para continuar. Este dato queda registrado en tu perfil y es
          requerido antes de enviar una solicitud de rol en miMAR.
        </p>
      </div>

      <DniVerifyForm next={next} />
    </div>
  );
}
