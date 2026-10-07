// Filters for the public directory — type and province, in the URL.
//
// Server-rendered, no client state. The type is a row of PLAIN anchors and the
// province is a GET form: both are full document navigations, the mechanism a
// filter whose server output differs must use (AGENTS.md → Design rules §0 —
// Next's soft router can drop a same-route navigation under load). The
// province is applied with a button and not on change: a select that navigates
// as you move through it with the keyboard is WCAG 3.2.2's "change on input".

import { LnButton } from "@/components/ui/Button";
import { LnSelect } from "@/components/ui/Field";
import { PROVINCES } from "@/lib/reference/ar-provincias";
import {
  DIRECTORY_KIND_OPTIONS,
  type DirectoryFilters as Filters,
  directorySearch,
} from "@/src/modules/organizations/domain/public-directory";

const KIND_TABS = [{ value: null, label: "Todas" }, ...DIRECTORY_KIND_OPTIONS] as const;

export function DirectoryFilters({ filters }: { filters: Filters }) {
  return (
    <div className="space-y-3">
      <nav aria-label="Tipo de organización">
        <ul className="flex flex-wrap gap-2">
          {KIND_TABS.map((tab) => {
            const active = filters.kind === tab.value;
            return (
              <li key={tab.label}>
                <a
                  href={`/refugios${directorySearch({ ...filters, kind: tab.value })}`}
                  aria-current={active ? "page" : undefined}
                  className={[
                    "inline-flex min-h-[40px] items-center rounded-full border px-4 text-sm font-medium no-underline transition-colors",
                    "focus:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]",
                    active
                      ? "border-[var(--color-ln-azul)] bg-[var(--color-ln-azul)] text-white"
                      : "border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)]",
                  ].join(" ")}
                >
                  {tab.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      <form
        action="/refugios"
        method="GET"
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
      >
        {filters.kind && <input type="hidden" name="tipo" value={filters.kind} />}
        <div className="flex-1 sm:max-w-xs">
          <label
            htmlFor="directorio-provincia"
            className="block font-ln-mono text-xs uppercase tracking-[0.1em] font-semibold text-[var(--color-ln-mute)] mb-1"
          >
            Provincia
          </label>
          <LnSelect
            id="directorio-provincia"
            name="provincia"
            defaultValue={filters.province ?? ""}
          >
            <option value="">Todas</option>
            {PROVINCES.map((p) => (
              <option key={p.code} value={p.name}>
                {p.name}
              </option>
            ))}
          </LnSelect>
        </div>
        <LnButton type="submit" variant="ghost">
          Filtrar por provincia
        </LnButton>
      </form>
    </div>
  );
}
