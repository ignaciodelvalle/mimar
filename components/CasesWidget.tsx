import { Icon } from "@/components/Icon";
import { LnListRow } from "@/components/ui/ListRow";
import { LnPetPhoto } from "@/components/ui/RegRow";
import type { WorkflowItem, WorkflowKind } from "@/lib/analytics/owner-dashboard";
import { AR_TIME_ZONE, calendarDaysAgoInAr, formatDateShort } from "@/lib/utils/format";
import { type CasePetCluster, clusterCaseRowsByPet, splitOpenCaseRows } from "@dim/contract/api";

// CasesWidget — the owner's casos in the /mis-mascotas Bandeja, grouped by whose
// turn it is (PO decision 2026-10-06):
//
//   · "Te toca a vos" — the rows that wait on the owner (`needsAction`), the
//     earliest deadline first, then the newest;
//   · "En curso" — the rows that wait on somebody else, newest first;
//   · "Historial" — closed rows, collapsed behind a native <details>.
//
// Inside each group one pet's rows gather under the pet, with a count, once
// there are two or more; a single row carries the pet's photo and name inline.
// The ordering and the clustering are the contract's (`splitOpenCaseRows`,
// `clusterCaseRowsByPet`), the same two calls the app's casos make, so the two
// surfaces cannot group the same rows two ways. The per-pet
// `PetOpenCasesSection` on a pet's own page is a different block and stays as
// it is.

export type CaseRow = {
  /** Unique key for React. */
  id: string;
  /** First line — what happened, with the pet's name. */
  title: string;
  /** Second line — case ref + status. */
  subtitle: string;
  /** Where this row goes on click. Usually `/casos/{publicCode}` or `/mis-mascotas/{token}`. */
  ctaUrl: string;
  /** Open/decision date. Drives "hace X días". */
  since: Date;
  /** Visual tone. */
  severity: "info" | "warning" | "danger" | "success";
  /** Optional case-kind icon (emoji in v1; Icon webfont pending). */
  icon?: string;
  /** The owner's turn — decided server-side from the kind. */
  needsAction: boolean;
  /** Deadline for the owner's answer, or `null`. */
  dueAt: Date | null;
  /** The pet's public token — the clustering key — or `null` for an account-level row. */
  petId: string | null;
  petName: string | null;
  petPhotoUrl: string | null;
};

/** Case-kind → icon name for the Icon component. */
export const WORKFLOW_KIND_ICON: Record<WorkflowKind, string> = {
  pet_lost: "perdida",
  welfare_report_open: "denuncia",
  welfare_report_closed: "denuncia",
  adoption_application_pending: "solicitud",
  adoption_application_resolved: "solicitud",
  foster_proposal_pending: "casa",
  foster_proposal_resolved: "casa",
  custody_transfer_pending: "trato",
  custody_dispute_open: "disputa",
  approval_request_pending: "custodia",
  approval_request_decided: "custodia",
  bite_observation_open: "mordedura",
  dangerous_breed_pending_attestation: "alerta",
  case_generic_open: "nota",
};

/** Adapt a WorkflowItem (lib/owner-dashboard) to a CaseRow for rendering. */
export function adaptWorkflow(w: WorkflowItem): CaseRow {
  return {
    id: w.id,
    title: w.title,
    subtitle: w.subtitle ?? "",
    ctaUrl: w.ctaUrl,
    since: w.since,
    severity: w.severity === "urgent" ? "danger" : w.severity,
    icon: WORKFLOW_KIND_ICON[w.kind],
    needsAction: w.needsAction,
    dueAt: w.dueAt,
    petId: w.pet?.publicToken ?? null,
    petName: w.pet?.name ?? null,
    petPhotoUrl: w.pet?.photoUrl ?? null,
  };
}

export function CasesWidget({
  open,
  history = [],
  title = "Mis casos",
}: {
  /** Every open cycle — split here into "Te toca a vos" and "En curso". */
  open: CaseRow[];
  /** Closed cycles, newest first — drawn collapsed. */
  history?: CaseRow[];
  /** Section heading. */
  title?: string;
}) {
  const { yourTurn, inProgress } = splitOpenCaseRows(open);
  const total = open.length;

  return (
    <section aria-label={title} className="rounded-2xl border border-ln-line bg-ln-card p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-ln-ink">
          {title}
          {total > 0 && (
            <span className="ml-2 text-xs font-normal text-ln-mute">
              · {total} {total === 1 ? "abierto" : "abiertos"}
            </span>
          )}
        </h2>
      </div>

      {total === 0 ? (
        <p className="rounded-xl border border-dashed border-ln-line-strong p-6 text-center text-sm text-ln-mute">
          No tenés casos abiertos. Cualquier denuncia, postulación o pérdida que empieces va a
          aparecer acá.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          <CaseGroup
            id="casos-te-toca"
            title="Te toca a vos"
            hint="Necesitan una respuesta o un paso tuyo."
            rows={yourTurn}
            emptyText="Nada pendiente de tu parte por ahora."
          />
          {inProgress.length > 0 && (
            <CaseGroup
              id="casos-en-curso"
              title="En curso"
              // Neutral on purpose: this group holds rows waiting on a refugio
              // or the authority AND procedures that simply run their course
              // (a bite observation), so it cannot say who is being waited on.
              hint="Siguen su curso; te avisamos si hace falta algo tuyo."
              rows={inProgress}
            />
          )}
        </div>
      )}

      {history.length > 0 && (
        <details className="mt-5 border-t border-ln-line pt-4">
          <summary className="cursor-pointer text-sm font-semibold text-ln-ink">
            Historial
            <span className="ml-2 text-xs font-normal text-ln-mute">
              · {history.length} {history.length === 1 ? "cerrado" : "cerrados"}
            </span>
          </summary>
          <div className="mt-3">
            <CaseClusterList rows={history} />
          </div>
        </details>
      )}
    </section>
  );
}

