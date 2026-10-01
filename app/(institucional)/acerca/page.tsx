import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Acerca de miMAR",
  description: "Información institucional sobre miMAR — Mi Mascota Argentina.",
};

export default function AcercaPage() {
  return (
    <div className="bg-[var(--color-ln-paper)]">
      <div className="mx-auto max-w-2xl px-6 py-16 space-y-8">
        <h1
          className="text-3xl font-semibold tracking-[-0.015em] leading-tight text-[var(--color-ln-ink)]"
          style={{ fontFamily: "var(--font-ln-serif)" }}
        >
          Acerca de miMAR
        </h1>

        <section aria-labelledby="que-es-heading" className="space-y-3">
          <h2 id="que-es-heading" className="text-lg font-semibold text-[var(--color-ln-ink)]">
            ¿Qué es miMAR?
          </h2>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            <strong>miMAR (Mi Mascota Argentina)</strong> es un sistema de credencial digital
            sanitaria para mascotas. El nombre interno del proyecto es{" "}
            {/* dim-codename-ok: deliberate institutional disclosure. The codename is not a secret — this page exists to explain what it stands for. It simply is not the name the product signs documents with. */}
            <strong>DIM — Documento de Identificación para Mascotas</strong>, y surge como evolución
            de un proyecto universitario de la UTN iniciado en 2021.
          </p>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            Cada mascota registrada recibe un identificador único (con formato{" "}
            <code>DIM-XXXX-XXXX</code>) vinculado a un código QR verificable. Ese QR permite acceder
            a su credencial pública desde cualquier dispositivo, sin necesidad de instalar nada.
          </p>
        </section>

        <section aria-labelledby="para-quien-heading" className="space-y-3">
          <h2 id="para-quien-heading" className="text-lg font-semibold text-[var(--color-ln-ink)]">
            ¿Para quién es?
          </h2>
          <ul className="text-md text-[var(--color-ln-ink-2)] leading-relaxed space-y-2 list-disc pl-5">
            <li>
              <strong>Dueños de mascotas:</strong> registran a sus animales, mantienen su historial
              clínico (vacunas, medicaciones, visitas al veterinario, peso), y cuentan con
              herramientas para el caso de que su mascota se pierda.
            </li>
            <li>
              <strong>Refugios y organizaciones:</strong> gestionan adopciones y el seguimiento de
              animales bajo su cuidado.
            </li>
            <li>
              <strong>Autoridades sanitarias:</strong> acceden a proyecciones y datos agregados (con
              protección de privacidad) para el seguimiento de la salud animal a nivel poblacional.
            </li>
          </ul>
        </section>

        <section aria-labelledby="que-hace-heading" className="space-y-3">
          <h2 id="que-hace-heading" className="text-lg font-semibold text-[var(--color-ln-ink)]">
            ¿Qué hace?
          </h2>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            miMAR funciona como una <strong>libreta sanitaria digital portable</strong>: cada evento
            en la vida de la mascota (vacuna, desparasitación, visita al vet, cambio de estado)
            queda registrado de forma inmutable y ordenada, sin depender de papeles que se pierden o
            datos que se olvidan. Escanear el QR muestra la identidad del animal, no su historial:
            la libreta clínica la comparte el dueño cuando quiere y con quien quiere, con un enlace
            temporal que puede revocar. El objetivo a futuro es que un veterinario o una autoridad
            pueda acceder al historial por su propio rol verificado.
          </p>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            El proyecto está diseñado para integrarse en el futuro con <strong>Mi Argentina</strong>
            , la plataforma de identidad digital del gobierno argentino. Esa integración es la
            premisa central de la arquitectura, no un complemento opcional.
          </p>
        </section>

        <section aria-labelledby="transparencia-heading" className="space-y-3">
          <h2
            id="transparencia-heading"
            className="text-lg font-semibold text-[var(--color-ln-ink)]"
          >
            Transparencia de datos y metodología
          </h2>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            miMAR publica datos abiertos de salud y bienestar animal por provincia, bajo licencia{" "}
            <strong>CC BY 4.0</strong> (Ley 27.275 de Acceso a la Información Pública), junto con la
            metodología que los produce. Podés consultarlos y descargarlos en{" "}
            <Link
              href="/transparencia"
              className="text-[var(--color-ln-azul)] no-underline hover:underline"
            >
              /transparencia
            </Link>
            . Esta apertura no es solo un detalle técnico: es parte de la estrategia de confianza
            necesaria para una eventual integración con organismos públicos.
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
