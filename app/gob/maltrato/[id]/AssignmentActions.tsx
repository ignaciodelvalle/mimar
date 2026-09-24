"use client";

import { useState, useTransition } from "react";

import { OpButton } from "@/components/ui/dashboard";
import { notifyActionError, notifySaved, notifyUndoable } from "@/lib/ui/action-feedback";
import { assignWelfareToMeAction, unassignWelfareAction } from "@/src/modules/welfare/actions";

type AssignmentActionsProps = {
  reportId: string;
  assignedToUserId: string | null;
  currentUserId: string;
  isAdmin: boolean;
};

export function AssignmentActions({
  reportId,
  assignedToUserId,
  currentUserId,
  isAdmin,
}: AssignmentActionsProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Tier B optimistic assignment: the Tomar/Liberar button swap happens
  // immediately from local state (seeded from the SSR prop) and reverts on
  // error. No router.refresh() (banned, silent-drop defect; see
  // lib/ui/full-page-action-nav.ts).
  const [assignedTo, setAssignedTo] = useState(assignedToUserId);

  const isAssignedToMe = assignedTo === currentUserId;
  const canUnassign = isAssignedToMe || isAdmin;

  // Q5 (toast "Deshacer") — assign ↔ unassign is the repo's one HONEST undo
  // pair: both directions are first-class server actions and each restores
  // the exact prior state this component just left (this is an in-place
  // mutation surface — mechanism #2 in lib/ui/action-feedback.ts — so the
  // toast survives; no reload wipes it). The undo commits through the SAME
  // actions the buttons use and confirms with the standard toast.

  /** Inverse of a successful self-assign: liberar. Prior state was
   * unassigned (the Asignármela button only renders then), so unassign
   * restores it exactly. */
  function undoAssign() {
    startTransition(async () => {
      const result = await unassignWelfareAction(reportId);
      if ("error" in result) {
        notifyActionError(result.error);
        return;
      }
      setAssignedTo(null);
      notifySaved("Denuncia liberada");
    });
  }

  /** Inverse of a successful self-unassign: volver a tomarla. Only offered
   * when the case WAS the viewer's own — assignWelfareToMeAction assigns to
   * SELF, so for an admin who liberated someone else's case it would be a
   * takeover, not an undo. */
  function undoUnassign() {
    startTransition(async () => {
      const result = await assignWelfareToMeAction(reportId);
      if ("error" in result) {
        notifyActionError(result.error);
        return;
      }
      setAssignedTo(currentUserId);
      notifySaved("Te asignaste la denuncia");
    });
  }

  function handleAssign() {
    setError(null);
    const previous = assignedTo;
    setAssignedTo(currentUserId);
    startTransition(async () => {
      const result = await assignWelfareToMeAction(reportId);
      if ("error" in result) {
        setAssignedTo(previous);
        setError(result.error);
      } else {
        notifyUndoable("Te asignaste la denuncia", { onUndo: undoAssign });
      }
    });
  }

  function handleUnassign() {
    setError(null);
    const previous = assignedTo;
    setAssignedTo(null);
    startTransition(async () => {
      const result = await unassignWelfareAction(reportId);
      if ("error" in result) {
        setAssignedTo(previous);
        setError(result.error);
      } else if (previous === currentUserId) {
        notifyUndoable("Denuncia liberada", {
          label: "Volver a tomar",
          onUndo: undoUnassign,
        });
      } else {
        // Admin liberating someone ELSE's case: re-assigning to the admin is
        // not an inverse — no honest undo to offer (see Q5 rule above).
        notifySaved("Denuncia liberada");
      }
    });
  }

  if (!assignedTo) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <OpButton
            type="button"
            onClick={handleAssign}
            disabled={pending}
            variant="primary"
            size="sm"
          >
            {pending ? "Procesando..." : "Asignármela"}
          </OpButton>
        </div>
        {error && (
          <p role="alert" className="text-sm text-ln-op-danger">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (canUnassign) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <OpButton
            type="button"
            onClick={handleUnassign}
            disabled={pending}
            variant="ghost"
            size="sm"
          >
            {pending ? "Procesando..." : "Desasignar"}
          </OpButton>
        </div>
        {error && (
          <p role="alert" className="text-sm text-ln-op-danger">
            {error}
          </p>
        )}
      </div>
    );
  }

  // Assigned to someone else, no action available.
  return null;
}
