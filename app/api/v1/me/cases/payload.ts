// `MyCasesV1` and `MyCaseDetailV1`, built from what the web's own loaders
// already decided.
//
// THIS FILE DECIDES NOTHING ABOUT ACCESS. The list comes from
// `fetchOpenWorkflows` / `fetchPreviousWorkflows`, the same two calls
// `/mis-mascotas` makes for its "Casos abiertos" and "Historial" blocks. The
// detail comes from `readCaseForViewer`, the same decision `/casos/{publicCode}`
// runs. What is left here is serialisation, plus the ONE translation the web
// does not need: a web path (`ctaUrl`, a pet link) resolved to the in-app route
// the phone can open, through the deep-link table — the same resolution the
// native inbox applies to a notification's CTA.
//
// THE DETAIL IS ALWAYS THE SIGNED-IN VIEW. `isPublic` is false by construction
// (the route requires a session and refuses a profile-less caller), so the
// anonymous redactions the web applies — pet name on bite cases, personal party
// names, notes, the complaint prose — never arise here. What a signed-in viewer
// does NOT get on the web, this does not carry either: the case map
// (govt/admin only), the operator actions and the org's rehome answer.

import { caseEntryLabel } from "@/components/casos/case-entry-label";
import { casePetLink } from "@/components/casos/case-pet-link";
import {
  type CaseParty,
  PARTY_ROLE_LABEL,
  caseJurisdictionLabel,
  nonPetSubjectDescription,
} from "@/components/ui/dashboard/CaseDetailShell";
import { CASE_STATUS_CONFIG } from "@/components/ui/dashboard/CaseStatusBadge";
import type { WorkflowItem } from "@/lib/analytics/owner-dashboard";
import { getNormativesForCase } from "@/lib/domain/case-normatives";
import { caseTimelineSummary } from "@/lib/events/events";
import { apiV1Envelope } from "@/lib/infra/api-v1";
import type { CaseReadOutcome } from "@/lib/infra/case-read";
import { petPhotoUrl } from "@/lib/infra/storage";
import { sexLabel, speciesLabel } from "@/lib/utils/format";
import { caseKindLabel } from "@/src/modules/cases/domain/case-kinds";
import { caseOpenedReasonDisplay } from "@/src/modules/cases/domain/opened-reason-display";
import {
  MY_CASES_HISTORY_LIMIT,
  MY_CASES_PAYLOAD_VERSION,
  MY_CASES_STALE_AFTER_MS,
  MY_CASE_DETAIL_PAYLOAD_VERSION,
  type MyCaseDetailV1,
  type MyCasePartyV1,
  type MyCaseRowV1,
  type MyCaseSubjectV1,
  type MyCasesV1,
} from "@dim/contract/api";
import { type DeepLinkName, appRoutePath, matchWebPath } from "@dim/contract/links";

/**
 * `appRoutePath`, called with a destination name known only at runtime — the
 * same widening `me/notifications/payload.ts` states: the params handed over are
 * exactly the ones the matched pattern produced.
 */
const resolveAppRoute = appRoutePath as (
  name: DeepLinkName,
  params: Record<string, string>,
) => string | null;

/**
 * A web path, as the in-app route that answers it, or `null` when the app has
 * no screen for it. `matchWebPath` refuses absolute urls by construction, so an
 * external link can never name one of our screens.
 */
export function appRouteForWebPath(webPath: string | null): string | null {
  if (webPath === null) return null;
  const destination = matchWebPath(webPath);
  if (destination === null) return null;
  return resolveAppRoute(destination.name, destination.params);
}

function toRowV1(item: WorkflowItem): MyCaseRowV1 {
  return {
    kind: item.kind,
    title: item.title,
    subtitle: item.subtitle ?? "",
    severity: item.severity,
    since: item.since.toISOString(),
    route: appRouteForWebPath(item.ctaUrl),
  };
}

export function buildMyCasesV1(input: {
  open: WorkflowItem[];
  /** Up to `MY_CASES_HISTORY_LIMIT + 1` rows; the extra one only proves `hasMore`. */
  previous: WorkflowItem[];
  now: Date;
}): MyCasesV1 {
  return {
    ...apiV1Envelope({
      payloadVersion: MY_CASES_PAYLOAD_VERSION,
      issuedAt: input.now,
      staleAfterMs: MY_CASES_STALE_AFTER_MS,
    }),
    open: input.open.map(toRowV1),
    history: {
      rows: input.previous.slice(0, MY_CASES_HISTORY_LIMIT).map(toRowV1),
      hasMore: input.previous.length > MY_CASES_HISTORY_LIMIT,
    },
  };
}

