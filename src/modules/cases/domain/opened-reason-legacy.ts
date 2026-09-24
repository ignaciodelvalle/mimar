// opened-reason-legacy — FROZEN regex translation of pre-cutover case prose.
//
// ┌─ FROZEN 2026-07-16 — DO NOT ADD RULES ────────────────────────────────────┐
// │ This layer is CLOSED to new writers. It is not dead code and it is not a  │
// │ bridge to delete: it is the permanent render path for every case row      │
// │ written before the structured opened_reason_code cutover.                 │
// │                                                                           │
// │ New writers use the structured path instead:                              │
// │   src/modules/cases/domain/opened-reason.ts    (the closed union)         │
// │   src/modules/cases/domain/opened-reason-render.ts  (es-AR renderers)     │
// │                                                                           │
// │ The rule count below is PINNED at 16 by                                   │
// │ scripts/check-opened-reason-coverage.ts. If you are here to add a rule,   │
// │ you want a union member + a renderer, not a 17th regex.                   │
// └───────────────────────────────────────────────────────────────────────────┘
//
// WHY THIS LIVES FOREVER
// ----------------------
// `cases.opened_reason` is an append-only audit column. Pre-cutover rows carry
// prose and a NULL code, permanently — retro-translating them into a guessed
// structured code would be a retro-edit of audit data, which the append-only
// invariant forbids. So these regexes stay load-bearing for the lifetime of
// the column. Lint/coverage/cleanup tooling MUST NOT flag them as dead.
//
// ON THE `file.ts:NNN` CITATIONS BELOW
// ------------------------------------
// They name the writer that PRODUCED each grammar, as of the 2026-07-16
// cutover — and they are the last generation of them that can be trusted.
// Those writers no longer emit these strings from those lines; they name a
// code, and opened-reason-prose.ts renders the prose. Read the citations as
// provenance ("this shape came from there"), not as a live cross-reference.
//
// The drift was already here before the freeze: the intake rule cited
// create-intake.ts:426 while the writer sat at :439. A regex table keeping its
// own map of 16 other files up to date by hand is exactly the coupling the
// structured path removes — this file only had to be right about the past, and
// it was not even that.
//
// Contract (unchanged from the pre-freeze module):
//   - Recognized machine grammars render as natural es-AR.
//   - Internal UUIDs (volunteer/org/pet ids) are NEVER displayed.
//   - Unrecognized strings (genuine free text, e.g. manual reasons typed by
//     people) pass through unchanged.
//   - Never throws; unknown input degrades to the raw string.

import { pluralizeEs } from "@/lib/utils/format";

import {
  BITE_SEVERITY_LABEL,
  BITE_VICTIM_LABEL,
  CHIP_REASON_LABEL,
  CUSTODY_HANDOFF_ROLE_LABEL,
  INTAKE_REASON_LABEL,
  REPORTER_ROLE_LABEL,
  SEIZURE_MOTIVE_LABEL,
  TRANSFER_REASON_LABEL,
  WELFARE_KIND_LABEL,
  WELFARE_SEVERITY_LABEL,
  label,
} from "./opened-reason-labels";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Number of frozen writer grammars. PINNED — asserted by
 * scripts/check-opened-reason-coverage.ts. This number never grows.
 */
export const LEGACY_RULE_COUNT = 16;

// ---------------------------------------------------------------------------
// Writer grammars — one rule per known production openedReason template.
// ---------------------------------------------------------------------------

type Rule = {
  pattern: RegExp;
  render: (m: RegExpExecArray) => string;
};

