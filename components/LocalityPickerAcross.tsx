"use client";

// LocalityPickerAcross — single input that searches the `ar_localities`
// catalog across every Argentine province at once. Returns rich results so
// the consumer can derive both province and locality from a single user
// gesture.
//
// Differs from LocalityCombobox:
//   - No `provinceCode` prop / no province scoping.
//   - Result rows show "Locality, Province" for disambiguation.
//   - Emits four hidden inputs (vs LocalityCombobox's two): provinceCode,
//     provinceName, localityName, localityNameIndecId.
//
// Used by LocationFields when mode="l1" after the unified-location refactor
// (critique-direcciones-2026-05-27 §"Opción B").
//
// Auth: the default searchLocalitiesAction requires a session. Most L1 flows are
// authed, but signup is not — anonymous surfaces inject searchLocalitiesPublicAction
// via the `searchAction` prop (see LocationFields `allowAnonymous`). Without that,
// the auth action redirects to /login the moment the user types.

import {
  LOCALITY_FIELD_PLACEHOLDER,
  describeChosenLocality,
  localityOptionLabel,
} from "@dim/contract/reference";
import { useEffect, useRef, useState, useTransition } from "react";

import { searchLocalitiesAction } from "@/app/actions/localities";
import type { SearchLocalitiesResult } from "@/app/actions/localities";
import { LnCombobox } from "@/components/ui/LnCombobox";
import type { LocalitySearchResult } from "@/lib/infra/ar-localidades";
import { CONTACT_EMAILS, mailtoHref } from "@/lib/ui/contact";
import { NO_BROWSER_AUTOFILL } from "@/lib/ui/no-browser-autofill";

const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

type DefaultValue = {
  provinceCode?: string | null;
  provinceName?: string | null;
  localityName?: string | null;
  indecId?: string | null;
};

type Props = {
  /** Pre-fill values for edit mode. When provinceCode + localityName are
   * supplied, the input renders the locality name and the hidden inputs
   * carry the values directly until the user types something new. */
  defaultValue?: DefaultValue;
  /** Optional province scope (ISO 3166-2:AR code, e.g. "AR-B"). When set, the
   * search is restricted to that province's localities; when absent, it searches
   * across every province (the original behavior). Used by JurisdictionFilter to
   * turn this into a province-scoped cascade. */
  scopeProvinceCode?: string | null;
  /** When true, the input is disabled (e.g. no province picked yet). */
  disabled?: boolean;
  /** Optional ID for the visible text input (label association).
   * The hidden inputs use `name` for the wire contract; this id is
   * intentionally suffixed with "-input" so it never collides with any
   * hidden input's name in the same form namespace. */
  id?: string;
  /** Hidden-input base name. Defaults to "localityName" to match the wire
   * contract the actions already expect; the companion hiddens use suffixes
   * so the action can keep reading `provinceCode`, `localityName`,
   * `localityNameIndecId`, `provinceName`. */
  name?: string;
  required?: boolean;
  /** A row to start PICKED, exactly as if the person had just chosen it from
   * the list — the home-locality chip (LocationFields `suggestion`) remounts the
   * picker with it. Read once at mount. Not an edit-mode default: that one is a
   * prior answer; this is a choice made a tap ago. */
  initialPick?: LocalitySearchResult | null;
  /** Called on every successful pick — useful for parent state. */
  onSelect?: (selected: LocalitySearchResult | null) => void;
  /**
   * Called ONCE when the user types over a committed value — a pick, or an
   * edit-mode default they had not touched yet (L3·1 of the locality plan,
   * 2026-09-08). From that keystroke on the field no longer holds a catalog
   * row, and a parent that mirrored the pick in its own state must drop it.
   *
   * Without it the picker never said it had been deselected: pick Palermo, type
   * over it, and a form that kept its own copy still submitted Palermo. The
   * server validates, so the database stayed clean — but on /admin/govts the
   * admin could believe they assigned one unit and assign another, on the one
   * screen that hands out authority.
   *
   * A separate callback rather than `onSelect(null)`: commit-on-change filter
   * bars read `onSelect` as "navigate now", and a navigation per keystroke over
   * a picked locality is not what they want.
   */
  onDeselect?: () => void;
  /** Called on every raw input change (typing without picking). Lets the
   * parent track free-text input and reset any derived province. */
  onQueryChange?: (query: string) => void;
  /** Placeholder copy override. */
  placeholder?: string;
  /** Injectable search action. Defaults to the auth-required searchLocalitiesAction.
   * Pass searchLocalitiesPublicAction for unauthenticated surfaces (e.g. public filter bars). */
  searchAction?: (input: {
    provinceCode?: string;
    query: string;
  }) => Promise<SearchLocalitiesResult>;
};

