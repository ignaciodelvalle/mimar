// Tier 2 medical view — owner-opt-in widened public projection.
//
// Template face: two paper tiles (vacunación / esterilización) carry the
// semaphore in the wash, a translucent icon, and the passport-paper fiber.
// Extra blocks (medicación, condiciones) stay as quieter paper slips.
//
// Privacy boundary: NEVER owner contact, address, DNI, or free-text notes.
// AGGREGATE ONLY: active vaccine count + sterilized yes/no.

import { Icon } from "@/components/Icon";
import {
  PERMANENT_CONDITIONS,
  type PermanentCondition,
  permanentConditionLabel,
} from "@/lib/reference/permanent-conditions";
import { AR_TIME_ZONE, pluralizeEs, sterilizedLabel } from "@/lib/utils/format";

interface Props {
  /** When the bounded window closes. Null when permanent ("siempre" option). */
  enabledUntil: Date | null;
  /** Per-vaccine snapshot — aggregate counts only (active, expired, dueSoon, missing). */
  vaccineSummary: {
    active: number;
    expired: number;
    dueSoon: number;
    missing: number;
    /**
     * The subset of `active` nobody professional signed. Counted as
     * "declarada", never "vigente" — the credential front and the owner's
     * libreta say the same of the same dose (QA v14 P2a). Optional: absent
     * reads as 0.
     */
    declared?: number;
  };
  /**
   * True when the pet has at least one REGISTERED dose (hasAnyVaccineRecord,
   * lib/domain/libreta-health-status). False renders the "Sin vacunas
   * registradas" empty state — the same predicate the owner libreta uses, so
   * the two surfaces can never disagree (staging validation 2026-07-04, bug 3).
   */
  hasVaccineRecords: boolean;
  /** Pet has at least one sterilization_performed event. */
  isSterilized: boolean;
  /** Pet sex — the sterilization line agrees in gender rather than saying "Castrado/a". */
  sex: string;
  /** Names of currently-active medications (started without a stop). */
  activeMedications: string[];
  /** From pet.permanent_conditions — already on the row, no extra query. */
  permanentConditions: readonly string[];
  /** Free-text "otra" condition supplied by the owner, if any. */
  permanentConditionsOther: string | null;
}

export function Tier2MedicalView({
  enabledUntil,
  vaccineSummary,
  hasVaccineRecords,
  isSterilized,
  sex,
  activeMedications,
  permanentConditions,
  permanentConditionsOther,
}: Props) {
  const knownConditions = new Set<string>(PERMANENT_CONDITIONS);
  const conditionLabels = permanentConditions.map((c) => {
    if (c === "otra" && permanentConditionsOther) return permanentConditionsOther;
    if (knownConditions.has(c)) return permanentConditionLabel(c as PermanentCondition);
    return c;
  });

  const untilLabel = enabledUntil
    ? enabledUntil.toLocaleString("es-AR", {
        weekday: "short",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: AR_TIME_ZONE,
      })
    : null;

  const declared = vaccineSummary.declared ?? 0;
  const vigente = Math.max(0, vaccineSummary.active - declared);

  const vaccineTone: "ok" | "warn" | "danger" | "neutral" = !hasVaccineRecords
    ? "neutral"
    : vaccineSummary.expired > 0
      ? "danger"
      : vaccineSummary.dueSoon > 0 || vaccineSummary.missing > 0
        ? "warn"
        : vigente > 0
          ? "ok"
          : "neutral";

  const vaccineValue = !hasVaccineRecords
    ? "—"
    : String(
        vigente ||
          declared ||
          vaccineSummary.expired ||
          vaccineSummary.dueSoon ||
          vaccineSummary.missing,
      );

  const vaccineSubLabel = !hasVaccineRecords
    ? "Sin vacunas registradas"
    : vaccineSummary.expired > 0
      ? `${vaccineSummary.expired} ${pluralizeEs(vaccineSummary.expired, "vencida")}`
      : vaccineSummary.dueSoon > 0
        ? `${vaccineSummary.dueSoon} por vencer`
        : vaccineSummary.missing > 0
          ? `${vaccineSummary.missing} ${pluralizeEs(vaccineSummary.missing, "faltante")}`
          : [
              vigente > 0 ? `${vigente} ${pluralizeEs(vigente, "vigente")}` : null,
              declared > 0 ? `${declared} ${pluralizeEs(declared, "declarada")}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || `0 ${pluralizeEs(0, "vigente")}`;

  return (
    <section aria-labelledby="tier2-h" className="pc-facts">
      <h2 id="tier2-h" className="sr-only">
        Resumen médico
      </h2>
      {/* The owner's consent, said in VISIBLE text — the "Nivel 2" chip's
          tooltip is not reachable on touch and not read by every screen
          reader. Main's wording: "habilitada por el dueño" + the window. */}
      <p className="pc-facts-until" data-section="tier2-consent">
        Habilitada por el dueño ·{" "}
        {untilLabel ? (
          <>
            Visible hasta el <strong>{untilLabel}</strong>.
          </>
        ) : (
          <strong>Siempre visible</strong>
        )}
      </p>

      <div className="pc-fact-grid">
        <MedStat
          icon="vacuna"
          label="Vacunación"
          value={vaccineValue}
          sub={vaccineSubLabel}
          tone={vaccineTone}
        />
        <MedStat
          icon="esterilizacion"
          label="Esterilización"
          value={isSterilized ? "Sí" : "No"}
          sub={isSterilized ? sterilizedLabel(sex) : "No registrada"}
          tone={isSterilized ? "ok" : "neutral"}
        />
      </div>

      {activeMedications.length > 0 && (
        <MedBlock label="Medicación activa">
          {/* role="list" is NOT redundant here: WebKit/VoiceOver drops the
              list semantics of a <ul> styled `list-style: none`, so the count
              ("lista, 3 elementos") vanishes for exactly the reader who needs
              to know how many drugs the animal is on (native review C-3). */}
          {/* biome-ignore lint/a11y/noRedundantRoles: restores list semantics WebKit drops under list-style: none */}
          {/* biome-ignore lint/a11y/useSemanticElements: it IS the semantic element; the role only re-asserts it for WebKit */}
          <ul role="list" className="pc-med-list">
            {activeMedications.map((drug) => (
              <li key={drug}>
                <span aria-hidden="true">•</span>
                {drug}
              </li>
            ))}
          </ul>
        </MedBlock>
      )}

      {conditionLabels.length > 0 && (
        <MedBlock label="Condiciones permanentes">
          <p className="pc-med-copy">{conditionLabels.join(" · ")}</p>
        </MedBlock>
      )}
    </section>
  );
}

function MedStat({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: "vacuna" | "esterilizacion";
  label: string;
  value: string;
  sub: string;
  tone: "ok" | "warn" | "danger" | "neutral";
}) {
  // One <dl> per tile: a <dl> may hold only dt/dd (or div wrappers of them),
  // and the tile also carries the decorative watermark — axe flagged the old
  // `dl > div > span + dt + dd + p` as a serious definition-list violation
  // (browser QA 2026-10-06). The sub line is a second <dd> of the same term.
  return (
    <div className="pc-fact" data-tone={tone}>
      <span className="pc-fact-mark" aria-hidden="true">
        <Icon name={icon} size="lg" decorative />
      </span>
      <dl>
        <dt>{label}</dt>
        <dd>{value}</dd>
        <dd className="pc-fact-sub">{sub}</dd>
      </dl>
    </div>
  );
}

function MedBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pc-slip">
      <p className="pc-slip-label">{label}</p>
      {children}
    </div>
  );
}
