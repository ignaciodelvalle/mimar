import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Política de cookies — miMAR",
  description: "Política de uso de cookies de miMAR — Mi Mascota Argentina.",
};

export default function CookiesPage() {
  return (
    <div className="bg-[var(--color-ln-paper)]">
      <div className="mx-auto max-w-2xl px-6 py-16 space-y-8">
        <h1
          className="text-3xl font-semibold tracking-[-0.015em] leading-tight text-[var(--color-ln-ink)]"
          style={{ fontFamily: "var(--font-ln-serif)" }}
        >
          Política de cookies
        </h1>

        <section aria-labelledby="que-son-heading" className="space-y-3">
          <h2 id="que-son-heading" className="text-lg font-semibold text-[var(--color-ln-ink)]">
            ¿Qué son las cookies?
          </h2>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            Las cookies son pequeños archivos de texto que un sitio web almacena en tu dispositivo
            para recordar información entre visitas. miMAR usa un número mínimo de cookies, todas
            estrictamente necesarias para el funcionamiento del servicio.
          </p>
        </section>

        <section aria-labelledby="cuales-heading" className="space-y-3">
          <h2 id="cuales-heading" className="text-lg font-semibold text-[var(--color-ln-ink)]">
            ¿Qué cookies usa miMAR?
          </h2>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            miMAR utiliza <strong>Supabase Auth</strong> para la autenticación. Supabase gestiona la
            sesión del usuario mediante cookies seguras (<code>HttpOnly</code>, <code>Secure</code>,{" "}
            <code>SameSite</code>). Estas cookies son necesarias para mantener tu sesión iniciada
            mientras navegás el portal.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-md text-[var(--color-ln-ink-2)] border border-[var(--color-ln-line)] rounded-lg overflow-hidden">
              <thead className="bg-[var(--color-ln-card)]">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold text-[var(--color-ln-ink)] border-b border-[var(--color-ln-line)]">
                    Nombre
                  </th>
                  <th className="text-left px-4 py-2 font-semibold text-[var(--color-ln-ink)] border-b border-[var(--color-ln-line)]">
                    Propósito
                  </th>
                  <th className="text-left px-4 py-2 font-semibold text-[var(--color-ln-ink)] border-b border-[var(--color-ln-line)]">
                    Tipo
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-[var(--color-ln-line)]">
                  <td className="px-4 py-2 font-ln-mono">sb-*-auth-token</td>
                  <td className="px-4 py-2">
                    Mantiene la sesión de usuario autenticado (token de acceso y refresh token de
                    Supabase Auth). Solo se crea cuando iniciás sesión.
                  </td>
                  <td className="px-4 py-2">Técnica, necesaria</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            No usamos cookies de terceros, cookies de rastreo publicitario ni servicios de analítica
            de terceros que depositen cookies en tu dispositivo.
          </p>
        </section>

        <section aria-labelledby="control-heading" className="space-y-3">
          <h2 id="control-heading" className="text-lg font-semibold text-[var(--color-ln-ink)]">
            ¿Podés controlarlas?
          </h2>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            Podés eliminar las cookies de autenticación en cualquier momento desde la configuración
            de tu navegador, o cerrando sesión desde miMAR. Al eliminar la cookie de sesión, tu
            sesión quedará cerrada y deberás iniciar sesión nuevamente para acceder a tu portal.
          </p>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            Las páginas públicas de miMAR (credenciales, adopciones, denuncias) no requieren cookies
            para funcionar.
          </p>
        </section>

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
