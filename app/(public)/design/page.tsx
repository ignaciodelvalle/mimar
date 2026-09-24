import { redirect } from "next/navigation";

import { Icon } from "@/components/Icon";
import { LnButton } from "@/components/ui/Button";
import { IconSearch } from "./IconSearch";

/**
 * Internal design reference page.
 * Shows palette, typography, buttons, and icons.
 * Now uses ln-* tokens (Libreta Nacional warm tier).
 * URL: /design
 */

export const metadata = {
  title: "Sistema de diseño · miMAR",
  robots: { index: false, follow: false },
};

type Swatch = {
  name: string;
  varName: string;
  tailwindClass: string;
  hex: string;
  onColor: "light" | "dark"; // text color on top of swatch
  note?: string;
};

const warmSwatches: Swatch[] = [
  {
    name: "ln-azul",
    varName: "--color-ln-azul",
    tailwindClass: "bg-ln-azul",
    hex: "#0e5a99",
    onColor: "light",
    note: "CTA, links, accents",
  },
  {
    name: "ln-celeste",
    varName: "--color-ln-celeste",
    tailwindClass: "bg-ln-celeste",
    hex: "#4e97d1",
    onColor: "light",
    note: "Focus ring, info",
  },
  {
    name: "ln-ok",
    varName: "--color-ln-ok",
    tailwindClass: "bg-ln-ok",
    hex: "#2b7449",
    onColor: "light",
    note: "Success / advance",
  },
  {
    name: "ln-warn",
    varName: "--color-ln-warn",
    tailwindClass: "bg-ln-warn",
    hex: "#b0771a",
    onColor: "light",
    note: "Warning text",
  },
  {
    name: "ln-err",
    varName: "--color-ln-err",
    tailwindClass: "bg-ln-err",
    hex: "#c0392b",
    onColor: "light",
    note: "Errors, delete",
  },
  {
    name: "ln-seal",
    varName: "--color-ln-seal",
    tailwindClass: "bg-ln-seal",
    hex: "#a23a2c",
    onColor: "light",
    note: "Danger accent",
  },
  {
    name: "ln-ink",
    varName: "--color-ln-ink",
    tailwindClass: "bg-ln-ink",
    hex: "#1b2a33",
    onColor: "light",
    note: "Primary text",
  },
  {
    name: "ln-ink-2",
    varName: "--color-ln-ink-2",
    tailwindClass: "bg-ln-ink-2",
    hex: "#3c4b55",
    onColor: "light",
    note: "Secondary text",
  },
  {
    name: "ln-mute",
    varName: "--color-ln-mute",
    tailwindClass: "bg-ln-mute",
    hex: "#616e77",
    onColor: "light",
    note: "Muted text",
  },
  {
    name: "ln-line",
    varName: "--color-ln-line",
    tailwindClass: "bg-ln-line",
    hex: "#e4dfd3",
    onColor: "dark",
    note: "Borders",
  },
  {
    name: "ln-stripe",
    varName: "--color-ln-stripe",
    tailwindClass: "bg-ln-stripe",
    hex: "#f6f4ed",
    onColor: "dark",
    note: "Alternate surface",
  },
  {
    name: "ln-paper",
    varName: "--color-ln-paper",
    tailwindClass: "bg-ln-paper",
    hex: "#fbfaf5",
    onColor: "dark",
    note: "Page background",
  },
];

function SwatchCard({ s }: { s: Swatch }) {
  return (
    <div
      className={`rounded-md p-4 text-sm ${s.tailwindClass} ${
        s.onColor === "light" ? "text-white" : "text-ln-ink"
      }`}
    >
      <div className="font-semibold">{s.name}</div>
      <div className="opacity-90">{s.hex}</div>
      <div className="mt-1 text-xs opacity-75">
        <code>{s.varName}</code>
      </div>
      {s.note && <div className="mt-1 text-xs opacity-90">{s.note}</div>}
    </div>
  );
}

