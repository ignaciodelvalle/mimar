import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Accesibilidad — miMAR",
  description: "Declaración de accesibilidad de miMAR — Mi Mascota Argentina.",
};

export default function AccesibilidadPage() {
  return (
    <div className="bg-[var(--color-ln-paper)]">
      <div className="mx-auto max-w-2xl px-6 py-16 space-y-8">
        <h1
          className="text-3xl font-semibold tracking-[-0.015em] leading-tight text-[var(--color-ln-ink)]"
          style={{ fontFamily: "var(--font-ln-serif)" }}
        >
          Accesibilidad
        </h1>

        {/* Commitment statement */}
        <section aria-labelledby="compromiso-heading" className="space-y-3">
          <h2 id="compromiso-heading" className="text-lg font-semibold text-[var(--color-ln-ink)]">
            Nuestro compromiso
          </h2>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            miMAR está diseñado apuntando al nivel de conformidad <strong>WCAG 2.1 AA</strong> (Web
            Content Accessibility Guidelines, versión 2.1, nivel de éxito AA). Esto significa que
            buscamos activamente que el producto sea usable por personas con distintas capacidades,
            pero{" "}
            <strong>no contamos con una auditoría formal ni certificación de conformidad</strong>.
            Esta declaración describe las medidas implementadas y las limitaciones conocidas.
          </p>
        </section>

        {/* Implemented measures */}
        <section aria-labelledby="medidas-heading" className="space-y-3">
          <h2 id="medidas-heading" className="text-lg font-semibold text-[var(--color-ln-ink)]">
            Medidas implementadas
          </h2>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            Las siguientes medidas están presentes en el código actual del producto:
          </p>
          <ul className="text-md text-[var(--color-ln-ink-2)] leading-relaxed space-y-2 list-disc pl-5">
            <li>
              <strong>Estructura semántica y landmarks:</strong> las páginas usan elementos HTML
              semánticos (<code>&lt;main&gt;</code>, <code>&lt;nav&gt;</code>,{" "}
              <code>&lt;header&gt;</code>, <code>&lt;footer&gt;</code>, <code>&lt;section&gt;</code>
              ) con un único punto de destino <code>#main-content</code> por página, compatible con
              tecnologías de asistencia.
            </li>
            <li>
              <strong>Grupos de controles con fieldset/legend:</strong> los formularios con botones
              de opción (por ejemplo, tipo y gravedad de denuncia) usan{" "}
              <code>&lt;fieldset&gt;</code> y <code>&lt;legend&gt;</code> para que los lectores de
              pantalla anuncien el contexto del grupo.
            </li>
            <li>
              <strong>Búsqueda operacional accesible:</strong> el omnibox de búsqueda global usa el
              patrón <code>role="combobox"</code> con <code>aria-activedescendant</code> y el
              listado de resultados usa <code>role="listbox"</code> con <code>role="option"</code>,
              navegable por teclado.
            </li>
            <li>
              <strong>Íconos y estados con texto alternativo:</strong> los íconos decorativos llevan{" "}
              <code>aria-hidden="true"</code>; las etiquetas de estado (por ejemplo, Publicado,
              Borrador, Pausado) incluyen texto visible legible además del color, con complemento{" "}
              <code>aria-hidden</code> en el glifo.
            </li>
            <li>
              <strong>Tamaños de toque mínimos (44 × 44 px):</strong> los controles interactivos en
              la interfaz móvil usan <code>min-h-11</code> (44 px) como tamaño mínimo de área de
              toque.
            </li>
            <li>
              <strong>Navegación con teclado:</strong> el header y el menú móvil incluyen botones
              con <code>aria-label</code>, <code>aria-expanded</code> y <code>aria-haspopup</code>{" "}
              para que la apertura y el cierre del drawer sean operables desde el teclado.
            </li>
            <li>
              <strong>Elementos puramente decorativos:</strong> la cinta institucional (franja
              argentina) usa <code>aria-hidden="true"</code> y no aporta contenido semántico.
            </li>
            <li>
              <strong>Visualizaciones de datos:</strong> los gráficos y KPIs incluyen indicadores de
              dirección (sube / baja) con texto legible por lectores de pantalla mediante{" "}
              <code>sr-only</code>, no solo mediante flechas o colores.
            </li>
            <li>
              <strong>Verificación automatizada:</strong> el proyecto cuenta con pruebas
              estructurales de accesibilidad que se ejecutan en la suite de integración continua,
              cubriendo semántica de formularios, landmarks y atributos ARIA.
            </li>
          </ul>
        </section>

        {/* Known limitations */}
        <section aria-labelledby="limitaciones-heading" className="space-y-3">
          <h2
            id="limitaciones-heading"
            className="text-lg font-semibold text-[var(--color-ln-ink)]"
          >
            Limitaciones conocidas
          </h2>
          <ul className="text-md text-[var(--color-ln-ink-2)] leading-relaxed space-y-2 list-disc pl-5">
            <li>
              <strong>Íconos tipográficos:</strong> el sistema de íconos vectoriales está en
              desarrollo. Algunas secciones usan emojis como íconos decorativos en puntos donde el
              sistema definitivo aún no está implementado. Estos casos no afectan la función pero
              pueden ser anunciados por lectores de pantalla de forma no óptima.
            </li>
            <li>
              <strong>Sin auditoría independiente:</strong> no hemos realizado una evaluación formal
              de conformidad WCAG por parte de un tercero. Pueden existir barreras de accesibilidad
              que no hemos detectado.
            </li>
            <li>
              <strong>Funcionalidades en desarrollo:</strong> el producto está en evolución activa.
              Algunas secciones pueden no haber alcanzado aún el objetivo de nivel AA.
            </li>
          </ul>
        </section>

        {/* Contact */}
        <section aria-labelledby="contacto-heading" className="space-y-3">
          <h2 id="contacto-heading" className="text-lg font-semibold text-[var(--color-ln-ink)]">
            Reportar un problema de accesibilidad
          </h2>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            Si encontrás una barrera de accesibilidad en miMAR, podés reportarla a través de nuestro{" "}
            <Link
              href="/sugerencias"
              className="text-[var(--color-ln-azul)] underline hover:no-underline"
            >
              canal de sugerencias
            </Link>
            . Describí el problema, la sección donde ocurre y la tecnología de asistencia que usás
            (si aplica). Revisamos los reportes de forma regular.
          </p>
        </section>

        {/* Last reviewed */}
        <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed border-t border-[var(--color-ln-line)] pt-4">
          Esta declaración fue redactada en junio de 2026 y refleja el estado actual del producto.
          Se actualiza a medida que el producto evoluciona.
        </p>

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
