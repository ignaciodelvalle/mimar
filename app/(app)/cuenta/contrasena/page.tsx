// Cambiar contraseña — /cuenta/contrasena (A04-1).
//
// The in-account door for a password change, and it asks for the CURRENT
// password. The recovery page (/recuperar/actualizar) is the other door and asks
// for nothing, because the recovery mail is its proof; an ordinary session is
// not, which is why this form exists instead of linking there.

import Link from "next/link";

import { requireUserOrRedirect } from "@/lib/infra/auth-guards";

import { ChangePasswordForm } from "./ChangePasswordForm";

export default async function CambiarContrasenaPage() {
  await requireUserOrRedirect("/cuenta/contrasena");

  return (
    <div className="mx-auto max-w-md px-8 py-7 pb-12">
      <Link
        href="/cuenta"
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Mi cuenta
      </Link>

      <div className="mb-7">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Cambiar contraseña
        </h1>
        <p className="mt-1 text-md text-[var(--color-ln-mute)]">
          Para confirmar que sos vos, ingresá tu contraseña actual. Al guardar, cerramos tu sesión
          en los demás dispositivos.
        </p>
      </div>

      <ChangePasswordForm />

      <p className="mt-6 text-sm text-[var(--color-ln-ink-2)]">
        ¿No te acordás de tu contraseña actual?{" "}
        <Link href="/recuperar" className="text-[var(--color-ln-azul)]">
          Recuperala por correo
        </Link>
        .
      </p>
    </div>
  );
}
