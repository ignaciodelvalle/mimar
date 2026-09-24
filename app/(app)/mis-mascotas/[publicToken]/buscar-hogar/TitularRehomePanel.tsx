"use client";

// The titular's surface for the adoption sponsorship (rehome-by-titular WU5,
// task 5.8 — carried from 4.3). ONE panel, THREE states, because they are the
// same question at different moments: "who is helping find this animal a
// home, and where does that stand?"
//
//   none    → the verified orgs covering the pet's zone, one ask each
//   pending → who was asked, the link to the request, the lever to cancel
//   active  → who accompanies, what that means, the expediente, the lever
//             to end it
//
// CANCEL AND WITHDRAW ARE DIFFERENT FACTS and the component keeps them apart
// (spec REQ-3 vs REQ-8). Cancelling a pending request closes a case nobody
// acted on; withdrawing a running sponsorship ends a custody row, clears a
// public listing and closes every application on it. Both confirm before
// firing; the withdraw's confirmation says exactly that, because it is the
// one a titular can regret.
//
// THE ASK DOES NOT CONFIRM. It is reversible on this same screen (cancel),
// and a confirmation on a reversible act is friction with nothing behind it.
//
// Post-success is a full document navigation (lib/ui/full-page-action-nav.ts)
// back to this page, which re-renders in its next state — the request's
// "Pedido enviado a {org}" is the success notice, under the same name the
// button had.

import Link from "next/link";
import { useState, useTransition } from "react";

import { LnButton } from "@/components/ui/Button";
import { LnCallout } from "@/components/ui/DocElements";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import {
  requestRehomeSponsorshipAction,
  withdrawRehomeRequestAction,
  withdrawRehomeSponsorshipAction,
} from "@/src/modules/rehome/actions";

export type RehomeOrgOption = {
  id: string;
  displayName: string;
  orgType: string;
  /** The locality (or province) the org covers that matched the pet's zone. */
  locality: string | null;
};

export type TitularRehomeState =
  | { kind: "none"; orgs: RehomeOrgOption[] }
  | { kind: "pending"; orgDisplayName: string; casePublicCode: string }
  | { kind: "active"; orgDisplayName: string; listingCasePublicCode: string | null };

type Props = {
  petPublicToken: string;
  petName: string;
  state: TitularRehomeState;
};

function orgKindLabel(orgType: string): string {
  return orgType === "rescue_network" ? "Red de rescate" : "Refugio";
}

const linkCls =
  "font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline";

export function TitularRehomePanel({ petPublicToken, petName, state }: Props) {
  if (state.kind === "none") {
    return <OrgPicker petPublicToken={petPublicToken} orgs={state.orgs} />;
  }
  if (state.kind === "pending") {
    return (
      <div className="space-y-5">
        <LnCallout tone="azul" title={`Pedido enviado a ${state.orgDisplayName}`}>
          Todavía no respondió. Mientras tanto nada cambia: {petName} sigue con vos y no hay ninguna
          publicación.{" "}
          <Link href={`/casos/${state.casePublicCode}`} className={linkCls}>
            Ver la solicitud
          </Link>
        </LnCallout>
        <ExitControl
          petPublicToken={petPublicToken}
          kind="cancel"
          trigger="Cancelar el pedido"
          confirm="Confirmar la cancelación"
        >
          El pedido a {state.orgDisplayName} se cancela y la organización deja de verlo. No empezó
          nada, así que no se pierde nada; podés pedírselo a otra organización cuando quieras.
        </ExitControl>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <LnCallout tone="azul" title={`${state.orgDisplayName} acompaña la adopción de ${petName}`}>
        {petName} sigue viviendo con vos. {state.orgDisplayName} lo publica en la búsqueda de hogar
        y evalúa a quienes se postulan; cuando haya una adopción, te lo van a avisar.{" "}
        {state.listingCasePublicCode && (
          <Link href={`/casos/${state.listingCasePublicCode}`} className={linkCls}>
            Ver el expediente
          </Link>
        )}
      </LnCallout>
      <ExitControl
        petPublicToken={petPublicToken}
        kind="withdraw"
        trigger="Dar de baja el acompañamiento"
        confirm="Confirmar la baja"
      >
        {petName} se retira de la búsqueda de hogar en este momento y {state.orgDisplayName} deja de
        tener custodia registral. Las postulaciones que haya quedan cerradas y cada persona recibe
        un aviso. Si más adelante querés volver a buscarle hogar, pedís un acompañamiento nuevo.
      </ExitControl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// none — the org picker
// ---------------------------------------------------------------------------

function OrgPicker({ petPublicToken, orgs }: { petPublicToken: string; orgs: RehomeOrgOption[] }) {
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ orgId: string; message: string } | null>(null);

  function ask(org: RehomeOrgOption) {
    setRefusal(null);
    setAsking(org.id);
    startTransition(async () => {
      const result = await requestRehomeSponsorshipAction({
        petPublicToken,
        targetOrgId: org.id,
      });
      if ("error" in result) {
        setRefusal({ orgId: org.id, message: result.error });
        setAsking(null);
        return;
      }
      navigateAfterActionSuccess(result.redirectTo);
    });
  }

  return (
    <ul className="m-0 list-none overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] p-0">
      {orgs.map((org) => (
        <li
          key={org.id}
          className="flex flex-col gap-2.5 border-b border-[var(--color-ln-line-2)] px-4 py-3.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <p className="m-0 font-ln-serif text-md font-semibold text-[var(--color-ln-ink)]">
              {org.displayName}
            </p>
            <p className="m-0 mt-0.5 font-ln-mono text-sm text-[var(--color-ln-mute)]">
              {orgKindLabel(org.orgType)}
              {org.locality ? ` · ${org.locality}` : ""}
            </p>
            {refusal?.orgId === org.id && (
              <p role="alert" className="m-0 mt-1.5 text-sm text-[var(--color-ln-err)]">
                {refusal.message}
              </p>
            )}
          </div>
          <LnButton
            variant="primary"
            size="sm"
            aria-label={`Pedir acompañamiento a ${org.displayName}`}
            onClick={() => ask(org)}
            disabled={pending}
          >
            {pending && asking === org.id ? "Enviando…" : "Pedir acompañamiento"}
          </LnButton>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// pending / active — the two exits, confirmed
// ---------------------------------------------------------------------------

function ExitControl({
  petPublicToken,
  kind,
  trigger,
  confirm,
  children,
}: {
  petPublicToken: string;
  kind: "cancel" | "withdraw";
  trigger: string;
  confirm: string;
  children: React.ReactNode;
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    startTransition(async () => {
      const result =
        kind === "withdraw"
          ? await withdrawRehomeSponsorshipAction({ petPublicToken })
          : await withdrawRehomeRequestAction({ petPublicToken });
      if ("error" in result) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      navigateAfterActionSuccess(result.redirectTo);
    });
  }

  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="m-0 text-sm text-[var(--color-ln-err)]">
          {error}
        </p>
      )}
      {confirming ? (
        <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-seal)] bg-[var(--color-ln-err-050)] p-4">
          <p className="m-0 text-md leading-snug text-[var(--color-ln-ink-2)]">{children}</p>
          <div className="flex flex-wrap gap-2">
            <LnButton variant="seal" onClick={run} disabled={pending}>
              {pending ? "Procesando…" : confirm}
            </LnButton>
            <LnButton variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
              Volver
            </LnButton>
          </div>
        </div>
      ) : (
        <LnButton variant="seal" onClick={() => setConfirming(true)}>
          {trigger}
        </LnButton>
      )}
    </div>
  );
}
