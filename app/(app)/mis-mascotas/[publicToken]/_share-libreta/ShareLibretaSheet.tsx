"use client";

import { useActionState, useEffect } from "react";

import { LnField, LnInput } from "@/components/ui/Field";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { LIBRETA_SHARE_EXPIRY_DAYS, LIBRETA_SHARE_LABEL_MAX } from "@dim/contract/input";

// The action receives the full input including petPublicToken; callers
// bind (or wrap) it so the component only supplies expiresInDays + label.
type CreateShareInput = {
  petPublicToken: string;
  expiresInDays: number | null;
  label: string | null;
};
type CreateShareResult = { error: string } | { shareToken: string };

type Props = {
  petPublicToken: string;
  petName: string;
  /** Pre-bound action — petPublicToken is already captured by the caller. */
  createShareAction: (
    input: Pick<CreateShareInput, "expiresInDays" | "label">,
  ) => Promise<CreateShareResult>;
  /**
   * Fired once after a link is successfully generated, so the parent can
   * re-fetch its "Enlaces activos" list (a mount-time snapshot otherwise —
   * staging regression O-3).
   */
  onShareCreated?: () => void;
};

type FormState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; shareToken: string };

/**
 * The share lifetimes, FROM THE CONTRACT.
 *
 * This array and the one in `libreta/SharesManager.tsx` were both literals and
 * they DISAGREED: 7/30/null defaulting to 7 here, 7/30/90/null defaulting to 30
 * there. `MergedShareSheet` renders both (lines 156 and 226) and both call the
 * same action, so one sheet offered a person two different menus for one feature
 * depending on which half they had scrolled to — and the server validated
 * neither, because `create-libreta-share.ts` multiplies whatever number it is
 * handed by 86_400_000.
 *
 * Unifying them is a DEFECT FIX rather than a product change: 90 días was
 * already reachable in this very sheet, from the other component. Now
 * `LIBRETA_SHARE_EXPIRY_DAYS` is the one menu — the `MAX_WEIGHT_KG` move — and
 * `@dim/contract/input` refuses anything outside it.
 */
const DURATION_OPTIONS: Array<{ value: string; label: string; days: number | null }> = [
  ...LIBRETA_SHARE_EXPIRY_DAYS.map((days) => ({
    value: String(days),
    label: `${days} días`,
    days: days as number | null,
  })),
  { value: "never", label: "Sin vencimiento", days: null },
];

async function submitShare(
  createAction: Props["createShareAction"],
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const label = (formData.get("label") as string | null) || null;
  const durationValue = formData.get("duration") as string;
  const option = DURATION_OPTIONS.find((o) => o.value === durationValue);
  const expiresInDays = option ? option.days : 7;

  const result = await createAction({ expiresInDays, label: label?.trim() || null });

  if ("error" in result) return { status: "error", message: result.error };
  return { status: "success", shareToken: result.shareToken };
}

export function ShareLibretaSheet({
  petPublicToken,
  petName,
  createShareAction,
  onShareCreated,
}: Props) {
  const boundSubmit = submitShare.bind(null, createShareAction);
  // forms/react19-reset-data-loss-inventory: "label" was a bare uncontrolled
  // input and "duration" a static-defaultChecked radio group — a rejected
  // submit wiped the typed label and fell the duration back to its mount
  // default (7 días), discarding whatever the person had actually picked.
  const { boundAction, kept, keptChecked } = useKeptFields<FormState>(boundSubmit);
  const [state, formAction, isPending] = useActionState<FormState, FormData>(boundAction, {
    status: "idle",
  });

  useEffect(() => {
    if (state.status === "success") onShareCreated?.();
  }, [state, onShareCreated]);

  if (state.status === "success") {
    const shareUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/libreta/compartir/${state.shareToken}`;
    return (
      <div className="space-y-6">
        <p className="text-sm text-[var(--color-ln-ink-2)]">El link está listo para compartir.</p>

        <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-ok)] bg-[var(--color-ln-ok-050)] p-4 space-y-3">
          <p className="text-xs uppercase tracking-wider font-semibold text-[var(--color-ln-ok)]">
            Link generado
          </p>
          <p className="text-sm font-ln-mono break-all text-[var(--color-ln-ink)]">{shareUrl}</p>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(shareUrl)}
            className="w-full px-4 py-2 rounded-[var(--radius-pill)] bg-[var(--color-ln-ok)] hover:opacity-90 text-white text-sm font-medium"
          >
            Copiar link
          </button>
        </div>

        <p className="text-xs text-[var(--color-ln-mute)] text-center">
          Podés ver y revocar todos tus links compartidos más abajo, en esta misma pantalla.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-5">
      <p className="text-sm text-[var(--color-ln-ink-2)]">
        Generá un link privado para que otra persona vea la libreta sanitaria de {petName}. Podés
        revocarlo en cualquier momento.
      </p>

      {/* Label field */}
      <LnField label="Para qué es este link">
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="label"
            type="text"
            defaultValue={kept("label")}
            placeholder="Ej: Vet de cabecera, Guardería, Viaje"
            maxLength={LIBRETA_SHARE_LABEL_MAX}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      {/* Duration radio */}
      <fieldset className="space-y-2">
        <legend className="text-xs uppercase tracking-wider font-semibold text-[var(--color-ln-mute)] mb-1.5">
          Vencimiento
        </legend>
        {DURATION_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className="flex items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] px-4 py-3 cursor-pointer has-[:checked]:border-[var(--color-ln-ok)] has-[:checked]:bg-[var(--color-ln-ok-050)]"
          >
            <input
              type="radio"
              name="duration"
              value={opt.value}
              defaultChecked={keptChecked("duration", opt.value === "7", opt.value)}
              className="h-4 w-4"
            />
            <span className="text-sm font-medium text-[var(--color-ln-ink)]">{opt.label}</span>
          </label>
        ))}
      </fieldset>

      {state.status === "error" && (
        <p className="text-sm text-[var(--color-ln-err)]">{state.message}</p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full px-4 py-3 rounded-[var(--radius-pill)] bg-[var(--color-ln-ok)] hover:opacity-90 disabled:opacity-60 text-white font-medium"
      >
        {isPending ? "Generando…" : "Generar link"}
      </button>
    </form>
  );
}
