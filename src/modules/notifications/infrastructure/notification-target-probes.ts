// The DB-backed answers `resolveNotificationTarget` asks for, and the one door
// both front ends call: `resolveOwnNotificationTarget`.
//
// EVERY ACCESS ANSWER IS THE DESTINATION PAGE'S OWN FUNCTION. `canReadCase` is
// what `/casos/{code}` (and `/api/v1/me/cases/{code}`) runs; `resolvePetHolderAccess`
// is what `/mis-mascotas/{token}` (and `/api/v1/pets/{token}`) runs;
// `getFormerOwnerReadAccess` is the web's read-only custody view. A resolver with
// its own copy of any of them would be a second authorization path that agrees
// on the day it is written and sends somebody to a 404 the first time one of the
// two changes — the exact defect this change exists to remove.

import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";

import {
  cases,
  db,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  pets,
} from "@/db";
import { type CaseViewer, canReadCase, isActiveOrgMember } from "@/lib/infra/case-access";
import { type CaseDetail, getCaseDetailByPublicCode } from "@/lib/infra/case-queries";
import { getFormerOwnerReadAccess, resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { isUuid } from "@/lib/utils/uuid";

import {
  type CaseFacts,
  type NotificationTargetProbes,
  type NotificationTargetRow,
  type ResolvedNotificationTarget,
  resolveNotificationTarget,
} from "../application/read/resolve-notification-target";

function factsOf(detail: CaseDetail): CaseFacts {
  return {
    publicCode: detail.publicCode,
    caseKind: detail.caseKind,
    status: detail.status,
    closedReason: detail.closedReason,
    jurisdictionLocality: detail.jurisdictionLocality,
    petId: detail.pet?.id ?? null,
    petName: detail.pet?.name ?? null,
    openedByOrganization: detail.openedByOrganization
      ? {
          id: detail.openedByOrganization.id,
          displayName: detail.openedByOrganization.displayName,
        }
      : null,
    receiverOrganization: detail.receiverOrganization
      ? {
          id: detail.receiverOrganization.id,
          displayName: detail.receiverOrganization.displayName,
        }
      : null,
  };
}

/**
 * The probes for one viewer. Case details are memoised per resolution: the
 * resolver asks `findCase` and then `canReadCase` about the same case, and the
 * detail read is the widest query here.
 */
export function notificationTargetProbes(viewer: CaseViewer): NotificationTargetProbes {
  const details = new Map<string, CaseDetail | null>();
  const detailByCode = async (publicCode: string): Promise<CaseDetail | null> => {
    if (!details.has(publicCode))
      details.set(publicCode, await getCaseDetailByPublicCode(publicCode));
    return details.get(publicCode) ?? null;
  };

  return {
    async findCase({ caseId, publicCode }) {
      let code = publicCode;
      if (code === null && caseId !== null) {
        const [row] = await db
          .select({ publicCode: cases.publicCode })
          .from(cases)
          .where(eq(cases.id, caseId))
          .limit(1);
        code = row?.publicCode ?? null;
      }
      if (code === null) return null;
      const detail = await detailByCode(code);
      return detail ? factsOf(detail) : null;
    },

    async canReadCase(publicCode) {
      const detail = await detailByCode(publicCode);
      if (!detail) return false;
      return canReadCase(detail, viewer);
    },

    async findPet({ petId, publicToken }) {
      // The stored CTA's token wins over `related_pet_id`: it is what the
      // writer showed the person, and the two name the same animal anyway.
      let where: ReturnType<typeof eq>;
      if (publicToken !== null) where = eq(pets.publicToken, publicToken);
      else if (petId !== null) where = eq(pets.id, petId);
      else return null;
      const [row] = await db
        .select({ id: pets.id, publicToken: pets.publicToken, name: pets.name })
        .from(pets)
        .where(and(where, isNull(pets.deletedAt)))
        .limit(1);
      return row ?? null;
    },

    async holdsPet(publicToken) {
      return (await resolvePetHolderAccess(publicToken, viewer.userId)).kind !== "none";
    },

    async formerOwnerRead(publicToken) {
      return (await getFormerOwnerReadAccess(publicToken, viewer.userId)).ok;
    },

    async liveNonTitularRole(petId) {
      const [row] = await db
        .select({ role: ownerships.role })
        .from(ownerships)
        .where(
          and(
            eq(ownerships.petId, petId),
            eq(ownerships.ownerUserId, viewer.userId),
            ne(ownerships.role, "owner"),
            isNull(ownerships.endedAt),
          ),
        )
        .limit(1);
      return row?.role ?? null;
    },

    async findOrgByToken(orgToken) {
      const [row] = await db
        .select({ id: organizations.id, displayName: organizations.displayName })
        .from(organizations)
        .where(eq(organizations.publicToken, orgToken))
        .limit(1);
      return row ?? null;
    },

    isActiveOrgMember(orgId) {
      return isActiveOrgMember(orgId, viewer.userId);
    },

    async hadEndedMembership(orgId) {
      if (await isActiveOrgMember(orgId, viewer.userId)) return false;
      const [row] = await db
        .select({ id: organizationMemberships.id })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, orgId),
            eq(organizationMemberships.userId, viewer.userId),
            isNotNull(organizationMemberships.leftAt),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
  };
}

/** One of the caller's OWN notifications, archived or not; `null` for anybody else's. */
export async function findOwnNotification(
  notificationId: string,
  userId: string,
): Promise<NotificationTargetRow | null> {
  const [row] = await db
    .select({
      id: notifications.id,
      notificationType: notifications.notificationType,
      title: notifications.title,
      body: notifications.body,
      ctaUrl: notifications.ctaUrl,
      relatedPetId: notifications.relatedPetId,
      relatedCaseId: notifications.relatedCaseId,
    })
    .from(notifications)
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve one of the viewer's own notifications. `null` when the id is not
 * theirs (or not a notification) — an id belonging to somebody else and one
 * belonging to nobody answer identically, so this is no oracle.
 */
export async function resolveOwnNotificationTarget(
  notificationId: string,
  viewer: CaseViewer,
): Promise<ResolvedNotificationTarget | null> {
  if (!isUuid(notificationId)) return null;
  const row = await findOwnNotification(notificationId, viewer.userId);
  if (row === null) return null;
  return resolveNotificationTarget(
    row,
    { userId: viewer.userId, role: viewer.role },
    notificationTargetProbes(viewer),
  );
}
