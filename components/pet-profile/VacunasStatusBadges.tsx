"use client";

// VacunasStatusBadges — interactive "Estado de vacunación" summary (spec §5.1).
//
// PO 2026-07-05: the 3-state summary (Vigente / Por vencer / Vencida) is now a
// DRILL-DOWN — each state is a button that discloses WHICH vaccines are in it
// (from summary.perVaccine), so the count is actionable instead of opaque.
// Accordion: one state open at a time; keyboard-accessible via real <button>
// semantics + aria-expanded/aria-controls.

import {
  type VaccinationSummary,
  type VaccineSnapshot,
  hasAnyVaccineRecord,
} from "@/lib/domain/libreta-health-status";
import { VACCINE_LENS } from "@/lib/domain/provenance";
import { AR_TIME_ZONE } from "@/lib/utils/format";
import { useState } from "react";

type BadgeKey = "vigente" | "por-vencer" | "vencida" | "sin-confirmar";

/**
 * Pure badge-count derivation (exported for unit tests — staging validation
 * 2026-07-04, bug 3). "Por vencer" counts ONLY registered doses approaching
 * their next due date (`due_soon`); core vaccines that were NEVER administered
 * (`missing`) are NOT "por vencer" — they surface separately as "sin aplicar".
 * A pet with zero registered doses renders the empty state instead of counts.
 */
export function deriveVacunasBadgeCounts(summary: VaccinationSummary): {
  vigente: number;
  porVencer: number;
  vencida: number;
  sinAplicar: number;
  sinConfirmar: number;
  hasRecords: boolean;
} {
  return {
    vigente: summary.active,
    porVencer: summary.dueSoon,
    vencida: summary.expired,
    // `missing` only — `unconfirmed` is deliberately NOT counted here. A core
    // vaccine we cannot match, on an animal carrying a dose we cannot identify,
    // is not an animal we can tell its owner is unvaccinated (PO 2026-07-28).
    sinAplicar: summary.missing,
    sinConfirmar: summary.unconfirmed,
    hasRecords: hasAnyVaccineRecord(summary),
  };
}

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  // timeZone pinned — SSR (UTC) and hydration (browser) must agree on the
  // calendar day, otherwise a due date near midnight triggers React #418.
  return d.toLocaleDateString("es-AR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: AR_TIME_ZONE,
  });
}

/**
 * True when an "expired" item's due date is a catalog-interval ESTIMATE
 * (`dueSource: "derived"`) rather than a date the vet actually signed
 * (`dueSource: "payload"`). Mirrors pet-compliance's `dueSource === "rule"`
 * rule: an estimate never renders as the strong "Vencida" state, on either
 * surface — it renders as a suggestion, in warning tone, with the SAME copy
 * the compliance card uses ("Refuerzo sugerido vencido el dd/mm"). A dose the
 * vet signed keeps the strong "Venció dd/mm" state.
 */
export function isSuggestedLapse(v: VaccineSnapshot): boolean {
  return v.status === "expired" && v.dueSource === "derived" && v.nextDueAt !== null;
}

export function metaFor(v: VaccineSnapshot): string {
  switch (v.status) {
    case "missing":
      return "Nunca aplicada";
    case "unconfirmed":
      return "Sin confirmar — hay una dosis registrada que no pudimos identificar";
    case "active":
      return v.nextDueAt ? `Próxima ${fmtDate(v.nextDueAt)}` : "Al día";
    case "due_soon":
      return v.nextDueAt ? `Vence ${fmtDate(v.nextDueAt)}` : "Por vencer";
    case "expired":
      if (!v.nextDueAt) return "Vencida";
      return isSuggestedLapse(v)
        ? `Refuerzo sugerido vencido el ${fmtDate(v.nextDueAt)}`
        : `Venció ${fmtDate(v.nextDueAt)}`;
  }
}

