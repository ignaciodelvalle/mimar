// `@dim/contract/notifications` — the notification inbox's DISPLAY rule, and
// (since notificaciones-destinos, 2026-10) the registry of every notification
// kind plus the es-AR copy a destination is explained with.
//
// It is an entry point of its own, beside `links` and `viz`, for the reason
// those two are: it is BEHAVIOUR shared by two programs, not a wire shape.
// `@dim/contract/api`'s `my-notifications.ts` carries what the endpoint sends;
// this carries what both renderers do with it, and the split is the same one the
// package already draws everywhere else.
//
// Zero runtime dependencies — no zod here, so a consumer that only renders an
// inbox never loads a validator.
export {
  NOTIFICATION_ACTOR_COPY,
  NOTIFICATION_REASON_COPY,
  NOTIFICATION_TARGET_REASONS,
  type NotificationTargetReason,
} from "./copy.ts";
export {
  NOTIFICATION_DESTINATIONS,
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_NAMES,
  NOTIFICATION_PENDING_ACTORS,
  NOTIFICATION_SUBJECTS,
  type NotificationDestination,
  type NotificationKind,
  type NotificationKindSpec,
  type NotificationPendingActor,
  type NotificationSubject,
  UNKNOWN_NOTIFICATION_KIND_SPEC,
  notificationKindSpec,
} from "./kinds.ts";
export {
  NOTIFICATION_GROUP_MIN,
  NOTIFICATION_SEVERITIES,
  type NotificationFacts,
  type NotificationGroup,
  type NotificationOrderingFacts,
  type NotificationSeverity,
  groupForDisplay,
  severityRank,
  sortForDisplay,
} from "./ordering.ts";
export { wireNotificationFacts } from "./wire.ts";
