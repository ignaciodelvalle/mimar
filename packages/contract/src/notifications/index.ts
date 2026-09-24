// `@dim/contract/notifications` — the notification inbox's DISPLAY rule.
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