export function VacunasStatusBadges({ summary }: { summary: VaccinationSummary }) {
  const [open, setOpen] = useState<BadgeKey | null>(null);
  const counts = deriveVacunasBadgeCounts(summary);

  const badges: Array<{
    key: BadgeKey;
    label: string;
    count: number;
    items: VaccineSnapshot[];
    bg: string;
    border: string;
    text: string;
  }> = [
    {
      key: "vigente",
      // "Vigente", not "Al día" — this panel classifies dose recency (VIGENTE /
      // POR VENCER / VENCIDA). "Al día" is the compliance panel's claim (which
      // also requires professional verification); using it here contradicted
      // that panel for an owner-declared dose (QA round 2 2026-07-03 finding A).
      label: "Vigente",
      count: counts.vigente,
      items: summary.perVaccine.filter((v) => v.status === "active"),
      bg: "var(--color-ln-ok-050)",
      border: "var(--color-ln-ok-100)",
      text: "var(--color-ln-ok)",
    },
    {
      key: "por-vencer",
      label: "Por vencer",
      // ONLY registered doses approaching next_due — never-administered core
      // vaccines are NOT "por vencer" (bug 3, staging validation 2026-07-04);
      // they surface in the "sin aplicar" note below instead.
      count: counts.porVencer,
      items: summary.perVaccine.filter((v) => v.status === "due_soon"),
      bg: "var(--color-ln-warn-025)",
      border: "var(--color-ln-warn-050)",
      text: "var(--color-ln-warn)",
    },
    (() => {
      const vencidaItems = summary.perVaccine.filter((v) => v.status === "expired");
      // Never the strong red state when EVERY expired vaccine in the bucket is
      // a catalog-interval ESTIMATE (no vet-signed date on any of them) — same
      // rule pet-compliance enforces for dueSource "rule". A single vet-signed
      // vencida in the mix keeps the bucket red; that is a real, established
      // vigencia and must not be softened by estimates sitting next to it.
      const allSuggested = vencidaItems.length > 0 && vencidaItems.every(isSuggestedLapse);
      return {
        key: "vencida" as const,
        label: "Vencida",
        count: counts.vencida,
        items: vencidaItems,
        bg: allSuggested ? "var(--color-ln-warn-025)" : "var(--color-ln-err-050)",
        border: allSuggested ? "var(--color-ln-warn-050)" : "var(--color-ln-err-100)",
        text: allSuggested ? "var(--color-ln-warn)" : "var(--color-ln-seal)",
      };
    })(),
    {
      // Neither a reassurance nor an alarm — an ASK. The animal has a dose on
      // file whose name the catalog could not resolve, so this core vaccine
      // can be neither confirmed nor denied. Neutral tone on purpose: telling
      // an owner "vencida" would be as wrong as telling them "vigente".
      key: "sin-confirmar",
      label: "Sin confirmar",
      count: counts.sinConfirmar,
      items: summary.perVaccine.filter((v) => v.status === "unconfirmed"),
      bg: "var(--color-ln-paper-2)",
      // Was --color-ln-rule, which is declared nowhere and therefore drew no
      // border at all. ln-line IS the warm hairline this wanted.
      border: "var(--color-ln-line)",
      text: "var(--color-ln-ink-2)",
    },
  ];

  const openBadge = badges.find((b) => b.key === open) ?? null;

  // Zero registered doses → honest empty state, never a fabricated count
  // (shared predicate with the public share view — hasAnyVaccineRecord).
  if (!counts.hasRecords) {
    return (
      <section aria-label="Estado de vacunación">
        <p
          className="mb-2 font-ln-mono text-xs uppercase tracking-[.06em] font-semibold"
          style={{ color: "var(--color-ln-mute)" }}
        >
          Estado de vacunación
        </p>
        <p className="text-sm" style={{ color: "var(--color-ln-mute)" }}>
          Sin vacunas registradas
          {counts.sinAplicar > 0 && (
            <span className="block text-xs mt-1">
              {counts.sinAplicar === 1
                ? "1 vacuna del calendario recomendado sin aplicar"
                : `${counts.sinAplicar} vacunas del calendario recomendado sin aplicar`}
            </span>
          )}
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Estado de vacunación">
      <p
        className="mb-2 font-ln-mono text-xs uppercase tracking-[.06em] font-semibold"
        style={{ color: "var(--color-ln-mute)" }}
      >
        Estado de vacunación
      </p>
      {/* Name the lens (task #78): this panel is the CURRENCY lens (vigencia de
          la dosis), NOT the compliance "al día" lens — copy shared from
          VACCINE_LENS so every vaccine surface disambiguates identically. */}
      <p className="mb-2 text-xs" style={{ color: "var(--color-ln-mute)" }}>
        {VACCINE_LENS.currency.note}
      </p>
      <div className="grid grid-cols-3 gap-2">
        {badges.map((b) => (
          <button
            key={b.key}
            type="button"
            className="ln-vac-badge"
            style={{ background: b.bg, borderColor: b.border, color: b.text }}
            aria-expanded={open === b.key}
            aria-controls="vacunas-drilldown"
            disabled={b.count === 0}
            onClick={() => setOpen(open === b.key ? null : b.key)}
          >
            <span className="ln-vac-badge-count">{b.count}</span>
            <span className="ln-vac-badge-label">
              {b.label}
              {b.count > 0 && (
                <span className="ln-vac-caret" aria-hidden>
                  ›
                </span>
              )}
            </span>
          </button>
        ))}
      </div>

      {/* Drill-down panel — one state at a time. Always present (stable
          aria-controls target); populated only when a state is expanded.
          MOT-4b (motion audit Gap 4): the caret rotated and the list
          teleported. Not `.op-disclosure` — this is a React-state drill-down,
          not a <details>, so the panel goes from NOT RENDERED to rendered and
          `@starting-style` is what applies. The 8px settle also gives it a
          direction, which a bare fade would not. */}
      <div id="vacunas-drilldown">
        {openBadge && openBadge.items.length > 0 && (
          <section
            className="op-panel-enter ln-vac-list"
            aria-label={`Vacunas: ${openBadge.label}`}
          >
            {openBadge.items.map((v) => (
              <div key={v.vaccineName} className="ln-vac-list-item">
                <span className="ln-vac-list-name">{v.vaccineName}</span>
                <span
                  className="ln-vac-list-meta"
                  // A suggested (estimate) lapse reads in warning tone even
                  // inside a bucket that also holds a vet-signed vencida —
                  // the per-item copy already says "Refuerzo sugerido"; the
                  // color must not contradict it by staying the same as a
                  // real vencida's.
                  style={isSuggestedLapse(v) ? { color: "var(--color-ln-warn)" } : undefined}
                >
                  {metaFor(v)}
                </span>
              </div>
            ))}
          </section>
        )}
      </div>

      {counts.sinAplicar > 0 && (
        <p className="mt-2 text-xs" style={{ color: "var(--color-ln-mute)" }}>
          {counts.sinAplicar === 1
            ? "1 vacuna del calendario recomendado sin aplicar"
            : `${counts.sinAplicar} vacunas del calendario recomendado sin aplicar`}
        </p>
      )}

      {/* "distintas" names the UNIT. otherCount is otherNames.size — DISTINCT
          off-catalog vaccine names — while the libreta's "Vacunas N" chip counts
          ASIENTOS. Kabosu showed "3 sin confirmar" here against a chip reading
          "Vacunas 6", and the two looked like a contradiction: six doses under
          three names, both counts correct, neither saying what it counted
          (master test CIU, B0). Same disease as L-1, one screen down. */}
      {summary.otherCount > 0 && (
        <p className="mt-2 text-xs" style={{ color: "var(--color-ln-mute)" }}>
          {summary.otherCount === 1
            ? "1 vacuna distinta registrada fuera del calendario"
            : `${summary.otherCount} vacunas distintas registradas fuera del calendario`}
        </p>
      )}
    </section>
  );
}
