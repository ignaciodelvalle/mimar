"use client";

// MutationErrorCard — recoverable failure card for idempotent mutation forms
// (degraded-states 2026-08-06, design D5).
//
// Renders ONLY on `transientFailure` — the state produced when
// useRetryableAction (lib/ui/use-retryable-action.ts) caught a rejected
// dispatch (503/abort). The form is still mounted and the typed input intact;
// "Reintentar envío" replays the SAME form via requestSubmit(), so the hidden
// `clientIdempotencyKey` travels unchanged and a server-persisted write
// resolves as confirmation, not a duplicate.
//
// BACKOFF (spec: Retry Backoff): the button disables for RETRY_DISABLE_MS
// after each press; after RETRY_MAX_ATTEMPTS presses it is replaced by
// D.12-shaped copy — go verify in the libreta BEFORE re-submitting — because
// under invariant #2 (append-only events) a blind duplicate can never be
// removed.
//
// This card is NOT the atender stall notice: AtenderStallNotice fires when a
// submit is STILL pending at 8s; this card fires when the dispatch REJECTED
// (pending cleared). Mutually exclusive by construction — no shared state.

import { LnButton } from "@/components/ui/Button";
import { LnCallout } from "@/components/ui/DocElements";
import {
  MUTATION_RETRY_COPY,
  RETRY_DISABLE_MS,
  RETRY_MAX_ATTEMPTS,
} from "@/lib/ui/degraded-states";
import { type RefObject, useEffect, useRef, useState } from "react";

type Props = {
  /** `state.transientFailure` from a useRetryableAction-wrapped action. */
  transientFailure: boolean | undefined;
  /** `state.error` — the cause line shown inside the card. */
  error: string | null;
  /** Ref to the SAME <form> that failed — replayed via requestSubmit(). */
  formRef: RefObject<HTMLFormElement | null>;
};

export function MutationErrorCard({ transientFailure, error, formRef }: Props) {
  const [attempts, setAttempts] = useState(0);
  const [cooldown, setCooldown] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A state WITHOUT the flag means the failure resolved (success navigates
  // away; a validation error re-renders its own message) — reset the backoff
  // so a later, unrelated failure starts fresh.
  useEffect(() => {
    if (!transientFailure) {
      setAttempts(0);
      setCooldown(false);
      if (timerRef.current) clearTimeout(timerRef.current);
    }
  }, [transientFailure]);

  // Clear the cooldown timer on unmount — no setState after unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!transientFailure) return null;

  const exhausted = attempts >= RETRY_MAX_ATTEMPTS;

  function retry() {
    if (cooldown || exhausted) return;
    setAttempts((n) => n + 1);
    setCooldown(true);
    timerRef.current = setTimeout(() => setCooldown(false), RETRY_DISABLE_MS);
    formRef.current?.requestSubmit();
  }

  return (
    <LnCallout tone="danger" title={MUTATION_RETRY_COPY.title}>
      <p className="m-0" role="alert">
        {error ?? MUTATION_RETRY_COPY.cause}
      </p>
      {exhausted ? (
        <p className="m-0 mt-2">{MUTATION_RETRY_COPY.exhausted}</p>
      ) : (
        <div className="mt-2">
          <LnButton type="button" variant="seal" size="sm" onClick={retry} disabled={cooldown}>
            {MUTATION_RETRY_COPY.retry}
          </LnButton>
        </div>
      )}
    </LnCallout>
  );
}
