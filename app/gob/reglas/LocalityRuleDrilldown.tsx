"use client";

// AC4 — locality drill-down for /admin/jurisdicciones.
//
// The index page lists country + provinces and surfaces only localities that
// ALREADY have rules. Before this, an admin had no UI path to create a rule for
// a NEW locality — they had to hand-type the URL. This province-scoped
// typeahead searches the INDEC catalog (ar_localities) and navigates to the
// locality's rules page using the REAL locality name in the [locality] segment
// (never the "_" sentinel), so a fresh locality rule becomes reachable.
//
// Reuses searchLocalitiesAction (authed, rate-limited) — same source of truth
// as every other locality picker in the app.

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";

import { searchLocalitiesAction } from "@/app/actions/localities";
import { OpInput } from "@/components/ui/dashboard/OpField";
import { buildJurisdictionRulesHref } from "@/lib/domain/jurisdiction-rules-href";
import type { LocalitySearchResult } from "@/lib/infra/ar-localidades";

const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

type Props = {
  /** ISO 3166-2:AR province code, used to scope the catalog search. */
  provinceCode: string;
  /** Canonical province name — written into the [province] route segment. */
  provinceName: string;
  /**
   * Portal prefix the navigation must stay inside (portal-follows-viewer,
   * 2026-07-02) — passed down from the server parent (AdminReglasLens).
   */
  base: "/admin" | "/gob";
};

export function LocalityRuleDrilldown({ provinceCode, provinceName, base }: Props) {
  const router = useRouter();
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocalitySearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [errored, setErrored] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (query.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setOpen(false);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      startTransition(async () => {
        const res = await searchLocalitiesAction({ provinceCode, query });
        if ("results" in res) {
          setResults(res.results);
          setOpen(res.results.length > 0);
          setErrored(false);
        } else {
          setErrored(true);
        }
      });
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, provinceCode]);

  function goToLocalityRules(localityName: string) {
    setOpen(false);
    setQuery("");
    router.push(
      buildJurisdictionRulesHref({
        country: "AR",
        province: provinceName,
        locality: localityName,
        base,
      }),
    );
  }

  return (
    <div className="relative pl-4">
      <label htmlFor={inputId} className="block text-sm text-ln-op-mute mb-1">
        Crear/ver regla en una localidad de {provinceName}
      </label>
      <OpInput
        id={inputId}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => {
          if (results.length > 0) setOpen(true);
        }}
        onBlur={() => {
          setTimeout(() => setOpen(false), 150);
        }}
        placeholder="Buscar localidad…"
        aria-label={`Buscar localidad en ${provinceName}`}
        name={`locality-search-${provinceCode}`}
        aria-autocomplete="list"
        aria-expanded={open}
        className="max-w-sm"
        size="sm"
      />
      {open && results.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-72 w-full max-w-sm overflow-auto rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card shadow-lg">
          {results.map((r) => (
            <li key={r.indecId ?? `${r.provinceCode}-${r.localitySlug}-${r.departmentName ?? "x"}`}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  goToLocalityRules(r.localityName);
                }}
                className="block w-full text-left px-3 py-2 text-sm text-ln-op-ink hover:bg-ln-op-stripe"
              >
                {r.localityName}
                {r.departmentName ? (
                  <span className="ml-1 text-ln-op-mute">· {r.departmentName}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {pending && <span className="ml-2 text-sm text-ln-op-mute">…</span>}
      {errored && (
        <p className="mt-1 text-sm text-ln-op-mute">
          No pudimos buscar localidades ahora. Probá de nuevo en un momento.
        </p>
      )}
    </div>
  );
}
