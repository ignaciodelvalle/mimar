"use client";

// Fires the credential_scanned server action exactly once when the public
// credential page mounts. The guaranteed, coarse IP-area floor is captured
// server-side on that call (Task #45) — no browser permission, no UI.
//
// Precise finder GPS is NOT collected here. Intent-driven capture (PO
// 2026-07-24, Option A): the finder's precise location is requested ONLY when
// they take an explicit sighting action ("La vi cerca de acá" → PetSightingForm),
// where they place the point on the map or tap "usar mi ubicación actual". A
// bare scan never prompts for GPS "antes de tiempo" — privacy-by-design ties
// the location ask to the moment its purpose (reporting a sighting) is engaged.

import { logScanAction } from "@/app/actions/scans";
import { useEffect, useRef } from "react";

export function ScanLogger({ publicToken }: { publicToken: string }) {
  const hasLogged = useRef(false);

  useEffect(() => {
    if (hasLogged.current) return;
    hasLogged.current = true;
    void logScanAction(publicToken);
  }, [publicToken]);

  return null;
}
