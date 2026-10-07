// The read behind the "Esperan tu respuesta" card on Mis mascotas.
//
// THE SAME TWO READS THE TRANSFERENCIAS HUB MAKES (`/me/transfers` and
// `/me/caretaker-grants`), so the card shows nothing that screen would not.
//
// QUIET WHEN IT FAILS, for `use-open-cases.ts`'s reason: the pets are what that
// screen is for, and a failed read here must not replace them with an error. The
// card keeps whatever it last showed (usually nothing); Transferencias, in the
// header's ☰ menu, is where a failed read is reported with a retry. A read
// that throws instead of answering is swallowed the same way — a banner is never
// worth a crash on the screen people open most.
//
// A READ THAT RESOLVES AFTER A NEWER ONE STARTED IS DROPPED — the generation
// guard the pets list and the casos block use.

import { useCallback, useRef, useState } from "react";

import { fetchMyCaretakerGrants, fetchMyTransfers } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";

import { type PendingIncomingRow, pendingIncomingRows } from "./pending-incoming-view-model";

export type UsePendingIncoming = {
  /** The rows waiting on an answer; empty before the first read lands. */
  rows: PendingIncomingRow[];
  /** Re-read. Call on focus, on pull-to-refresh and on reconnect. */
  refresh: () => Promise<void>;
};

export function usePendingIncoming(): UsePendingIncoming {
  const [rows, setRows] = useState<PendingIncomingRow[]>([]);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const [transfers, grants] = await Promise.all([
        fetchMyTransfers(sessionPort),
        fetchMyCaretakerGrants(sessionPort),
      ]);
      if (mine !== generation.current) return;
      if (transfers.outcome !== "ok" || grants.outcome !== "ok") return;
      setRows(pendingIncomingRows(transfers.payload, grants.payload));
    } catch {
      // Quiet by design — see the header.
    }
  }, []);

  return { rows, refresh };
}
