// Re-exports the document turn plan from `@dim/contract/credential`.
// The numbers used to be transcribed here from FlipCard; both sides now
// import the same module so an OTA JS change cannot disagree with the web
// sheet. Native-only comments (Reanimated ban, Animated driver) live in
// `DocumentTurn.tsx`.

export {
  TURN_EDGE_ON_DEG,
  TURN_IN_MS,
  TURN_OUT_MS,
  TURN_PERSPECTIVE,
  TURN_SETTLE_AT_MS,
  TURN_SWAP_AT_MS,
  TURN_TOTAL_MS,
  turnAngles,
  turnPlan,
  type TurnEasing,
  type TurnStep,
} from "@dim/contract/credential";
