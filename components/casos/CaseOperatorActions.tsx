"use client";

// CaseOperatorActions — los controles que el detalle de caso no tenía (#41).
//
// Hasta el 2026-08-10 esta pantalla tenía CERO controles de operador, mientras
// la cola de `/gob/casos` ordena por urgencia en SQL y manda al funcionario
// derecho al expediente más urgente de su jurisdicción. Arreglar el orden hizo
// el callejón más visible, no menos.
//
// LO QUE NO ESTÁ, SE EXPLICA. Cuando el cierre no está disponible, el
// componente NO esconde el botón en silencio: muestra el motivo que trae el
// dominio, y ese motivo nombra QUÉ cierra el expediente. Un funcionario que sabe
// que un episodio de custodia se cierra solo cuando el animal sale de custodia
// no vuelve tres veces a buscar el botón. La lección repetida de este producto
// es que una acción ausente sin explicación se lee como un error del usuario.

import { useState, useTransition } from "react";

import {
  addCaseNoteAction,
  closeCaseAction,
  escalateCaseAction,
} from "@/app/actions/case-operator";
import { OpButton, OpTextarea } from "@/components/ui/dashboard";
import type { CaseActionAvailability } from "@/src/modules/cases/domain/available-actions";

type Mode = "none" | "note" | "close" | "escalate";

export function CaseOperatorActions({
  publicCode,
  actions,
}: {
  publicCode: string;
  /** Resuelto en el servidor por `availableCaseActions(kind, status)`. */
  actions: CaseActionAvailability[];
}) {
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>("none");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const note = actions.find((a) => a.action === "note");
  const close = actions.find((a) => a.action === "close");
  const escalate = actions.find((a) => a.action === "escalate");

  // Los motivos de ausencia, SIN repetidos. Sobre un expediente cerrado, cierre
  // y escalada dicen las dos casi lo mismo, y leer dos veces "está cerrado" hace
  // parecer roto a un bloque que está funcionando.
  const reasons = [close, escalate]
    .filter((a) => a && !a.available && a.unavailableReason)
    .map((a) => a?.unavailableReason as string);
  const distinctReasons = Array.from(new Set(reasons));

  // Sin ninguna acción disponible y sin nada que explicar, el bloque no aporta.
  if (!note?.available && !close?.available && !escalate?.available && distinctReasons.length === 0)
    return null;

  function reset() {
    setMode("none");
    setText("");
    setError(null);
  }

  function run(fn: () => Promise<{ ok: true } | { error: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if ("error" in res) {
        setError(res.error);
        return;
      }
      reset();
    });
  }

  return (
    <section
      aria-label="Acciones sobre el expediente"
      className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 space-y-3"
    >
      <h2 className="text-base font-semibold text-ln-op-ink">Acciones</h2>

      {mode === "none" && (
        <div className="flex flex-wrap items-center gap-2">
          {note?.available && (
            <OpButton variant="ghost" size="sm" onClick={() => setMode("note")}>
              Asentar nota
            </OpButton>
          )}
          {escalate?.available && (
            <OpButton variant="ghost" size="sm" onClick={() => setMode("escalate")}>
              Escalar
            </OpButton>
          )}
          {close?.available && (
            <OpButton variant="ghost" size="sm" onClick={() => setMode("close")}>
              Cerrar expediente
            </OpButton>
          )}
        </div>
      )}

      {mode === "note" && (
        <div className="space-y-2">
          <OpTextarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Qué pasó, qué se hizo, con quién se habló."
          />
          <p className="text-sm text-ln-op-mute">
            Queda asentada en el expediente con tu nombre y la fecha. No cambia el estado del caso.
          </p>
          <div className="flex items-center gap-2">
            <OpButton
              variant="primary"
              size="sm"
              disabled={pending}
              onClick={() => run(() => addCaseNoteAction(publicCode, text))}
            >
              {pending ? "Asentando…" : "Asentar nota"}
            </OpButton>
            <OpButton variant="ghost" size="sm" disabled={pending} onClick={reset}>
              Cancelar
            </OpButton>
          </div>
        </div>
      )}

      {mode === "escalate" && (
        <div className="space-y-2">
          {/* Qué va a pasar, antes del click. Escalar no es destructivo, pero SÍ
              le manda un aviso a gente que no estaba mirando este expediente, y
              eso merece saberse antes y no después. */}
          <p className="rounded-[var(--radius-sm)] border border-ln-op-blue-bd bg-ln-op-blue-bg px-3 py-2 text-sm text-ln-op-azul">
            Escalar avisa a la autoridad de la jurisdicción del expediente y a la administración de
            la plataforma. El motivo que escribas va en ese aviso.
          </p>
          <OpTextarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Por qué este expediente necesita otra mirada, ahora."
          />
          <p className="text-sm text-ln-op-mute">Es lo primero que va a leer quien lo reciba.</p>
          <div className="flex items-center gap-2">
            <OpButton
              variant="primary"
              size="sm"
              disabled={pending}
              onClick={() => run(() => escalateCaseAction(publicCode, text))}
            >
              {pending ? "Escalando…" : "Confirmar escalada"}
            </OpButton>
            <OpButton variant="ghost" size="sm" disabled={pending} onClick={reset}>
              Cancelar
            </OpButton>
          </div>
        </div>
      )}

      {mode === "close" && (
        <div className="space-y-2">
          {/* Divulgación de consecuencia ANTES del click, que es la convención de
              la casa para toda acción difícil de revertir. Un expediente cerrado
              no se reabre: el ciclo de vida de custody_episode declara
              reopenAllowed: false. */}
          <p className="rounded-[var(--radius-sm)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-3 py-2 text-sm text-ln-op-warn">
            Cerrar da por terminado el expediente. <strong>No se puede reabrir</strong> — si después
            pasa algo nuevo con este animal, se abre un expediente nuevo. El motivo que escribas
            queda en el registro.
          </p>
          <OpTextarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Por qué se da por terminado este expediente."
          />
          <p className="text-sm text-ln-op-mute">
            Lo va a leer quien abra el expediente dentro de seis meses.
          </p>
          <div className="flex items-center gap-2">
            <OpButton
              variant="danger"
              size="sm"
              disabled={pending}
              onClick={() => run(() => closeCaseAction(publicCode, text))}
            >
              {pending ? "Cerrando…" : "Confirmar cierre"}
            </OpButton>
            <OpButton variant="ghost" size="sm" disabled={pending} onClick={reset}>
              Cancelar
            </OpButton>
          </div>
        </div>
      )}

      {/* El motivo de la ausencia, no el silencio. */}
      {mode === "none" &&
        distinctReasons.map((reason) => (
          <p key={reason} className="text-sm text-ln-op-mute">
            {reason}
          </p>
        ))}

      {error && (
        <p role="alert" className="text-sm text-ln-op-danger">
          {error}
        </p>
      )}
    </section>
  );
}
