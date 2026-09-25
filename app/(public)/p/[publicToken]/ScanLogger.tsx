"use client";

// Fires the credential_scanned server action exactly once when the public
// credential page mounts. The guaranteed, coarse IP-area floor is captured
// server-side on that call (Task #45) — no browser permission, no UI.
//
// No device GPS anywhere (W8, PO 2026-09-24). A finder who wants to report a
// sighting ("La vi cerca de acá" → PetSightingForm) places the point by hand
// on the map (address search + draggable pin, components/LocationFields.tsx)
// — never a browser-geolocation prompt. A bare scan never asks for a location
// at all; scan_ip_area (coarse, IP-derived) is the only signal it carries.

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