export function LocalityPickerAcross({
  defaultValue,
  scopeProvinceCode,
  disabled,
  id,
  name = "localityName",
  required,
  initialPick = null,
  onSelect,
  onDeselect,
  onQueryChange,
  placeholder = LOCALITY_FIELD_PLACEHOLDER,
  searchAction = searchLocalitiesAction,
}: Props) {
  const [query, setQuery] = useState(
    initialPick
      ? (initialPick.aliasName ?? initialPick.localityName)
      : (defaultValue?.localityName ?? ""),
  );
  // The query the current `results` array actually answers.
  //
  // Without this, "Sin resultados." was a LIE for most of its life: it rendered
  // whenever results were empty and no transition was in flight, which includes
  // the entire 200 ms debounce window before the first request is even sent. A
  // funcionario typing their own municipality watched "Sin resultados." sit
  // under the field the whole time they typed, and concluded the municipality
  // was missing from the registry (QA report 2026-08-01). Nothing was broken —
  // the component was reporting "nothing found" when it meant "not asked yet".
  //
  // null = no answered search for the current input.
  const [settledQuery, setSettledQuery] = useState<string | null>(null);
  // Latest input, readable synchronously from inside an in-flight request so a
  // slow response for "Pal" cannot overwrite a fast one for "Palermo".
  const latestQueryRef = useRef(query);
  // Set by handleSelect so the effect can tell "the user typed this" from "we
  // wrote this into the box because they picked it".
  const justPickedRef = useRef(initialPick !== null);
  // Hold the picked result so we can surface its provinceCode + indecId in
  // hidden inputs. When the user types without picking, this is null and
  // the hidden inputs fall back to the raw query (locality) + defaultValue
  // (province) — same tolerant contract as LocalityCombobox.
  const [selected, setSelected] = useState<LocalitySearchResult | null>(initialPick);
  const [results, setResults] = useState<LocalitySearchResult[]>([]);
  const [open, setOpen] = useState(false);
  // An edit-mode pre-fill is a real catalog row until the user types over it.
  const [touched, setTouched] = useState(false);
  // `pending` is deliberately unused: it only covers the in-flight request, not
  // the debounce window before it, and reporting on that half was the bug.
  // `searching` below is the honest signal.
  const [, startTransition] = useTransition();
  const [errored, setErrored] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latestQueryRef.current = query;
    // The input text was just set BY a pick, not typed. Re-asking the catalog
    // for the exact name it returned is pointless, and the reopened dropdown it
    // caused (setOpen(results.length > 0) below) landed straight over the
    // choice the user had just made — which reads as the pick not registering.
    if (justPickedRef.current) {
      justPickedRef.current = false;
      return;
    }
    if (query.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setSettledQuery(null);
      setOpen(false);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      startTransition(async () => {
        // scopeProvinceCode (when set) restricts results to one province;
        // otherwise the action returns matches across every province (it
        // filters only when provinceCode is supplied).
        const res = await searchAction({
          query,
          provinceCode: scopeProvinceCode ?? undefined,
        });
        // A newer keystroke already superseded this request. Applying it would
        // mark a stale query as "settled" and strand the field in a state where
        // it reports on text the user is no longer typing.
        if (latestQueryRef.current !== query) return;
        if ("results" in res) {
          setResults(res.results);
          setSettledQuery(query);
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
  }, [query, scopeProvinceCode, searchAction]);

  function handleSelect(r: LocalitySearchResult) {
    justPickedRef.current = true;
    setSelected(r);
    // An alias pick shows the name the person typed ("Banfield"); the hidden
    // inputs below still carry the catalogue row it selects (Lomas de Zamora).
    setQuery(r.aliasName ?? r.localityName);
    setOpen(false);
    onSelect?.(r);
  }

  const hasUntouchedDefault =
    !touched && Boolean(defaultValue?.localityName) && Boolean(defaultValue?.provinceCode);
  const status = resolveLocalityFieldStatus({
    query,
    settledQuery,
    resultCount: results.length,
    errored,
    hasPick: selected !== null,
    hasUntouchedDefault,
  });

  // Hidden-input values. When the user picked a result, all four are
  // canonical; when they typed free text, we fall through to the raw query
  // and the defaultValue's province — same tolerant contract as the legacy
  // LocalityCombobox so server actions keep working.
  const provinceCodeValue = selected?.provinceCode ?? defaultValue?.provinceCode ?? "";
  const provinceNameValue = selected?.provinceName ?? defaultValue?.provinceName ?? "";
  const localityNameValue = selected?.localityName ?? query;
  const indecIdValue = selected?.indecId ?? defaultValue?.indecId ?? "";

  // Decouple the visible-input id from the hidden-input name namespace.
  // form.elements.namedItem("localityName") must resolve to the single hidden
  // input, not collide with a same-named id on the visible input.
  const visibleInputId = id ? `${id}-input` : undefined;

  return (
    <div className="relative">
      <LnCombobox
        id={visibleInputId}
        type="text"
        disabled={disabled}
        value={query}
        onChange={(e) => {
          // Read BEFORE the resets below: was the field holding a catalog row
          // until this keystroke?
          const wasCommitted = selected !== null || hasUntouchedDefault;
          setQuery(e.target.value);
          setSelected(null);
          setTouched(true);
          if (wasCommitted) onDeselect?.();
          onQueryChange?.(e.target.value);
        }}
        onFocus={() => {
          if (results.length > 0) setOpen(true);
        }}
        placeholder={placeholder}
        required={required}
        aria-required={required || undefined}
        // Only system-catalog localities are valid here — suppress the browser's
        // own autofill/history/password-manager dropdown so it can't overlay or
        // pollute the results (see lib/ui/no-browser-autofill.ts).
        {...NO_BROWSER_AUTOFILL}
        items={results}
        // An alias row shares its target's indecId with the direct row (and with
        // other aliases of the same target), so the alias is part of the key.
        getItemKey={(r) =>
          `${r.indecId ?? `${r.provinceCode}-${r.localitySlug}-${r.departmentName ?? "x"}`}${
            r.aliasName ? `~${r.aliasName}` : ""
          }`
        }
        onSelect={handleSelect}
        open={open}
        onOpenChange={setOpen}
        listClassName="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border border-ln-line  bg-ln-card  shadow-lg"
        renderItem={(r, { active }) => (
          <div
            className={`block w-full text-left px-3 py-2 ${
              active ? "bg-ln-stripe " : "hover:bg-ln-stripe "
            }`}
          >
            <p className="text-sm text-ln-ink ">{localityOptionLabel(r)}</p>
            <p className="text-xs text-ln-mute ">
              {r.departmentName ? `${r.departmentName}, ` : ""}
              {r.provinceName}
            </p>
          </div>
        )}
      />
      {/* Wire contract:
            provinceCode        — ISO 3166-2:AR. Empty when user typed free text and there's no defaultValue.
            provinceName        — display, for forms that prefer the name in DB.
            localityName        — canonical when picked, raw query otherwise.
            localityNameIndecId — INDEC id; empty when free text. */}
      <input type="hidden" name="provinceCode" value={provinceCodeValue} />
      <input type="hidden" name="provinceName" value={provinceNameValue} />
      <input type="hidden" name={name} value={localityNameValue} />
      <input type="hidden" name={`${name}IndecId`} value={indecIdValue} />
      {status === "searching" && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ln-mute">
          Buscando…
        </span>
      )}

      <LocalityFieldStatusLine
        status={status}
        query={query}
        chosenLine={
          selected
            ? describeChosenLocality(selected)
            : provinceNameValue && defaultValue?.provinceCode
              ? describeChosenLocality({
                  localityName: localityNameValue,
                  provinceCode: defaultValue.provinceCode,
                  provinceName: provinceNameValue,
                  departmentName: null,
                })
              : ""
        }
      />

      {errored && (
        <p className="text-xs text-ln-warn  mt-1">
          No pudimos buscar localidades ahora. Probá de nuevo en un momento.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

/**
 * What the field should be saying about itself right now.
 *
 * Extracted as a pure function because the states are the whole bug: the old
 * component could only say "Sin resultados.", so every other state — searching,
 * confirmed, typed-but-not-picked — was communicated by silence.
 */
export type LocalityFieldStatus = "idle" | "searching" | "no-results" | "committed" | "needs-pick";

export function resolveLocalityFieldStatus(input: {
  query: string;
  /** The query the current results answer; null when nothing has been answered. */
  settledQuery: string | null;
  resultCount: number;
  errored: boolean;
  /** The user picked a catalog row. */
  hasPick: boolean;
  /** Edit-mode pre-fill the user has not typed over — already a catalog row. */
  hasUntouchedDefault: boolean;
}): LocalityFieldStatus {
  // The error message renders on its own; do not stack a second line under it.
  if (input.errored) return "idle";

  // Before "searching", deliberately: picking a row re-runs the search for the
  // exact name that was picked, and flickering "Buscando…" over a confirmation
  // the user just earned reads as the pick not having registered.
  if (input.hasPick || input.hasUntouchedDefault) return "committed";

  // Long enough to search but no answer for THIS text yet. Covers the debounce
  // window, not just the request — reporting "Sin resultados." during the
  // debounce was the actual defect (QA report 2026-08-01).
  if (input.query.length >= MIN_QUERY_LENGTH && input.settledQuery !== input.query) {
    return "searching";
  }

  // Only once a real search for this exact text came back empty.
  if (input.settledQuery === input.query && input.resultCount === 0) return "no-results";

  if (input.query.trim() !== "" && input.resultCount > 0) return "needs-pick";

  return "idle";
}

function LocalityFieldStatusLine({
  status,
  query,
  chosenLine,
}: {
  status: LocalityFieldStatus;
  query: string;
  /** "Banfield · partido de Lomas de Zamora, Buenos Aires" — see describeChosenLocality. */
  chosenLine: string;
}) {
  if (status === "searching") {
    return (
      <p className="text-xs text-ln-mute mt-1" aria-live="polite">
        Buscando localidades…
      </p>
    );
  }

  if (status === "no-results") {
    // Names the text that failed and points at the likely cause. A bare "Sin
    // resultados." reads to a funcionario as "my municipality is not in the
    // national registry" rather than "check the spelling" — and the catalog
    // holds every INDEC locality, so that reading is always wrong.
    //
    // The escalation address MUST be institutional, and this file has twice
    // been the reason why. It shipped a maintainer's personal Gmail (cold-start
    // review RA-6, finding 3) because the state looks internal and is not: it
    // renders on the PUBLIC /adoptar and /perdidas filters, on citizen
    // registration, and on /admin/govts/new, the screen where a funcionario
    // onboards a jurisdiction. The cure was a local `CATALOG_CONTACT_EMAIL`
    // const, which was a single source of truth for this file and a decoy for
    // the four others that kept retyping the same address — all five at a
    // domain that does not resolve. Hence lib/ui/contact.ts.
    return (
      <p className="text-xs text-ln-mute mt-1" aria-live="polite">
        No encontramos “{query}”. Probá con menos letras o revisá la ortografía.{" "}
        <a
          href={mailtoHref(CONTACT_EMAILS.general, {
            subject: "miMAR — Agregar localidad",
            body: `Localidad: ${query}`,
          })}
          className="underline"
        >
          Sugerí esta localidad
        </a>
      </p>
    );
  }

  if (status === "committed") {
    // The restriction stays — only a real ar_localities row is accepted. What
    // was missing is the acknowledgement: until now the only feedback that a
    // pick had registered arrived at submit time, as a rejection.
    return (
      <p className="text-xs text-ln-ok mt-1">
        {chosenLine ? `Confirmado: ${chosenLine}` : "Confirmado"}
      </p>
    );
  }

  if (status === "needs-pick") {
    return (
      <p className="text-xs text-ln-warn mt-1" aria-live="polite">
        Elegí una de las opciones para confirmar tu localidad.
      </p>
    );
  }

  return null;
}
