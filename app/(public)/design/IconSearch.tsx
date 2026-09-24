"use client";

import { Icon, type IconName, iconNames } from "@/components/Icon";
import { LnField, LnInput } from "@/components/ui/Field";
import { pluralizeEs } from "@/lib/utils/format";
import { useMemo, useState } from "react";

/**
 * Client-side icon search over the 852 icono-arg icons.
 * Filters by substring match on icon name. No debounce — filter is local and fast.
 */
export function IconSearch() {
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const results = useMemo<IconName[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return iconNames.slice(0, 60);
    return iconNames.filter((n) => n.toLowerCase().includes(q)).slice(0, 120);
  }, [query]);

  async function copy(name: string) {
    try {
      await navigator.clipboard.writeText(`<Icon name="${name}" />`);
      setCopied(name);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      /* ignore */
    }
  }

  const resultsHelp = query
    ? `${results.length} ${pluralizeEs(results.length, "resultado")}`
    : `Mostrando los primeros 60 (de ${iconNames.length})`;

  return (
    <div>
      <LnField
        label={`Buscar entre ${iconNames.length} íconos icono-arg`}
        hint={resultsHelp}
        optional={false}
      >
        {({ id, describedBy }) => (
          <LnInput
            id={id}
            type="search"
            placeholder="ej: vacuna, hospital, marcador…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-describedby={describedBy}
            className="max-w-md"
          />
        )}
      </LnField>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5">
        {results.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => copy(name)}
            className="flex flex-col items-center gap-2 rounded-md border border-ln-line p-3 text-left transition-colors hover:border-ln-azul"
            title={`Copiar <Icon name="${name}" />`}
          >
            <Icon name={name} size={28} color="var(--color-ln-azul)" />
            <code className="block w-full truncate text-xs text-ln-ink-2">{name}</code>
            <span
              className="block text-xs text-ln-ok"
              style={{ opacity: copied === name ? 1 : 0, transition: "opacity 150ms" }}
            >
              copiado
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
