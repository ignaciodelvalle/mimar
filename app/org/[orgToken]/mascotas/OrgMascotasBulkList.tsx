"use client";

// Client component for the mascotas list. Mirrors the multi-select UI of
// BulkApprovalQueueList but for bulk vaccination, bulk eligibility, and
// bulk adoption-listing publish.
//
// When canEventWrite is true and ≥1 pets are selected, a sticky BulkActionBar
// appears with "Vacunar selección". Clicking it opens an inline
// BulkVaccinationForm. On submit it calls bulkVaccinateAction and shows a
// ResultPanel ("N vacunadas · M fallaron" + per-pet failure reasons +
// bulkActionId). Users without event.write see the list read-only.
//
// Sprint 8 PR2: added "Marcar elegibilidad" button (canIntake) that opens a
// BulkEligibilityForm inline. Only one form is open at a time. Both actions
// share the same selection set.
//
// Sprint 8 PR3: added "Publicar en adopción" button (canManageListing) that
// opens a BulkListingForm inline. Publish and unlist paths. Same selection set.

import Link from "next/link";
import { useState, useTransition } from "react";

import type { BulkResult } from "@/app/actions/bulk-actions";
import {
  bulkPublishListingAction,
  bulkSetEligibilityAction,
  bulkVaccinateAction,
} from "@/app/actions/bulk-pet-events";
import { BULK_INELIGIBLE_REASONS } from "@/app/actions/bulk-vaccinate-types";
import { Icon } from "@/components/Icon";
import { LnCheckbox } from "@/components/ui/Field";
import {
  OpBulkResultPanel,
  OpButton,
  OpInput,
  OpSelect,
  OpStateBadge,
} from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { pluralizeEs, speciesLabel, todayIsoInAr } from "@/lib/utils/format";
import { OrgMascotasPipelineBoard } from "./OrgMascotasPipelineBoard";
import { type CtaTone, type PetCardData, buildMascotaCtas } from "./mascota-ctas";

// ─── Types ────────────────────────────────────────────────────────────────────

// PetCardData's canonical definition lives in mascota-ctas.tsx (the pure,
// server-action-free module) — re-exported here so existing importers of
// this path (e.g. __tests__/pet-pipeline.test.ts) are unaffected.
export type { PetCardData } from "./mascota-ctas";

