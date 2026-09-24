"use client";

import { useEffect } from "react";

import { logLibretaShareViewAction } from "@/app/actions/libreta-share";

export function ViewLogger({ shareToken }: { shareToken: string }) {
  useEffect(() => {
    // Fire once on mount. Does not block render. Errors swallowed —
    // this is a best-effort counter bump.
    //
    // The viewer's user agent used to travel with this call and land in
    // share_telemetry. Migration 0167 (TEL-1, PO 2026-08-04) removed that
    // table, so nothing about the viewer leaves the browser any more — only
    // the share token, which the server already has.
    logLibretaShareViewAction({ shareToken }).catch(() => {});
  }, [shareToken]);

  return null;
}
