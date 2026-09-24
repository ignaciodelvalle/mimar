// Pure URL builder backing the notification quick-reply island
// (components/NotificationQuickReply.tsx). Extracted from the component so
// vitest can exercise it without jsdom/React — same rationale as
// app/(app)/mis-mascotas/[publicToken]/anotar/handoff.ts.
//
// The quick-reply flow resolves free text through the SAME matcher +
// registry the /anotar capture box uses (matchToCaptureUrl), then layers two
// notification-specific params on top of whatever URL that resolves to:
//
//   - `reminderId` — the notification's relatedReminderId, so the target
//     form can close the reminder on submit (vaccine form) the same way a
//     direct reminder-CTA click already does (lib/ui/reminder-urls.ts).
//     Harmless on targets that don't read it (e.g. the checkin page reads
//     the pet's open reminder from the DB, not the query string).
//   - `autoconfirm=1` — set ONLY when the owner tapped "Confirmar" on the
//     CaptureConfidenceCard preview. The target form (VaccinationForm,
//     CheckinForm) reads this flag and calls requestSubmit() itself ONCE,
//     but only if its own required-field validation passes — see each
//     form's autoConfirm effect. "Editar en el formulario" reuses this same
//     builder with autoconfirm=false, landing the owner on the prefilled
//     form instead of committing.

import { type MatchResult, matchToCaptureUrl } from "@/lib/events/event-capture-matcher";
import { buildCaptureDeeplink } from "@/lib/events/event-capture-registry";

export function buildQuickReplyUrl(
  petPublicToken: string,
  match: MatchResult,
  reminderId: string | null,
  autoconfirm: boolean,
): string | null {
  const base = matchToCaptureUrl(petPublicToken, match, buildCaptureDeeplink);
  if (!base) return null;

  const params = new URLSearchParams();
  if (reminderId) params.set("reminderId", reminderId);
  if (autoconfirm) params.set("autoconfirm", "1");
  const qs = params.toString();
  if (!qs) return base;

  return `${base}${base.includes("?") ? "&" : "?"}${qs}`;
}
