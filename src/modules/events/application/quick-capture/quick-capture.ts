// Server use-case for the home-screen quick-capture text box.
//
// Wraps the deterministic keyword matcher (lib/event-capture-matcher) so the
// parsing logic is testable in isolation and server-owned. No auth required —
// this is pure text → URL transformation; it resolves a navigation target
// from free-text input and a pet publicToken, both of which are already
// known to the client. The resulting URL is constructed from the publicToken
// the same way buildCaptureDeeplink does across the codebase.
//
// Return shape:
//   { url: string }  — caller should router.push(url)
//   { url: null }    — no match; caller falls back to /anotar?text=... so the
//                      CaptureBox page can surface the "no reconocemos eso" UI.

import { matchCaptureIntent, matchToCaptureUrl } from "@/lib/events/event-capture-matcher";
import { buildCaptureDeeplink } from "@/lib/events/event-capture-registry";

import type { QuickCaptureResult } from "./types";

/**
 * Resolve a free-text event description to the deepest navigation URL we can
 * reach directly (i.e. the form pre-filled with extracted slots). Returns null
 * when the text doesn't match any known event pattern — the caller should then
 * fall back to the /anotar page so the user can try again or pick a form
 * manually.
 *
 * @param publicToken  The pet's publicToken (e.g. "DIM-3K4F-9P2X").
 * @param text         Raw free-text from the Anotar quick-capture box.
 */
// @no-auth-required: pure text→URL transformation; reads no data. publicToken is caller-provided and only used to construct the navigation deeplink path.
export async function quickCapture(publicToken: string, text: string): Promise<QuickCaptureResult> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 3) return { url: null };

  const match = matchCaptureIntent(trimmed);
  if (!match) return { url: null };

  return { url: matchToCaptureUrl(publicToken, match, buildCaptureDeeplink) };
}