const RULES: Rule[] = [
  {
    // adoption-repository.ts:292
    pattern: /^auto: adoption listing opened — pet marked eligible for adoption$/,
    render: () =>
      "Publicación en adopción abierta automáticamente: la mascota fue marcada como apta para adopción",
  },
  {
    // adoption-repository.ts:560
    pattern: /^auto: adoption application submitted$/,
    render: () => "Postulación de adopción enviada",
  },
  {
    // welfare/application/create-welfare-report.ts:197
    pattern: /^Welfare denuncia (\S+) — kind=(\S+), severity=(\S+)$/,
    render: (m) =>
      `Denuncia de bienestar ${m[1]} — tipo: ${label(WELFARE_KIND_LABEL, m[2])}, gravedad: ${label(WELFARE_SEVERITY_LABEL, m[3])}`,
  },
  {
    // welfare/application/create-org-welfare-report.ts:199
    pattern: /^auto: org-side welfare report by (.+) \(([^)]+)\)$/,
    render: (m) => `Denuncia de bienestar registrada por ${m[1]} (${m[2]})`,
  },
  {
    // foster/infrastructure/foster-repository.ts:757
    pattern: /^Foster placement assigned by (.+?)(?: — expected (\d+) weeks)?$/,
    render: (m) =>
      `Tránsito asignado por ${m[1]}${m[2] ? ` — duración estimada: ${m[2]} ${pluralizeEs(Number(m[2]), "semana")}` : ""}`,
  },
  {
    // foster/infrastructure/foster-repository.ts:881 — the volunteer userId
    // and orgId are internal UUIDs: strip them, never display.
    pattern: /^Foster proposal to volunteer \S+ by org \S+$/,
    render: () => "Propuesta de tránsito enviada a una persona voluntaria",
  },
  {
    // events/application/lifecycle/set-pet-lost-use-case.ts:190 — the id is
    // the public token when available, otherwise the internal pet UUID
    // (never display the UUID). The trailing reason is owner free text.
    pattern: /^Pet (\S+) marked as lost by owner(?: — ([\s\S]+))?$/,
    render: (m) => {
      const token = UUID_RE.test(m[1]) ? null : m[1];
      const head = token
        ? `Mascota ${token} reportada como perdida por su dueño`
        : "Mascota reportada como perdida por su dueño";
      return m[2] ? `${head} — ${m[2]}` : head;
    },
  },
  {
    // decomiso/application/execute-decomiso.ts:204
    pattern: /^auto: decomiso motivo=(\S+) judicial_ref=([\s\S]+)$/,
    render: (m) =>
      `Decomiso — motivo: ${label(SEIZURE_MOTIVE_LABEL, m[1])}${
        m[2] === "sin_ref" ? "" : ` — ref. judicial: ${m[2]}`
      }`,
  },
  {
    // decomiso/application/accept-decomiso-handoff.ts:253
    pattern: /^auto: decomiso handoff aceptado desde caso (\S+)$/,
    render: (m) => `Traspaso de decomiso aceptado desde el caso ${m[1]}`,
  },
  {
    // surveillance/application/report-bite.ts:112
    pattern: /^Bite incident reported by owner — victim=(\S+), severity=(\S+)$/,
    render: (m) =>
      `Mordedura reportada por el dueño — víctima: ${label(BITE_VICTIM_LABEL, m[1])}, gravedad: ${label(BITE_SEVERITY_LABEL, m[2])}`,
  },
  {
    // surveillance/application/report-bite-from-org.ts:137
    pattern: /^Bite incident reported by (.+) \(([^)]+)\) — victim=(\S+), severity=(\S+)$/,
    render: (m) =>
      `Mordedura reportada por ${m[1]} (${label(REPORTER_ROLE_LABEL, m[2])}) — víctima: ${label(BITE_VICTIM_LABEL, m[3])}, gravedad: ${label(BITE_SEVERITY_LABEL, m[4])}`,
  },
  {
    // transfers/application/transfer-custody.ts:155.
    //
    // This writer had NO rule until 2026-07-16, so a direct custody handoff —
    // the change of legal responsible, the most consequential write in the
    // system — fell through to the generic `auto:` branch and rendered as
    // "Apertura automática — direct custody handoff to_role=owner": English
    // plus a raw enum, dressed in a Spanish prefix so it read like a
    // translation and nobody noticed.
    pattern: /^auto: direct custody handoff to_role=(\S+)$/,
    render: (m) =>
      `Traspaso directo de custodia — pasa a: ${label(CUSTODY_HANDOFF_ROLE_LABEL, m[1])}`,
  },
  {
    // transfers/application/propose-cross-org-transfer.ts:137
    pattern: /^auto: cross-org transfer proposed reason=(\S+)$/,
    render: (m) =>
      `Transferencia entre organizaciones propuesta — motivo: ${label(TRANSFER_REASON_LABEL, m[1])}`,
  },
  {
    // pets/application/intake/create-intake.ts (was cited as :426; the writer
    // was actually at :439 — see the header note on stale citations)
    pattern: /^auto: org intake reason=(\S+)$/,
    render: (m) =>
      `Ingreso registrado por la organización — motivo: ${label(INTAKE_REASON_LABEL, m[1])}`,
  },
  {
    // pets/application/microchip/replace-microchip.ts:212 — secondaryPetId
    // is an internal UUID: strip it, keep the fact it existed.
    pattern: /^auto: microchip_replaced reason=(\S+)( secondaryPetId=\S+)?$/,
    render: (m) =>
      `Reemplazo de microchip — motivo: ${label(CHIP_REASON_LABEL, m[1])}${
        m[2] ? " — se detectó otra mascota con el mismo chip" : ""
      }`,
  },
  {
    // pets/application/claim/submit-claim-dispute.ts:105
    pattern: /^Custody dispute raised on pet — raised_by_role=(\S+)$/,
    render: (m) =>
      m[1] === "owner"
        ? "Disputa de custodia iniciada por el dueño sobre la mascota"
        : `Disputa de custodia iniciada sobre la mascota (rol: ${m[1]})`,
  },
];

/**
 * Render `cases.opened_reason` as natural es-AR.
 *
 * Recognizes the machine grammars produced by the production case writers
 * and translates them; genuine free text (manual reasons typed by people)
 * passes through unchanged. Never throws.
 */
export function openedReasonDisplay(reason: string | null): string {
  if (!reason) return "Sin motivo registrado";
  const text = reason.trim();
  if (!text) return "Sin motivo registrado";

  try {
    for (const rule of RULES) {
      const m = rule.pattern.exec(text);
      if (m) return rule.render(m);
    }

    // surveillance/application/outbreak-investigation.ts:169 — the
    // `manual [code]:` prefix is a dedupe contract; the tail is free text.
    const manual = /^manual \[([^\]]+)\]:\s*([\s\S]*)$/.exec(text);
    if (manual) {
      return manual[2]
        ? `Apertura manual [${manual[1]}] — ${manual[2]}`
        : `Apertura manual [${manual[1]}]`;
    }

    // Generic `auto:` prefix (unknown auto-open writers, seeds, fixtures).
    const auto = /^auto:\s*([\s\S]*)$/.exec(text);
    if (auto) {
      return auto[1] ? `Apertura automática — ${auto[1]}` : "Apertura automática";
    }
  } catch {
    // Fall through to raw passthrough — display must never throw.
  }

  return text;
}
