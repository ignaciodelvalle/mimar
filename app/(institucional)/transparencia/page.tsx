import type { Metadata } from "next";
import Link from "next/link";

import { Icon } from "@/components/Icon";
import { DATASET_DESCRIPTORS, DATASET_IDS, OPEN_DATA_LICENSE } from "@/lib/open-data/datasets";

export const metadata: Metadata = {
  title: "Transparencia activa — miMAR",
  description:
    "Datos abiertos de salud y bienestar animal por provincia, publicados bajo la Ley 27.275. Descargá los conjuntos en CSV o JSON, con su metodología y licencia.",
};

/** A single dataset card: title, summary, columns, cadence, and CSV/JSON links. */
function DatasetCard({ id }: { id: (typeof DATASET_IDS)[number] }) {
  const d = DATASET_DESCRIPTORS[id];
  const base = `/transparencia/datos/${id}`;
  return (
    <article
      id={id}
      className="space-y-3 rounded-lg border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-4"
    >
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-[var(--color-ln-ink)]">{d.title}</h3>
        <p className="text-sm leading-snug text-[var(--color-ln-mute)]">{d.summary}</p>
      </div>

      <dl className="space-y-1 text-sm text-[var(--color-ln-ink-2)]">
        <div className="flex gap-2">
          <dt className="shrink-0 font-medium text-[var(--color-ln-ink)]">Columnas:</dt>
          <dd>{d.columns.map((c) => c.name).join(", ")}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 font-medium text-[var(--color-ln-ink)]">Actualización:</dt>
          <dd>{d.cadence}</dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-2 pt-1">
        <a
          href={`${base}?format=csv`}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-ln-line)] px-3 py-1.5 text-sm font-medium text-[var(--color-ln-azul)] no-underline hover:bg-[var(--color-ln-celeste-050)]"
        >
          <Icon name="descargar" size="sm" decorative />
          CSV
        </a>
        <a
          href={`${base}?format=json`}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-ln-line)] px-3 py-1.5 text-sm font-medium text-[var(--color-ln-azul)] no-underline hover:bg-[var(--color-ln-celeste-050)]"
        >
          <Icon name="descargar" size="sm" decorative />
          JSON
        </a>
      </div>
    </article>
  );
}

