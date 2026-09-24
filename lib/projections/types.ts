// Shared shape for projection inputs. Mirrors the columns + payload that
// every projection module reads, no more. Avoids importing the full pet_events
// type from db/schema (which carries fields like author_role that no projector
// needs).

export type ProjectionEvent = {
  id: string;
  eventType: string;
  occurredAt: Date | string;
  recordedAt: Date | string;
  payload: unknown;
};

declare const amendmentOverlaid: unique symbol;

/**
 * Marks an event stream that went through `overlayAmendments`
 * (lib/infra/amendment.ts) — the ONLY function that mints it (A05-7).
 *
 * The replays that read an amendable event type (weight, pregnancy,
 * jurisdiction) take `AmendmentOverlaid<ProjectionEvent>`, so a RAW
 * `pet_events` array stops type-checking at their call sites. That is the
 * failure A08-G1/G2 shipped green: two write paths re-derived a cache from the
 * raw stream and silently reverted a correction the amendment path had just
 * written. The brand does not prove the stream CONTAINS its `event_amended`
 * rows — a query that filters them out still overlays nothing — so
 * `scripts/check-amendment-overlay.ts` checks the fetch side.
 */
export type AmendmentOverlaidBrand = { readonly [amendmentOverlaid]: true };

export type AmendmentOverlaid<T> = ReadonlyArray<T> & AmendmentOverlaidBrand;
