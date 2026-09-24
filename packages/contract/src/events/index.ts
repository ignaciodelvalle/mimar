// `@dim/contract/events` — the event vocabulary.
export {
  CONTENT_REPORT_CATEGORIES,
  CONTENT_REPORT_TARGET_KINDS,
  EVENT_TYPES,
  type ContentReportCategory,
  type ContentReportTargetKind,
  type EventType,
} from "./event-types.ts";

// The captura-rápida matcher — free Spanish text to an event type. It is part
// of the vocabulary rather than of either app: the web's capture box, the
// atender console, the notification quick reply and the native asentar screen
// all ask it the same question, and a second copy would let the same sentence
// resolve to different forms on different surfaces. See the file's header.
export {
  CAPTURE_INPUT_MAX_LENGTH,
  extractDateFromText,
  gateMatchForViewer,
  matchCaptureIntent,
  matchToCaptureUrl,
  ymdLocal,
  type ConfidenceLabel,
  type MatchResult,
} from "./event-capture-matcher.ts";