function CaseGroup({
  id,
  title,
  hint,
  rows,
  emptyText,
}: {
  /** The heading's id — the section is labelled by its own <h3>. One widget per page. */
  id: string;
  title: string;
  hint: string;
  rows: CaseRow[];
  emptyText?: string;
}) {
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="text-sm font-semibold text-ln-ink">
        {title}
        {rows.length > 0 && (
          <span className="ml-2 text-xs font-normal text-ln-mute">· {rows.length}</span>
        )}
      </h3>
      <p className="mt-0.5 text-xs text-ln-mute">{rows.length > 0 ? hint : emptyText}</p>
      {rows.length > 0 && (
        <div className="mt-2">
          <CaseClusterList rows={rows} />
        </div>
      )}
    </section>
  );
}

function CaseClusterList({ rows }: { rows: CaseRow[] }) {
  const clusters = clusterCaseRowsByPet(rows);
  return (
    <ul className="divide-y divide-ln-line">
      {clusters.map((cluster) => {
        const [only] = cluster.rows;
        if (cluster.rows.length === 1 && only) {
          return (
            <li key={only.id}>
              <CaseLine row={only} showPet />
            </li>
          );
        }
        return (
          <li key={`pet:${cluster.petId}`}>
            <PetCluster cluster={cluster} />
          </li>
        );
      })}
    </ul>
  );
}

/** Two or more rows about one pet: the pet once, with a count, and its rows under it. */
function PetCluster({ cluster }: { cluster: CasePetCluster<CaseRow> }) {
  return (
    <div className="py-3">
      <div className="flex items-center gap-2">
        <LnPetPhoto src={cluster.petPhotoUrl ?? undefined} alt="" size={28} />
        {/* A real heading: a screen-reader user can jump between the pets. */}
        <h4 className="truncate text-sm font-semibold text-ln-ink">
          {cluster.petName}
          <span className="ml-2 text-xs font-normal text-ln-mute">
            · {cluster.rows.length} casos
          </span>
        </h4>
      </div>
      <ul className="ml-3.5 mt-1 border-l border-ln-line pl-3">
        {cluster.rows.map((row) => (
          <li key={row.id}>
            <CaseLine row={row} showPet={false} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CaseLine({ row, showPet }: { row: CaseRow; showPet: boolean }) {
  return (
    <LnListRow
      href={row.ctaUrl}
      className="py-3 transition-colors hover:bg-ln-stripe"
      icon={<CaseIcon severity={row.severity} icon={row.icon} />}
      trailing={
        <p
          className="shrink-0 text-sm text-ln-mute"
          title={row.since.toLocaleString("es-AR", { timeZone: AR_TIME_ZONE })}
        >
          {relativeShort(row.since)}
        </p>
      }
    >
      <p className="truncate text-sm font-medium text-ln-ink">{row.title}</p>
      {row.subtitle !== "" && (
        <p className="mt-0.5 truncate text-xs text-ln-mute">{row.subtitle}</p>
      )}
      {row.dueAt && (
        <p className="mt-0.5 text-xs font-medium text-ln-warn">
          Vence el {formatDateShort(row.dueAt)}
        </p>
      )}
      {showPet && row.petName && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-ln-mute">
          <LnPetPhoto src={row.petPhotoUrl ?? undefined} alt="" size={20} />
          <span className="truncate">{row.petName}</span>
        </div>
      )}
    </LnListRow>
  );
}

function CaseIcon({
  severity,
  icon,
}: {
  severity: CaseRow["severity"];
  icon?: string;
}) {
  const tone =
    severity === "danger"
      ? "bg-[var(--color-ln-err-050)] text-ln-err"
      : severity === "warning"
        ? "bg-[var(--color-ln-warn-050)] text-ln-warn"
        : severity === "success"
          ? "bg-[var(--color-ln-ok-050)] text-ln-ok"
          : "bg-ln-celeste/10 text-ln-azul";
  return (
    <span
      className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${tone}`}
      aria-hidden
    >
      {icon ? <Icon name={icon} size={18} decorative /> : <Icon name="nota" size={18} decorative />}
    </span>
  );
}

function relativeShort(d: Date): string {
  // AR-calendar days, not elapsed-ms floor: 20:00 yesterday viewed at 10:00
  // today must read "ayer", not "hoy" (calendarDaysAgoInAr rationale).
  const days = calendarDaysAgoInAr(d);
  if (days < 1) return "hoy";
  if (days === 1) return "ayer";
  if (days < 30) return `hace ${days} d.`;
  if (days < 365) {
    const m = Math.floor(days / 30);
    return `hace ${m} m.`;
  }
  const y = Math.floor(days / 365);
  return `hace ${y} a.`;
}