export default function DesignPage() {
  if (process.env.NODE_ENV === "production") redirect("/");

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      {/* Header */}
      <header className="mb-12 border-b border-ln-line pb-6">
        <p className="text-sm uppercase tracking-wide text-ln-mute">miMAR · Sistema de diseño</p>
        <h1 className="mt-1 text-4xl font-bold font-ln-serif">Tokens Libreta Nacional</h1>
        <p className="lead mt-2 text-ln-ink-2">
          Paleta, tipografía e íconos del sistema Libreta Nacional portados a Next.js + Tailwind v4.
        </p>
      </header>

      {/* Tipografía */}
      <section className="mb-12">
        <h2 className="mb-4 text-2xl font-bold">Tipografía — IBM Plex Serif / Sans</h2>
        <div className="space-y-2 rounded-md border border-ln-line p-6">
          <h1 className="text-5xl font-ln-serif">h1 · Esto es un título</h1>
          <h2 className="text-4xl font-ln-serif">h2 · Esto es un título</h2>
          <h3 className="text-3xl">h3 · Esto es un título</h3>
          <h4 className="text-2xl">h4 · Esto es un título</h4>
          <h5 className="text-xl">h5 · Esto es un título</h5>
          <p className="lead pt-2">
            Lead — Texto destacado para bajadas. IBM Plex Sans en cuerpo, Serif en titulares.
          </p>
          <p>
            Cuerpo de párrafo regular. Tus mascotas tienen un{" "}
            {/* biome-ignore lint/a11y/useValidAnchor: design-system showcase page — placeholder link, no real navigation */}
            <a href="#" className="text-ln-azul underline-offset-4 hover:underline">
              enlace
            </a>{" "}
            como este. <strong>Negrita</strong> y <em>cursiva</em> con moderación.
          </p>
          <p>
            <small className="text-ln-mute">
              Small · Información complementaria, ayuda en formularios o aclaraciones legales.
            </small>
          </p>
        </div>
      </section>

      {/* Paleta warm */}
      <section className="mb-12">
        <h2 className="mb-1 text-2xl font-bold">Paleta — Libreta Nacional (warm tier)</h2>
        <p className="mb-4 text-sm text-ln-mute">
          Consumir vía utilidades Tailwind (<code>bg-ln-azul</code>) o variables CSS.
        </p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {warmSwatches.map((s) => (
            <SwatchCard key={s.varName} s={s} />
          ))}
        </div>
      </section>

      {/* Botones */}
      <section className="mb-12">
        <h2 className="mb-1 text-2xl font-bold">Botones</h2>
        <p className="mb-4 text-sm text-ln-mute">
          Variantes alineadas con{" "}
          <a
            href="https://argob.github.io/poncho/componentes/botones/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-ln-azul underline-offset-4 hover:underline"
          >
            Poncho componentes/botones
          </a>
          . Touch target ≥44px. Focus ring azul global.
        </p>

        <h3 className="mt-6 mb-3 text-lg font-bold">Variantes</h3>
        <div className="flex flex-wrap gap-3">
          <LnButton variant="primary">Primario</LnButton>
          <LnButton variant="ok">Avanzar</LnButton>
          <LnButton variant="seal">Eliminar</LnButton>
          <LnButton variant="ghost">Secundario</LnButton>
          <LnButton variant="ghost">Cancelar</LnButton>
          <LnButton variant="ghost">Etiqueta</LnButton>
        </div>

        <h3 className="mt-8 mb-3 text-lg font-bold">Tamaños</h3>
        <div className="flex flex-wrap items-center gap-3">
          <LnButton variant="primary" size="sm">
            Chico
          </LnButton>
          <LnButton variant="primary" size="md">
            Mediano
          </LnButton>
          <LnButton variant="primary" size="lg">
            Grande
          </LnButton>
        </div>

        <h3 className="mt-8 mb-3 text-lg font-bold">Estados</h3>
        <div className="flex flex-wrap gap-3">
          <LnButton variant="primary" disabled>
            Deshabilitado
          </LnButton>
          <LnButton variant="primary" loading>
            Cargando…
          </LnButton>
          <LnButton variant="ok" loading>
            Guardando vacuna
          </LnButton>
        </div>

        <h3 className="mt-8 mb-3 text-lg font-bold">Con íconos</h3>
        <div className="flex flex-wrap gap-3">
          <LnButton variant="primary">
            <Icon name="vacuna" size="1.1em" decorative />
            Vacunar
          </LnButton>
          <LnButton variant="ok">
            Ver libreta
            <Icon name="credenciales" size="1.1em" decorative />
          </LnButton>
          <LnButton variant="seal">
            <Icon name="denuncia" size="1.1em" decorative />
            Denunciar
          </LnButton>
          <LnButton variant="ghost">
            <Icon name="lupa" size="1.1em" decorative />
            Buscar mascota
          </LnButton>
        </div>

        <h3 className="mt-8 mb-3 text-lg font-bold">Patrón de cancelar vs eliminar</h3>
        <div className="rounded-md border border-ln-line p-4">
          <p className="mb-3 text-sm">¿Eliminar la vacuna del registro?</p>
          <div className="flex flex-wrap gap-3">
            <LnButton variant="ghost">Cancelar</LnButton>
            <LnButton variant="seal">
              <Icon name="denuncia" size="1.1em" decorative />
              Eliminar
            </LnButton>
          </div>
          <p className="mt-3 text-xs text-ln-mute">
            "Cancelar" usa <code>ghost</code> (neutro, sin peso visual). "Eliminar" usa{" "}
            <code>seal</code> (rojo, terminante). Nunca dos botones destacados juntos.
          </p>
        </div>
      </section>

      {/* Íconos — con buscador */}
      <section className="mb-12">
        <h2 className="mb-1 text-2xl font-bold">Íconos — icono-arg</h2>
        <p className="mb-4 text-sm text-ln-mute">
          Click en un ícono copia <code>{`<Icon name="..." />`}</code> al portapapeles.
        </p>
        <IconSearch />
      </section>

      <footer className="border-t border-ln-line pt-6 text-sm text-ln-mute">
        Fase 1 — Tokens e identidad. Próximas fases: header/footer gob.ar, biblioteca completa de
        componentes, aplicación al producto.
      </footer>
    </main>
  );
}
