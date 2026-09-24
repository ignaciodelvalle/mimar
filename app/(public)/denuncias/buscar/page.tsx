import Link from "next/link";
import { SearchForm } from "./SearchForm";

export default function BuscarDenunciaPage() {
  return (
    <div className="p-6 bg-[var(--color-ln-paper)]">
      <div className="max-w-md mx-auto pt-10 space-y-8">
        <header className="space-y-2">
          <Link
            href="/"
            className="text-sm font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)] hover:text-[var(--color-ln-ink-2)] transition-colors no-underline"
            style={{ fontFamily: "var(--font-ln-mono)" }}
          >
            ← Inicio
          </Link>
          <h1
            className="text-3xl font-semibold tracking-[-0.015em] text-[var(--color-ln-ink)] leading-tight"
            style={{ fontFamily: "var(--font-ln-serif)" }}
          >
            Buscar mi denuncia
          </h1>
          <p className="text-sm text-[var(--color-ln-ink-2)]">
            Si denunciaste de forma anónima, podés volver a tu denuncia con el código que recibiste
            al enviarla.
          </p>
        </header>

        <SearchForm />
      </div>
    </div>
  );
}
