// denuncia-autosave — localStorage-based draft persistence for the denuncia wizard.
//
// PRIVACY NOTICE: Only the reporter's own in-progress answers are stored here,
// in their own browser's localStorage. Nothing is sent to a server.
// The denuncia is anonymous — this module never touches contact email/phone
// or any field that could identify the reporter beyond what they explicitly typed.
// The autosave is cleared on successful submit (call clearDraft()).
//
// Key: `denuncia_draft_v1` — versioned so a schema change simply yields a cold start.
// TTL: 24h (drafts older than that are silently discarded on restore).

const STORAGE_KEY = "denuncia_draft_v1";
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type DraftStep1 = {
  kind: string | null;
};

export type DraftStep2 = {
  severity: string | null;
};

export type DraftStep3 = {
  description: string;
  when: string | null;
};

/**
 * Where the incident happened, as the wizard holds it.
 *
 * This used to be excluded, with the note "LocationFields uncontrolled inputs
 * are NOT persisted here — they are DOM-bound and would require a separate
 * strategy (deferred TODO)". That stopped being true when the wizard lifted the
 * value out of the hidden inputs and into its own state
 * (DenunciaWizard.tsx: "the wizard owns the location value instead of reading
 * uncontrolled hidden inputs at submit"). The blocker was gone; the deferred
 * work was never revisited, and the stale comment kept anyone from noticing.
 *
 * The cost was silent: a reload restored the description, the severity and the
 * step, so the reporter landed back on step 4 with the location blanked and no
 * sign that anything had been lost (adversarial review 2026-08-08, S1-F03).
 *
 * Privacy: this is the INCIDENT's location, which the reporter typed or picked
 * on purpose — the same class as the description. Contact email/phone stay out
 * of the draft, as before.
 */
export type DraftLocation = {
  provinceCode: string | null;
  provinceName: string | null;
  localityName: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  source: string | null;
};

export type DraftData = {
  step: number;
  step1: DraftStep1;
  step2: DraftStep2;
  step3: DraftStep3;
  /** Optional: drafts written before this field existed restore without it. */
  location?: DraftLocation | null;
  savedAt: number; // Unix ms — used for TTL check
};

/** Serialize wizard state into localStorage. Safe to call on every change. */
export function saveDraft(draft: Omit<DraftData, "savedAt">): void {
  if (typeof window === "undefined") return;
  try {
    const payload: DraftData = { ...draft, savedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // QuotaExceededError or SecurityError — silently ignore; non-critical.
  }
}

/** Restore a draft from localStorage. Returns null if absent, invalid, or expired. */
export function restoreDraft(): DraftData | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftData>;
    // Validate minimal shape and TTL
    if (
      typeof parsed.savedAt !== "number" ||
      typeof parsed.step !== "number" ||
      !parsed.step1 ||
      !parsed.step2 ||
      !parsed.step3
    ) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    if (Date.now() - parsed.savedAt > TTL_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed as DraftData;
  } catch {
    // Corrupt JSON or SecurityError
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    return null;
  }
}

/** Remove the draft. Call after successful submit. */
export function clearDraft(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Returns true if a draft exists and is not expired. */
export function hasDraft(): boolean {
  return restoreDraft() !== null;
}
