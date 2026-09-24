// The casos read behind the Mis mascotas block (M11).
//
// ITS OWN READ, NOT PART OF THE PETS LIST'S STATE, and the separation is the
// point: the pets are what that screen is for, and a casos read that failed must
// not replace the animals with an error. So a failure here is QUIET — the block
// keeps whatever it last showed (usually nothing) and the casos screen, one tap
// away, is where a failed read is reported with its reason and a retry.
//
// A READ THAT RESOLVES AFTER A NEWER ONE STARTED IS DROPPED, the same
// generation guard the pets list uses, so a slow first read cannot overwrite a
// fresh pull-to-refresh.

import type { MyCasesV1 } from "@dim/contract/api";
import { useCallback, useRef, useState } from "react";

import { fetchMyCases } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";

export type UseOpenCases = {
  /** The last payload that arrived, or `null` before one has. */
  cases: MyCasesV1 | null;
  /** Re-read. Call on focus, on pull-to-refresh and on reconnect. */
  refresh: () => Promise<void>;
};

export function useOpenCases(): UseOpenCases {
  const [cases, setCases] = useState<MyCasesV1 | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    const result = await fetchMyCases(sessionPort);
    if (mine !== generation.current) return;
    if (result.outcome === "ok") setCases(result.payload);
  }, []);

  return { cases, refresh };
}