export default function TransparenciaPage() {
  return (
    <div className="bg-[var(--color-ln-paper)]">
      <div className="mx-auto max-w-2xl space-y-10 px-6 py-16">
        <header className="space-y-3">
          <h1
            className="text-2xl leading-tight font-semibold tracking-[-0.015em] text-[var(--color-ln-ink)]"
            style={{ fontFamily: "var(--font-ln-serif)" }}
          >
            Transparencia activa
          </h1>
          <p className="text-md leading-relaxed text-[var(--color-ln-ink-2)]">
            En el marco de la <strong>Ley 27.275 de acceso a la información pública</strong>, miMAR
            publica de forma abierta y reutilizable los indicadores de salud y bienestar animal que
            produce. Son datos <strong>agregados por provincia</strong>: no contienen datos
            personales, ni información de una mascota individual, ni ubicaciones exactas.
          </p>
        </header>

        <section aria-labelledby="datasets-heading" className="space-y-4">
          <h2 id="datasets-heading" className="text-xl font-semibold text-[var(--color-ln-ink)]">
            Conjuntos de datos
          </h2>
          <p className="text-sm leading-relaxed text-[var(--color-ln-mute)]">
            Cada conjunto se descarga en CSV (compatible con Excel) o JSON. La descarga incluye sus
            metadatos: licencia, fecha de generación, metodología y regla de supresión.
          </p>
          <div className="space-y-3">
            {DATASET_IDS.map((id) => (
              <DatasetCard key={id} id={id} />
            ))}
          </div>
        </section>

        <section aria-labelledby="metodologia-heading" id="metodologia" className="space-y-3">
          <div className="flex items-center gap-2">
            <Icon
              name="shield-check"
              size="md"
              decorative
              className="shrink-0 text-[var(--color-ln-azul)]"
            />
            <h2
              id="metodologia-heading"
              className="text-xl font-semibold text-[var(--color-ln-ink)]"
            >
              Metodología y privacidad
            </h2>
          </div>
          <p className="text-sm leading-relaxed text-[var(--color-ln-ink-2)]">
            Cada indicador publica su definición y su método de cálculo, para que cualquiera pueda
            auditar de dónde sale la cifra y reproducirla. Antes de publicar, aplicamos{" "}
            <strong>k-anonimato con k = 5</strong>: ninguna cifra puede describir a un grupo de
            menos de 5 individuos. Cuando un grupo es más chico, la celda muestra
            <span className="font-medium"> «suprimido por privacidad»</span> — nunca un 0.
          </p>
          <p className="text-sm leading-relaxed text-[var(--color-ln-ink-2)]">
            En los indicadores de tasa se suprime la fila cuando la población base, el grupo
            cubierto o el grupo no cubierto tiene menos de 5 individuos, y no publicamos el
            numerador crudo. Además aplicamos{" "}
            <strong>supresión complementaria a nivel nacional</strong>: si quedara una única
            provincia suprimida en todo el país, se suprime también la siguiente más chica, para que
            ningún valor oculto pueda reconstruirse restando las provincias visibles de un total
            nacional.
          </p>
          <p className="text-sm leading-relaxed text-[var(--color-ln-ink-2)]">
            <strong>Nunca se publica:</strong> datos personales, DNI, información de una mascota
            individual, tokens públicos ni ubicaciones exactas.
          </p>
          <div
            className="flex gap-3 rounded-lg border border-[var(--color-ln-celeste-100)] bg-[var(--color-ln-celeste-050)] p-4"
            role="note"
          >
            <Icon
              name="info"
              size="md"
              decorative
              className="mt-0.5 shrink-0 text-[var(--color-ln-azul)]"
            />
            <p className="text-sm leading-relaxed text-[var(--color-ln-ink-2)]">
              <strong>Riesgo de reidentificación (comparación entre publicaciones):</strong> este
              endpoint es público y puede descargarse automáticamente todos los días, así que es
              posible guardar publicaciones sucesivas y compararlas. La cadencia diaria (no
              continua) limita la granularidad de esa comparación, y como cada fotografía ya pasó
              por k-anonimato (k = 5) y supresión complementaria, restar dos fotografías nunca
              expone directamente un grupo menor a 5. Sí reconocemos un riesgo residual de
              inferencia sobre celdas que cambian entre «suprimido por privacidad» y un valor
              visible. Estamos evaluando supresión sensible a estas diferencias y/o publicaciones en
              períodos fijos más espaciados como trabajo futuro (no implementado todavía).
            </p>
          </div>
        </section>

        <section aria-labelledby="diccionario-heading" id="diccionario" className="space-y-3">
          <h2 id="diccionario-heading" className="text-xl font-semibold text-[var(--color-ln-ink)]">
            Diccionario de datos
          </h2>
          <p className="text-sm leading-relaxed text-[var(--color-ln-ink-2)]">
            Cada tarjeta de conjunto lista sus columnas. Todas incluyen{" "}
            <code className="text-[var(--color-ln-ink)]">provincia</code> y{" "}
            <code className="text-[var(--color-ln-ink)]">codigo_iso</code> (ISO 3166-2:AR). Las
            celdas numéricas suprimidas por privacidad aparecen con el texto{" "}
            <span className="font-medium">«suprimido por privacidad»</span>. El detalle completo de
            columnas, unidades y cadencia de cada conjunto se documenta junto a cada descarga en sus
            metadatos.
          </p>
        </section>

        <section aria-labelledby="licencia-heading" className="space-y-3">
          <h2 id="licencia-heading" className="text-xl font-semibold text-[var(--color-ln-ink)]">
            Licencia
          </h2>
          <p className="text-sm leading-relaxed text-[var(--color-ln-ink-2)]">
            Los conjuntos se publican bajo{" "}
            <a
              href={OPEN_DATA_LICENSE.url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4 hover:text-[var(--color-ln-azul)]"
            >
              {OPEN_DATA_LICENSE.name}
            </a>
            . Podés copiar, redistribuir y adaptar los datos con cualquier fin, incluso comercial,
            citando la fuente: <em>{OPEN_DATA_LICENSE.attribution}</em>.
          </p>
        </section>

        <section aria-labelledby="contacto-heading" className="space-y-3">
          <h2 id="contacto-heading" className="text-xl font-semibold text-[var(--color-ln-ink)]">
            Contacto
          </h2>
          <p className="text-sm leading-relaxed text-[var(--color-ln-ink-2)]">
            ¿Necesitás un conjunto que no está publicado o encontraste un problema en los datos?
            Escribinos desde el{" "}
            <Link
              href="/ayuda"
              className="text-[var(--color-ln-azul)] no-underline hover:underline"
            >
              centro de ayuda
            </Link>
            . Los pedidos formales de acceso a la información pública se rigen por la{" "}
            <a
              href="https://www.argentina.gob.ar/aaip/acceso-informacion-publica"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4 hover:text-[var(--color-ln-azul)]"
            >
              Ley 27.275
            </a>
            .
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
