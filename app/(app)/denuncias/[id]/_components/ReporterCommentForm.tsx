"use client";

import { LnField, LnTextarea } from "@/components/ui/Field";
import { useActionState, useEffect, useState } from "react";

export type CommentFormState = { error: string | null; success: boolean };

const initialState: CommentFormState = { error: null, success: false };

type CommentFormAction = (prev: CommentFormState, formData: FormData) => Promise<CommentFormState>;

export function ReporterCommentForm({ action }: { action: CommentFormAction }) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const [text, setText] = useState("");

  useEffect(() => {
    if (state.success) setText("");
  }, [state.success]);

  return (
    <form action={formAction} className="space-y-4">
      <LnField
        label="Agregar un comentario"
        error={state.error ?? undefined}
        hint="Podés agregar novedades, aclaraciones o información adicional sobre esta denuncia. Máximo 2000 caracteres."
      >
        {({ id, describedBy, invalid }) => (
          <LnTextarea
            id={id}
            name="text"
            rows={4}
            required
            maxLength={2000}
            placeholder="Escribí tu comentario…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      {state.success && (
        <p className="text-sm text-[var(--color-ln-ok)] font-medium">
          Comentario enviado correctamente.
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="px-4 py-2 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white text-sm font-medium hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isPending ? "Enviando..." : "Enviar comentario"}
      </button>
    </form>
  );
}
