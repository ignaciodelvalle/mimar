// The captura-rápida matcher MOVED to `@dim/contract/events` on 2026-09-17.
//
// This file is the compatibility door, and it is the same shape `db/schema.ts`
// uses for `EVENT_TYPES`: the symbols are re-exported from their new home so
// that the eight web call sites (CaptureBox, handoff, the atender console and
// its narrowing module, NotificationQuickReply, notification-quick-reply-nav,
// the quick-capture use-case) and the four web test files keep importing
// `@/lib/events/event-capture-matcher` and keep working unchanged.
//
// WHY IT MOVED. The native app needed the same answer to the same question —
// "what kind of asiento is this sentence?" — on its asentar screen. The
// alternative was a second matcher inside `apps/mobile`, and two matchers that
// drift apart are strictly worse than no matcher: the same sentence would
// resolve to different forms on the web and on the phone. The move cost exactly
// one import line, because the file's only app-level reference was
// `import type { EventType } from "@/db/schema"` and that type has lived in
// `packages/contract/src/events/event-types.ts` since the catalog left the ORM.
//
// WHAT DID NOT MOVE. `./event-capture-registry` — the event-type-to-web-route
// table — is a fact about the Next.js app, not about the domain, so it stays
// here and the native side never sees it. `matchToCaptureUrl` did move, because
// it takes the registry's builder as an argument rather than importing it, but
// it is web-shaped and the native caller reads `MatchResult.eventType` instead.
//
// A NEW WEB CALLER MAY IMPORT EITHER PATH. This one is not deprecated; it is
// the web's spelling of a module the contract owns.

export {
  CAPTURE_INPUT_MAX_LENGTH,
  extractDateFromText,
  gateMatchForViewer,
  matchCaptureIntent,
  matchToCaptureUrl,
  ymdLocal,
  type ConfidenceLabel,
  type MatchResult,
} from "@dim/contract/events";
