"use client";

import { useEffect } from "react";

import { scrollIntoViewRespectingMotion } from "@/lib/ui/reduced-motion-scroll";

type ScrollToSignalProps = {
  /** The `signalEventId` targeted by the `?signalId=` deep-link. */
  signalId: string;
};

/**
 * Client-side enhancement for the brotes `?signalId=` deep-link.
 *
 * The matching row is server-rendered with a stable `id="signal-<eventId>"`
 * and a highlight ring (see OutbreakSignalRow). This component brings that row
 * into view on mount — the highlight itself is CSS/SSR, so wayfinding still
 * works without JavaScript; the scroll is a progressive enhancement.
 */
export function ScrollToSignal({ signalId }: ScrollToSignalProps) {
  useEffect(() => {
    scrollIntoViewRespectingMotion(document.getElementById(`signal-${signalId}`), {
      block: "center",
    });
  }, [signalId]);

  return null;
}
