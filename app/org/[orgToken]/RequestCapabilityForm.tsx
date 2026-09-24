"use client";

import { OpButton, OpTextarea } from "@/components/ui/dashboard";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import {
  type CapabilityActionState,
  requestCapabilityAction,
} from "@/src/modules/organizations/actions";
import { useActionState, useState } from "react";

const initialState: CapabilityActionState = { error: null };

export function RequestCapabilityForm({
  capability,
  label,
  orgToken,
}: {
  capability: string;
  label: string;
  orgToken: string;
}) {
  // forms/react19-reset-data-loss-inventory: "reason" is a bare uncontrolled
  // field — a rejected submit wipes it.
  const { boundAction, kept } = useKeptFields<CapabilityActionState>(requestCapabilityAction);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    return (
      <OpButton variant="ghost" size="sm" onClick={() => setExpanded(true)}>
        Solicitar
      </OpButton>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2 w-full">
      {/* The action used to resolve the org from the session default membership;
          for anyone in two organizations that is a coin flip. Pinned to the URL. */}
      <input type="hidden" name="orgToken" value={orgToken} />
      <input type="hidden" name="capability" value={capability} />
      <OpTextarea
        name="reason"
        rows={2}
        maxLength={500}
        defaultValue={kept("reason")}
        placeholder={`¿Por qué necesitás "${label}"? (opcional)`}
        size="xs"
      />
      <div className="flex items-center gap-2">
        <OpButton type="submit" variant="primary" size="sm" disabled={isPending}>
          {isPending ? "Enviando…" : "Enviar pedido"}
        </OpButton>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-sm px-2 py-1 rounded-[var(--radius-sm)] text-ln-op-mute hover:underline"
        >
          Cancelar
        </button>
      </div>
      {state.error && <p className="text-sm text-ln-op-danger">{state.error}</p>}
      {state.ok && (
        <p className="text-sm text-ln-op-ok">
          Solicitud enviada. Te avisamos cuando alguien decida.
        </p>
      )}
    </form>
  );
}
