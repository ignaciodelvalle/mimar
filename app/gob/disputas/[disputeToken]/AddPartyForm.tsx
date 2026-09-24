"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { addDisputePartyAction, searchPartyCandidatesAction } from "@/app/actions/custody-disputes";
import type { PartyCandidate } from "@/app/actions/custody-disputes";
import { Icon } from "@/components/Icon";
import { OpButton, OpInput, OpSelect, OpTextarea } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

import type { DisputePartyRole } from "@/src/modules/custody-disputes/domain/types";

import { PARTY_ROLE_OPTIONS } from "./_party-roles";

type RoleValue = DisputePartyRole;

const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

// Real search/select picker (V9 usability fix): this used to be a raw-UUID
// text input with a separate "Verificar" round-trip before submit. It now
// searches by name over searchPartyCandidatesAction, which wraps the SAME
// audited searchUsers/searchOrganizations queries lib/infra/admin-search.ts
// already runs for /gob/usuarios and /gob/organizaciones, gated by the same
// dispute-scoped tenant-isolation check lookupTransferTargetAction used for
// its exact-ID lookup (see search-party-candidates.ts).
//
// The dropdown/keyboard interaction (debounced search, mousedown-before-blur
// select, Arrow/Enter/Escape nav) mirrors OpOmnibox
// (components/ui/dashboard/OpOmnibox.tsx) — the operator-skinned (ln-op-*)
// combobox pattern already used for the topbar global search — rather than
// LnCombobox/LocalityPickerAcross, which hardcode the CITIZEN-skinned ln-*
// tokens (see the LnCheckbox cross-skin note in components/ui/Field.tsx).
//
// The old verify-before-submit step is GONE: once the operator picks a named
// result from the dropdown there is nothing left to verify — the picker IS
// the verification (it already shows the real displayName plus a flag for a
// deactivated user / unverified org, the same signal the old "Verificar"
// button surfaced after a round trip).
export function AddPartyForm({ disputeToken }: { disputeToken: string }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [partyKind, setPartyKind] = useState<"user" | "org">("user");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<PartyCandidate[]>([]);
  const [selected, setSelected] = useState<PartyCandidate | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchErrored, setSearchErrored] = useState(false);
  const [searched, setSearched] = useState(false);
  const [partyRole, setPartyRole] = useState<RoleValue>("claimant_owner");
  const [positionSummary, setPositionSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setCandidates([]);
      setListOpen(false);
      setSearched(false);
      setActiveIndex(-1);
      return;
    }
    // A pick sets query to the candidate's own displayName — skip the
    // re-search that would otherwise fire immediately after and pop the
    // dropdown back open right after the operator just closed it.
    if (selected && selected.displayName === trimmed) return;

    let cancelled = false;
    setSearchLoading(true);
    const handle = setTimeout(async () => {
      const result = await searchPartyCandidatesAction({
        disputeToken,
        kind: partyKind,
        query: trimmed,
      });
      if (cancelled) return;
      if ("candidates" in result) {
        setCandidates(result.candidates);
        setListOpen(true);
        setSearchErrored(false);
      } else {
        setCandidates([]);
        setSearchErrored(true);
      }
      setSearched(true);
      setActiveIndex(-1);
      setSearchLoading(false);
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, partyKind, disputeToken, selected]);

  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );

  function handleKindChange(kind: "user" | "org") {
    setPartyKind(kind);
    setQuery("");
    setCandidates([]);
    setSelected(null);
    setListOpen(false);
    setSearched(false);
  }

  function handleSelect(candidate: PartyCandidate) {
    setSelected(candidate);
    setQuery(candidate.displayName);
    setListOpen(false);
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    setSelected(null);
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!listOpen || candidates.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % candidates.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + candidates.length) % candidates.length);
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && candidates[activeIndex]) {
        e.preventDefault();
        handleSelect(candidates[activeIndex]);
      }
    } else if (e.key === "Escape") {
      setListOpen(false);
    }
  }

  function handleInputBlur() {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    // Delay so a mousedown pick on an option registers before the list closes.
    blurTimer.current = setTimeout(() => setListOpen(false), 150);
  }

  function submit() {
    setError(null);
    if (!selected) {
      setError("Buscá y elegí un usuario u organización de la lista.");
      return;
    }
    startTransition(async () => {
      const result = await addDisputePartyAction({
        disputeToken,
        partyUserId: partyKind === "user" ? selected.id : null,
        partyOrgId: partyKind === "org" ? selected.id : null,
        partyRole,
        positionSummary: positionSummary.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setQuery("");
      setCandidates([]);
      setSelected(null);
      setPositionSummary("");
      // Full document reload so the SSR page reflects the mutation
      // (router.refresh() is banned - see lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  if (!open) {
    return (
      <OpButton type="button" onClick={() => setOpen(true)} variant="primary" size="sm">
        {"+ Sumar parte"}
      </OpButton>
    );
  }

  const showNoResults =
    searched && !searchLoading && !searchErrored && candidates.length === 0 && !selected;
  const showDropdown = listOpen && (candidates.length > 0 || showNoResults);

  return (
    <div className="rounded-[var(--radius-md)] border border-ln-op-line p-3 space-y-3">
      <p className="text-md font-medium text-ln-op-ink">Sumar parte a la disputa</p>

      <div className="flex gap-2 text-sm">
        <button
          type="button"
          onClick={() => handleKindChange("user")}
          className={`px-2 py-1 rounded-[var(--radius-sm)] border ${
            partyKind === "user"
              ? "bg-ln-op-azul text-white border-ln-op-azul"
              : "border-ln-op-line text-ln-op-ink hover:bg-ln-op-stripe"
          }`}
        >
          Persona
        </button>
        <button
          type="button"
          onClick={() => handleKindChange("org")}
          className={`px-2 py-1 rounded-[var(--radius-sm)] border ${
            partyKind === "org"
              ? "bg-ln-op-azul text-white border-ln-op-azul"
              : "border-ln-op-line text-ln-op-ink hover:bg-ln-op-stripe"
          }`}
        >
          Organizacion
        </button>
      </div>

      <div className="relative">
        <label htmlFor="party-search" className="block text-sm text-ln-op-mute mb-1">
          {partyKind === "user" ? "Buscar usuario por nombre" : "Buscar organización por nombre"}
        </label>
        <OpInput
          id="party-search"
          type="text"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls="party-search-listbox"
          aria-autocomplete="list"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          onFocus={() => {
            if (candidates.length > 0 || showNoResults) setListOpen(true);
          }}
          onBlur={handleInputBlur}
          onKeyDown={handleInputKeyDown}
          placeholder={partyKind === "user" ? "Ej: María Gómez" : "Ej: Refugio Huellas"}
        />

        {/* role="listbox"/"option" on <ul>/<li> — same APG combobox pattern as
            components/ui/LnCombobox.tsx and OpOmnibox.tsx, which need the
            identical biome a11y override (see biome.json). */}
        {showDropdown && (
          <ul
            id="party-search-listbox"
            role="listbox"
            tabIndex={-1}
            className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-card shadow-lg"
          >
            {candidates.length === 0
              ? showNoResults && (
                  <li className="px-3 py-2 text-sm text-ln-op-mute">Sin resultados.</li>
                )
              : candidates.map((c, index) => (
                  <li
                    key={c.id}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === activeIndex}
                    onMouseDown={(e) => {
                      // mousedown (not click) so selection fires before onBlur closes the list.
                      e.preventDefault();
                      handleSelect(c);
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={`px-3 py-2 cursor-pointer ${
                      index === activeIndex ? "bg-ln-op-stripe" : "hover:bg-ln-op-stripe"
                    }`}
                  >
                    <p className="text-md text-ln-op-ink">{c.displayName}</p>
                    <p className="text-sm text-ln-op-mute">
                      {c.secondaryLabel}
                      {c.flagLabel && <span className="text-ln-op-danger"> · {c.flagLabel}</span>}
                    </p>
                  </li>
                ))}
          </ul>
        )}

        {searchLoading && <p className="text-sm text-ln-op-mute mt-1">Buscando…</p>}
        {searchErrored && (
          <p className="text-sm text-ln-op-danger mt-1">No pudimos buscar ahora. Probá de nuevo.</p>
        )}
        {selected && (
          <p
            className={`text-sm mt-1 flex items-center gap-1 ${
              selected.flagLabel ? "text-ln-op-danger" : "text-ln-op-ok"
            }`}
          >
            <Icon name={selected.flagLabel ? "close" : "check"} size={14} decorative />
            <span>
              {selected.displayName}
              {selected.flagLabel && ` — ${selected.flagLabel}`}
            </span>
          </p>
        )}
      </div>

      <div>
        <label htmlFor="party-role" className="block text-sm text-ln-op-mute mb-1">
          Rol en la disputa
        </label>
        <OpSelect
          id="party-role"
          value={partyRole}
          onChange={(e) => setPartyRole(e.target.value as RoleValue)}
        >
          {PARTY_ROLE_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </OpSelect>
      </div>

      <div>
        <label htmlFor="party-summary" className="block text-sm text-ln-op-mute mb-1">
          Posicion / nota (opcional)
        </label>
        <OpTextarea
          id="party-summary"
          value={positionSummary}
          onChange={(e) => setPositionSummary(e.target.value)}
          rows={2}
          placeholder="Resumen de la posicion de esta parte"
        />
      </div>

      {error && <output className="block text-md text-ln-op-danger">{error}</output>}

      <div className="flex gap-2">
        <OpButton
          type="button"
          onClick={submit}
          disabled={pending || !selected}
          variant="primary"
          size="sm"
        >
          {pending ? "Sumando..." : "Sumar parte"}
        </OpButton>
        <OpButton
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          variant="ghost"
          size="sm"
        >
          Cancelar
        </OpButton>
      </div>
    </div>
  );
}
