import type { TimelineEvent } from "@/lib/analytics/govt-dashboards";
import { formatDateTime } from "@/lib/utils/format";

// Dot color per event kind — maps to a Tailwind background class using ln-op-* tokens.
const KIND_DOT: Record<string, string> = {
  created: "bg-ln-op-line",
  triaged: "bg-ln-op-azul",
  assigned: "bg-ln-op-azul",
  in_progress: "bg-ln-op-viol",
  closed: "bg-ln-op-ok",
  invalid: "bg-ln-op-line",
  duplicate: "bg-ln-op-line",
  pet_event: "bg-ln-op-celeste",
  reporter_comment: "bg-ln-op-mute",
  org_intervention_taken: "bg-ln-op-viol",
  org_intervention_note: "bg-ln-op-viol",
  org_intervention_return: "bg-ln-op-warn",
};

function kindDot(kind: string): string {
  return KIND_DOT[kind] ?? "bg-ln-op-line";
}

type TimelineProps = {
  events: TimelineEvent[];
};

export function Timeline({ events }: TimelineProps) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-ln-op-mute py-2">
        No hay eventos en la línea de tiempo de esta denuncia.
      </p>
    );
  }

  return (
    <ol className="relative border-l border-ln-op-line space-y-6 pl-6">
      {events.map((event) => (
        <li key={event.id} className="relative">
          {/* Timeline dot */}
          <span
            className={`absolute -left-[1.65rem] top-1 w-3 h-3 rounded-full border-2 border-ln-op-card ${kindDot(event.kind)}`}
            aria-hidden="true"
          />
          <div className="space-y-0.5">
            <p className="text-xs text-ln-op-mute tabular-nums font-ln-mono">
              {formatDateTime(event.occurredAt)}
              {event.actorName && (
                <span className="ml-1 text-ln-op-faint">· {event.actorName}</span>
              )}
            </p>
            <p className="text-md text-ln-op-ink leading-[1.5]">{event.summary}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