type Props = {
  cards: PetCardData[];
  fosteredPetIds: string[];
  pendingProposalPetIds: string[];
  orgToken: string;
  canIntake: boolean;
  canAssignFoster: boolean;
  canEndFoster: boolean;
  canFinalizeAdoption: boolean;
  canTransfer: boolean;
  canReturnToOwner: boolean;
  canManageAdoptionListing: boolean;
  canEventWrite: boolean;
  /** True when a species/text filter is active — changes the empty-state copy. */
  hasActiveFilters?: boolean;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const ROLE_BADGE: Record<string, { label: string; className: string }> = {
  owner: {
    label: "Dueño",
    className: "bg-ln-op-ok-bg text-ln-op-ok border border-ln-op-ok-bd",
  },
  shelter_custody: {
    label: "En custodia",
    className: "bg-ln-op-warn-bg text-ln-op-warn border border-ln-op-warn-bd",
  },
  foster: {
    label: "Tránsito",
    className: "bg-ln-op-blue-bg text-ln-op-azul border border-ln-op-blue-bd",
  },
  co_owner: {
    label: "Co-dueño",
    className: "bg-ln-op-stripe text-ln-op-mute border border-ln-op-line",
  },
  caretaker: {
    label: "Caretaker",
    className: "bg-ln-op-stripe text-ln-op-mute border border-ln-op-line",
  },
};

const INELIGIBLE_REASON_LABELS: Record<(typeof BULK_INELIGIBLE_REASONS)[number], string> = {
  medical_treatment: "Tratamiento médico",
  behavioral_evaluation: "Evaluación conductual",
  recovery: "Recuperación",
  quarantine: "Cuarentena",
  legal_hold: "Retención legal",
  age: "Edad",
  pending_intake_eval: "Evaluación de ingreso pendiente",
  other: "Otro",
};

const BULK_MAX = 500;

// Per-card CTA ranking now lives in buildMascotaCtas (./mascota-ctas.tsx) —
// pure and unit-tested there, independent of this component's server-action
// imports. This file only owns the PRIMARY-tile styling.
const PRIMARY_CTA_CLS: Record<CtaTone, string> = {
  azul: "inline-flex items-center gap-1 text-sm font-semibold px-2.5 py-1.5 rounded-[var(--radius-sm)] bg-ln-op-azul text-white hover:bg-ln-op-azul-700",
};

function calcAge(dob: string): string {
  const birth = new Date(dob);
  const now = new Date();
  const months =
    (now.getFullYear() - birth.getFullYear()) * 12 + (now.getMonth() - birth.getMonth());
  if (months < 12) {
    const clamped = Math.max(0, months);
    return `${clamped} ${pluralizeEs(clamped, "mes")}`;
  }
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  if (remMonths === 0) return `${years} ${pluralizeEs(years, "año")}`;
  return `${years} ${pluralizeEs(years, "año")} ${remMonths} m`;
}

// Derive OpStateBadge state from card data.
function deriveAdoptionState(
  card: PetCardData,
): "published" | "paused" | "draft" | "adopted" | null {
  if (card.status === "active" && card.adoptionListedAt && !card.adoptionListingPausedAt)
    return "published";
  if (card.adoptionListedAt && card.adoptionListingPausedAt) return "paused";
  if (card.adoptionEligible === true) return "draft";
  return null;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function OrgMascotasBulkList({
  cards,
  fosteredPetIds,
  pendingProposalPetIds,
  orgToken,
  canIntake,
  canAssignFoster,
  canEndFoster,
  canFinalizeAdoption,
  canTransfer,
  canReturnToOwner,
  canManageAdoptionListing,
  canEventWrite,
  hasActiveFilters = false,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"none" | "vaccinate" | "eligibility" | "listing">("none");
  const [lastResult, setLastResult] = useState<BulkResult | null>(null);
  const [lastResultType, setLastResultType] = useState<
    "vaccinate" | "eligibility" | "listing-publish" | "listing-unlist" | null
  >(null);
  // View toggle: "list" (default) or "board" (pipeline).
  const [view, setView] = useState<"list" | "board">("list");

  const fosteredSet = new Set(fosteredPetIds);
  const pendingProposalSet = new Set(pendingProposalPetIds);

  const canBulkSelect = canEventWrite || canIntake || canManageAdoptionListing;

  function toggle(token: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(cards.map((c) => c.publicToken)));
  }

  function clear() {
    setSelected(new Set());
    setMode("none");
    setLastResult(null);
    setLastResultType(null);
  }

  const allSelected = selected.size === cards.length && cards.length > 0;
  const someSelected = selected.size > 0;

  // Post-bulk navigation (router.refresh() is banned — it rides the same
  // client-router transition machinery as the silent-drop defect; see
  // lib/ui/full-page-action-nav.ts). Clean success → immediate full reload
  // so the SSR list reflects the new state. Partial failure → keep the
  // ResultPanel visible (partial failure must stay legible) and do the full
  // reload when the operator dismisses it.
  function settleBulkResult(
    result: BulkResult,
    type: "vaccinate" | "eligibility" | "listing-publish" | "listing-unlist",
  ) {
    if (result.failed.length === 0) {
      navigateAfterActionSuccess(window.location.href);
      return;
    }
    setLastResult(result);
    setLastResultType(type);
    setMode("none");
    setSelected(new Set());
  }

  function dismissResult() {
    if (lastResult && lastResult.succeeded.length > 0) {
      // Some rows DID change server-side — the list is stale; reload it.
      navigateAfterActionSuccess(window.location.href);
      return;
    }
    setLastResult(null);
    setLastResultType(null);
  }

  if (cards.length === 0) {
    return (
      <p className="text-md text-ln-op-mute">
        {hasActiveFilters
          ? "Ningún animal coincide con el filtro aplicado."
          : "Todavía no hay animales registrados a nombre de la organización."}
      </p>
    );
  }

  return (
    <div className="space-y-3 pb-32">
      {/* View toggle: Lista / Tablero */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {canBulkSelect && view === "list" && (
          <div className="flex items-center gap-3 text-sm text-ln-op-mute">
            <button
              type="button"
              onClick={allSelected ? clear : selectAll}
              className="underline hover:text-ln-op-ink"
            >
              {allSelected ? "Deseleccionar todo" : `Seleccionar todo (${cards.length})`}
            </button>
          </div>
        )}
        {!canBulkSelect && <div />}

        <fieldset className="inline-flex rounded-[var(--radius-md)] border border-ln-op-line overflow-hidden text-sm p-0">
          <legend className="sr-only">Vista</legend>
          <button
            type="button"
            onClick={() => setView("list")}
            aria-pressed={view === "list"}
            className={[
              "px-3 py-1.5 font-medium transition-colors",
              view === "list"
                ? "bg-ln-op-azul text-white"
                : "bg-ln-op-card text-ln-op-mute hover:text-ln-op-ink",
            ].join(" ")}
          >
            Lista
          </button>
          <button
            type="button"
            onClick={() => setView("board")}
            aria-pressed={view === "board"}
            className={[
              "px-3 py-1.5 font-medium transition-colors border-l border-ln-op-line",
              view === "board"
                ? "bg-ln-op-azul text-white"
                : "bg-ln-op-card text-ln-op-mute hover:text-ln-op-ink",
            ].join(" ")}
          >
            Tablero
          </button>
        </fieldset>
      </div>

      {/* Board view */}
      {view === "board" && (
        <OrgMascotasPipelineBoard
          cards={cards}
          fosteredPetIds={fosteredPetIds}
          orgToken={orgToken}
        />
      )}

      {/* List view */}
      {view === "list" && (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {cards.map((card) => {
            const isSelected = selected.has(card.publicToken);
            const badge = ROLE_BADGE[card.ownershipRole] ?? ROLE_BADGE.shelter_custody;
            const ageInfo = card.dateOfBirth
              ? `${card.birthDateIsEstimated ? "~" : ""}${calcAge(card.dateOfBirth)}`
              : "edad desconocida";
            const hasFoster = fosteredSet.has(card.petId);
            const [primaryCta, ...secondaryCtas] = buildMascotaCtas(card, orgToken, {
              canIntake,
              canAssignFoster,
              canEndFoster,
              canFinalizeAdoption,
              canTransfer,
              canReturnToOwner,
              canManageAdoptionListing,
              hasFoster,
              hasPendingProposal: pendingProposalSet.has(card.petId),
            });

            const adState = deriveAdoptionState(card);

            return (
              <li
                key={card.petId}
                // CSS-8: capped at 200 rows (CUSTODY_LIST_CAP) with no
                // virtualization — content-visibility skips off-screen rows.
                // The taller estimate (op-lazy-row-lg): this card carries a
                // CTA row the compact list rows elsewhere don't.
                className={`op-lazy-row-lg rounded-[var(--radius-md)] border p-3 space-y-2 ${
                  isSelected
                    ? "border-ln-op-azul bg-ln-op-blue-bg"
                    : "border-ln-op-line bg-ln-op-card"
                }`}
              >
                <div className="flex items-start gap-2">
                  {canBulkSelect && (
                    <LnCheckbox
                      id={`row-${card.publicToken}`}
                      checked={isSelected}
                      onChange={() => toggle(card.publicToken)}
                      aria-label={`Seleccionar ${card.name}`}
                      className="mt-1 shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0 flex items-start justify-between gap-2">
                    <Link
                      href={`/mis-mascotas/${card.publicToken}`}
                      className="flex-1 min-w-0 hover:underline"
                    >
                      <p className="text-md font-semibold text-ln-op-ink">{card.name}</p>
                      <p className="text-sm text-ln-op-mute">
                        {speciesLabel(card.species)}
                        {card.breed ? ` · ${card.breed}` : ""}
                        {card.color ? ` · ${card.color}` : ""}
                      </p>
                    </Link>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-bold uppercase tracking-wide ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                      {hasFoster && card.ownershipRole === "shelter_custody" && (
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full font-bold uppercase tracking-wide ${ROLE_BADGE.foster.className}`}
                        >
                          + tránsito
                        </span>
                      )}
                      {adState && <OpStateBadge state={adState} />}
                    </div>
                  </div>
                </div>
                <p className="text-sm text-ln-op-mute">
                  {ageInfo} · ingreso{" "}
                  {new Date(card.startedAt).toLocaleDateString("es-AR", {
                    dateStyle: "medium",
                    // Fixed timeZone — server (UTC) and client (browser-local)
                    // must format the same calendar day, otherwise dates near
                    // local midnight flip between SSR and hydration (#418).
                    timeZone: "America/Argentina/Buenos_Aires",
                  })}
                </p>
                <p className="text-sm text-ln-op-mute">
                  <code className="font-ln-mono">{card.publicToken}</code>
                </p>
                {primaryCta && (
                  <div className="pt-1 flex items-center gap-2 flex-wrap">
                    <Link href={primaryCta.href} className={PRIMARY_CTA_CLS[primaryCta.tone]}>
                      {primaryCta.label}
                    </Link>
                    {secondaryCtas.length > 0 && (
                      // Native <details> as the overflow menu — no client state
                      // needed, keyboard-accessible by default (Enter/Space
                      // toggles), consistent with the collapsed-disclosure
                      // convention used elsewhere in the admin/gob/org consoles.
                      <details className="relative">
                        <summary className="list-none inline-flex items-center gap-1 cursor-pointer text-sm px-2 py-1 rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-stripe text-ln-op-mute hover:text-ln-op-ink select-none [&::-webkit-details-marker]:hidden">
                          <Icon name="ellipsis" size={14} decorative />
                          Más
                          <span className="sr-only">acciones</span>
                        </summary>
                        <div className="absolute left-0 z-10 mt-1 min-w-[190px] rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-1 shadow-lg space-y-0.5">
                          {secondaryCtas.map((c) => (
                            <Link
                              key={c.key}
                              href={c.href}
                              className="block px-2 py-1.5 rounded-[var(--radius-sm)] text-sm text-ln-op-ink hover:bg-ln-op-stripe"
                            >
                              {c.label}
                            </Link>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {lastResult && (
        <OpBulkResultPanel
          result={lastResult}
          successLabel={successNoun(lastResult, lastResultType ?? "vaccinate")}
          onDismiss={dismissResult}
        />
      )}

      {someSelected && canBulkSelect && (
        <div className="fixed bottom-0 left-0 right-0 border-t border-ln-op-line bg-ln-op-card z-50">
          <div className="max-w-3xl mx-auto px-6 py-3 space-y-3">
            {mode === "none" && (
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-md">
                    <span className="font-medium">{selected.size}</span>{" "}
                    {pluralizeEs(selected.size, "seleccionada")}
                    {selected.size > BULK_MAX && (
                      <span className="ml-2 text-ln-op-danger text-sm">(máx. {BULK_MAX})</span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={clear}
                    className="text-sm text-ln-op-mute hover:text-ln-op-ink"
                  >
                    Limpiar
                  </button>
                  {canEventWrite && (
                    <OpButton
                      type="button"
                      size="sm"
                      onClick={() => setMode("vaccinate")}
                      disabled={selected.size > BULK_MAX}
                    >
                      Vacunar selección
                    </OpButton>
                  )}
                  {canIntake && (
                    <OpButton
                      type="button"
                      size="sm"
                      onClick={() => setMode("eligibility")}
                      disabled={selected.size > BULK_MAX}
                    >
                      Marcar elegibilidad
                    </OpButton>
                  )}
                  {/* Azul like its two neighbours (one-primary-per-screen
                      review, 2026-08-06): all three only OPEN a mode. The green
                      stayed on "Confirmar publicación" below, which is the step
                      that actually commits. */}
                  {canManageAdoptionListing && (
                    <OpButton
                      type="button"
                      size="sm"
                      onClick={() => setMode("listing")}
                      disabled={selected.size > BULK_MAX}
                    >
                      Publicar en adopción
                    </OpButton>
                  )}
                </div>
              </div>
            )}

            {mode === "vaccinate" && (
              <BulkVaccinationForm
                count={selected.size}
                pending={pending}
                onCancel={() => setMode("none")}
                onSubmit={(fields) => {
                  const tokens = Array.from(selected);
                  setLastResult(null);
                  setLastResultType(null);
                  startTransition(async () => {
                    const bulkActionId = crypto.randomUUID();
                    const result = await bulkVaccinateAction({
                      orgToken,
                      petPublicTokens: tokens,
                      bulkActionId,
                      ...fields,
                    });
                    settleBulkResult(result, "vaccinate");
                  });
                }}
              />
            )}

            {mode === "eligibility" && (
              <BulkEligibilityForm
                count={selected.size}
                pending={pending}
                onCancel={() => setMode("none")}
                onSubmit={(fields) => {
                  const tokens = Array.from(selected);
                  setLastResult(null);
                  setLastResultType(null);
                  startTransition(async () => {
                    const bulkActionId = crypto.randomUUID();
                    const result = await bulkSetEligibilityAction({
                      orgToken,
                      petPublicTokens: tokens,
                      bulkActionId,
                      ...fields,
                    });
                    settleBulkResult(result, "eligibility");
                  });
                }}
              />
            )}

            {mode === "listing" && (
              <BulkListingForm
                count={selected.size}
                pending={pending}
                onCancel={() => setMode("none")}
                onSubmit={(publish) => {
                  const tokens = Array.from(selected);
                  setLastResult(null);
                  setLastResultType(null);
                  startTransition(async () => {
                    const bulkActionId = crypto.randomUUID();
                    const result = await bulkPublishListingAction({
                      orgToken,
                      petPublicTokens: tokens,
                      bulkActionId,
                      publish,
                    });
                    settleBulkResult(result, publish ? "listing-publish" : "listing-unlist");
                  });
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── BulkVaccinationForm ──────────────────────────────────────────────────────

type VaccinationFields = {
  vaccineName: string;
  occurredAt: string;
  brand?: string | null;
  batch?: string | null;
  administeredBy?: string | null;
  nextDueAt?: string | null;
};

function BulkVaccinationForm({
  count,
  pending,
  onCancel,
  onSubmit,
}: {
  count: number;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (fields: VaccinationFields) => void;
}) {
  const today = todayIsoInAr();
  const [vaccineName, setVaccineName] = useState("");
  const [occurredAt, setOccurredAt] = useState(today);
  const [brand, setBrand] = useState("");
  const [batch, setBatch] = useState("");
  const [administeredBy, setAdministeredBy] = useState("");
  const [nextDueAt, setNextDueAt] = useState("");

  function handleSubmit() {
    onSubmit({
      vaccineName: vaccineName.trim(),
      occurredAt,
      brand: brand.trim() || null,
      batch: batch.trim() || null,
      administeredBy: administeredBy.trim() || null,
      nextDueAt: nextDueAt.trim() || null,
    });
  }

  const canSubmit = vaccineName.trim().length > 0 && occurredAt.length > 0;

  return (
    <div className="space-y-3">
      <p className="text-md font-medium text-ln-op-ink">
        Vacunar {count} {pluralizeEs(count, "animal")}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-sm text-ln-op-mute" htmlFor="bulk-vax-name">
            Vacuna <span className="text-ln-op-danger">*</span>
          </label>
          <OpInput
            id="bulk-vax-name"
            type="text"
            value={vaccineName}
            onChange={(e) => setVaccineName(e.target.value)}
            placeholder="Ej. Cuádruple canina"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm text-ln-op-mute" htmlFor="bulk-vax-date">
            Fecha de aplicación <span className="text-ln-op-danger">*</span>
          </label>
          <OpInput
            id="bulk-vax-date"
            type="date"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm text-ln-op-mute" htmlFor="bulk-vax-brand">
            Marca (opcional)
          </label>
          <OpInput
            id="bulk-vax-brand"
            type="text"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            placeholder="Ej. Nobivac"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm text-ln-op-mute" htmlFor="bulk-vax-batch">
            Lote (opcional)
          </label>
          <OpInput
            id="bulk-vax-batch"
            type="text"
            value={batch}
            onChange={(e) => setBatch(e.target.value)}
            placeholder="Ej. L-2024-07"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm text-ln-op-mute" htmlFor="bulk-vax-by">
            Aplicado por (opcional)
          </label>
          <OpInput
            id="bulk-vax-by"
            type="text"
            value={administeredBy}
            onChange={(e) => setAdministeredBy(e.target.value)}
            placeholder="Ej. Dr. Gómez MP 1234"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm text-ln-op-mute" htmlFor="bulk-vax-next">
            Próxima dosis (opcional)
          </label>
          <OpInput
            id="bulk-vax-next"
            type="date"
            value={nextDueAt}
            onChange={(e) => setNextDueAt(e.target.value)}
          />
        </div>
      </div>

      <div className="flex gap-2 justify-end">
        <OpButton type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </OpButton>
        <OpButton type="button" size="sm" onClick={handleSubmit} disabled={pending || !canSubmit}>
          {pending ? "Registrando..." : "Confirmar vacunación"}
        </OpButton>
      </div>
    </div>
  );
}

// ─── BulkEligibilityForm ──────────────────────────────────────────────────────

type EligibilityFields = {
  eligible: boolean;
  ineligibleReason?: (typeof BULK_INELIGIBLE_REASONS)[number] | null;
  ineligibleReasonNotes?: string | null;
  ineligibleUntilIso?: string | null;
};

function BulkEligibilityForm({
  count,
  pending,
  onCancel,
  onSubmit,
}: {
  count: number;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (fields: EligibilityFields) => void;
}) {
  const [eligible, setEligible] = useState<boolean>(true);
  const [ineligibleReason, setIneligibleReason] = useState<
    (typeof BULK_INELIGIBLE_REASONS)[number] | ""
  >("");
  const [ineligibleReasonNotes, setIneligibleReasonNotes] = useState("");
  const [ineligibleUntilIso, setIneligibleUntilIso] = useState("");

  const needsReason = !eligible;
  const needsNotes = ineligibleReason === "other";
  const canSubmit =
    eligible ||
    (ineligibleReason !== "" &&
      (ineligibleReason !== "other" || ineligibleReasonNotes.trim().length > 0));

  function handleSubmit() {
    onSubmit({
      eligible,
      ineligibleReason: eligible
        ? null
        : (ineligibleReason as (typeof BULK_INELIGIBLE_REASONS)[number]) || null,
      ineligibleReasonNotes: eligible ? null : ineligibleReasonNotes.trim() || null,
      ineligibleUntilIso: eligible ? null : ineligibleUntilIso.trim() || null,
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-md font-medium text-ln-op-ink">
        Marcar elegibilidad — {count} {pluralizeEs(count, "animal")}
      </p>

      <div className="flex gap-4">
        <label className="flex items-center gap-2 text-md cursor-pointer text-ln-op-ink">
          <input
            type="radio"
            name="bulk-elig-toggle"
            checked={eligible}
            onChange={() => {
              setEligible(true);
              setIneligibleReason("");
              setIneligibleReasonNotes("");
              setIneligibleUntilIso("");
            }}
            className="accent-ln-op-ok"
          />
          Apta para adopción
        </label>
        <label className="flex items-center gap-2 text-md cursor-pointer text-ln-op-ink">
          <input
            type="radio"
            name="bulk-elig-toggle"
            checked={!eligible}
            onChange={() => setEligible(false)}
            className="accent-ln-op-danger"
          />
          No apta para adopción
        </label>
      </div>

      {needsReason && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-sm text-ln-op-mute" htmlFor="bulk-elig-reason">
              Razón <span className="text-ln-op-danger">*</span>
            </label>
            <OpSelect
              id="bulk-elig-reason"
              value={ineligibleReason}
              onChange={(e) =>
                setIneligibleReason(e.target.value as (typeof BULK_INELIGIBLE_REASONS)[number] | "")
              }
            >
              <option value="">Seleccioná una razón</option>
              {BULK_INELIGIBLE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {INELIGIBLE_REASON_LABELS[r]}
                </option>
              ))}
            </OpSelect>
          </div>

          <div className="space-y-1">
            <label className="text-sm text-ln-op-mute" htmlFor="bulk-elig-until">
              No apta hasta (opcional)
            </label>
            <OpInput
              id="bulk-elig-until"
              type="date"
              value={ineligibleUntilIso}
              onChange={(e) => setIneligibleUntilIso(e.target.value)}
            />
          </div>

          {needsNotes && (
            <div className="space-y-1 sm:col-span-2">
              <label className="text-sm text-ln-op-mute" htmlFor="bulk-elig-notes">
                Notas <span className="text-ln-op-danger">*</span>
              </label>
              <OpInput
                id="bulk-elig-notes"
                type="text"
                value={ineligibleReasonNotes}
                onChange={(e) => setIneligibleReasonNotes(e.target.value)}
                placeholder="Describí la situación"
              />
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <OpButton type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </OpButton>
        <OpButton type="button" size="sm" onClick={handleSubmit} disabled={pending || !canSubmit}>
          {pending ? "Guardando..." : "Confirmar elegibilidad"}
        </OpButton>
      </div>
    </div>
  );
}

// ─── BulkListingForm ──────────────────────────────────────────────────────────

function BulkListingForm({
  count,
  pending,
  onCancel,
  onSubmit,
}: {
  count: number;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (publish: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-md font-medium text-ln-op-ink">
        Publicar en adopción — {count} {pluralizeEs(count, "animal")}
      </p>
      <p className="text-sm text-ln-op-mute">
        Solo se publicarán las mascotas que cumplan todos los requisitos (apta para adopción, sin
        disputas, sin observación sanitaria activa, etc.). Las que no cumplan aparecerán en el
        detalle de fallos con la razón específica.
      </p>
      <div className="flex gap-2 justify-end">
        <OpButton type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </OpButton>
        <OpButton
          type="button"
          size="sm"
          variant="danger"
          onClick={() => onSubmit(false)}
          disabled={pending}
        >
          {pending ? "Procesando..." : "Despublicar selección"}
        </OpButton>
        <OpButton
          type="button"
          size="sm"
          variant="ok"
          onClick={() => onSubmit(true)}
          disabled={pending}
        >
          {pending ? "Publicando..." : "Confirmar publicación"}
        </OpButton>
      </div>
    </div>
  );
}

// ─── Success noun ─────────────────────────────────────────────────────────────
// Domain-specific singular/plural noun for the OpBulkResultPanel summary line
// (e.g. "3 vacunadas · 1 fallaron"). Kept here, not in the shared primitive —
// the vaccinate/eligibility/listing vocabulary is specific to this screen.

function successNoun(
  result: BulkResult,
  actionType: "vaccinate" | "eligibility" | "listing-publish" | "listing-unlist",
): string {
  const nounSingular =
    actionType === "vaccinate"
      ? "vacunada"
      : actionType === "listing-publish"
        ? "publicada"
        : actionType === "listing-unlist"
          ? "despublicada"
          : "actualizada";
  const nounPlural =
    actionType === "vaccinate"
      ? "vacunadas"
      : actionType === "listing-publish"
        ? "publicadas"
        : actionType === "listing-unlist"
          ? "despublicadas"
          : "actualizadas";
  return result.succeeded.length === 1 ? nounSingular : nounPlural;
}
