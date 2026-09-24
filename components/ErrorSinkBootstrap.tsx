"use client";

// Installs the client error transport, once, for the whole app.
//
// WHY A COMPONENT AND NOT A MODULE SIDE-EFFECT
// ---------------------------------------------------------------------------
// `setErrorSink(beaconSink)` at module scope would run wherever the module gets
// imported — including on the SERVER during SSR of any tree that touches it,
// where `navigator` does not exist and the sink is meaningless. Mounting it as
// a client component makes "when" explicit: after hydration, in a browser, once
// per document.
//
// It renders nothing. It exists for its effect, and saying so here is cheaper
// than the next reader wondering what it draws.
//
// WHY IT IS SAFE TO MOUNT IN THE ROOT LAYOUT
// ---------------------------------------------------------------------------
// `setErrorSink` swaps a module-level variable. Re-running the effect is
// harmless (same sink, same value), and React's StrictMode double-invoke in
// development therefore cannot produce a duplicate transport or a duplicated
// report — the sink is not a subscription, it is a slot.
//
// WHAT THIS DOES NOT DO: it does not enable any third party. The transport
// posts to this app's own `/api/telemetry/client-error`, which re-emits into
// the Vercel function logs the server already writes to. The hosted-APM
// decision (Sentry et al.) is separate, still open, and gated on the art. 12
// analysis in `docs/architecture/client-error-sink-pending-decision.md`.
import { useEffect } from "react";

import { beaconSink } from "@/lib/observability/beacon-sink";
import { setErrorSink } from "@/lib/observability/sink";

export function ErrorSinkBootstrap(): null {
  useEffect(() => {
    setErrorSink(beaconSink);
  }, []);
  return null;
}