type Readable = Extract<CaseReadOutcome, { kind: "readable" }>;
type CaretakerOnly = Extract<CaseReadOutcome, { kind: "caretaker_only" }>;

/**
 * The parties list, in the web's order (`CaseDetailView`): opener, opening org,
 * the receiver org of a rehome_request, closer. Signed-in view, so personal
 * names ride exactly as the web shows them to this viewer.
 */
function partiesOf(detail: Readable["detail"]): MyCasePartyV1[] {
  const parties: CaseParty[] = [];
  if (detail.openedByUser) parties.push({ role: "opener", name: detail.openedByUser.displayName });
  if (detail.openedByOrganization) {
    parties.push({ role: "organization", name: detail.openedByOrganization.displayName });
  }
  if (detail.caseKind === "rehome_request" && detail.receiverOrganization) {
    parties.push({ role: "organization", name: detail.receiverOrganization.displayName });
  }
  if (detail.closedByUser) parties.push({ role: "closer", name: detail.closedByUser.displayName });
  return parties.map((p) => ({ role: p.role, roleLabel: PARTY_ROLE_LABEL[p.role], name: p.name }));
}

function subjectOf(read: Readable): MyCaseSubjectV1 {
  const { detail, viewer } = read;
  if (detail.pet) {
    return {
      kind: "pet",
      name: detail.pet.name,
      speciesLine: `${speciesLabel(detail.pet.species)} · ${sexLabel(detail.pet.sex)}`,
      photoUrl: detail.pet.primaryPhotoStoragePath
        ? petPhotoUrl(detail.pet.primaryPhotoStoragePath)
        : null,
      route: appRouteForWebPath(casePetLink(detail.pet.publicToken, viewer?.role ?? "owner")),
    };
  }
  const kind =
    detail.primarySubjectKind === "unowned_animal"
      ? "unowned_animal"
      : detail.primarySubjectKind === "location"
        ? "location"
        : "general";
  return {
    kind: "other",
    description: nonPetSubjectDescription({
      kind,
      locationLabel:
        kind === "location" && detail.jurisdictionLocality
          ? `${detail.jurisdictionLocality}, ${detail.jurisdictionProvince}`
          : undefined,
    }),
  };
}

export function buildMyCaseDetailV1(input: {
  read: Readable | CaretakerOnly;
  now: Date;
}): MyCaseDetailV1 {
  const envelope = apiV1Envelope({
    payloadVersion: MY_CASE_DETAIL_PAYLOAD_VERSION,
    issuedAt: input.now,
    staleAfterMs: MY_CASES_STALE_AFTER_MS,
  });

  const { read } = input;
  if (read.kind === "caretaker_only") {
    return {
      ...envelope,
      access: "caretaker_only",
      pet: read.pet
        ? {
            name: read.pet.name,
            route: appRouteForWebPath(casePetLink(read.pet.publicToken, "owner")),
          }
        : null,
    };
  }

  const { detail, timelineEvents } = read;
  return {
    ...envelope,
    access: "full",
    publicCode: detail.publicCode,
    kindLabel: caseKindLabel(detail.caseKind),
    status: detail.status,
    statusLabel: CASE_STATUS_CONFIG[detail.status].label,
    openedAt: detail.openedAt.toISOString(),
    closedAt: detail.closedAt === null ? null : detail.closedAt.toISOString(),
    // The web prints this section only when `openedReason` is set, and then
    // prints the structured display of it.
    openedReason: detail.openedReason
      ? caseOpenedReasonDisplay({
          openedReasonCode: detail.openedReasonCode,
          openedReasonParams: detail.openedReasonParams,
          openedReason: detail.openedReason,
        })
      : null,
    jurisdiction: caseJurisdictionLabel(detail.jurisdictionProvince, detail.jurisdictionLocality),
    subject: subjectOf(read),
    parties: partiesOf(detail),
    normatives: getNormativesForCase(detail.caseKind, {
      country: detail.jurisdictionCountry,
      province: detail.jurisdictionProvince ?? undefined,
      locality: detail.jurisdictionLocality ?? undefined,
    }).map((law) => ({ label: law.label, scope: law.scope, url: law.fullTextUrl ?? null })),
    timeline: timelineEvents.map((e) => {
      const summary = caseTimelineSummary(e.eventType, e.payload, {
        isPublic: false,
        discloseLastLocation: detail.pet?.discloseLastLocationWhenLost ?? false,
      });
      const text = [summary.primary, summary.secondary].filter(Boolean).join(" · ");
      return {
        label: caseEntryLabel(e.eventType, e.payload),
        occurredAt: e.occurredAt.toISOString(),
        summary: text === "" ? null : text,
        notes: e.notes,
      };
    }),
  };
}
