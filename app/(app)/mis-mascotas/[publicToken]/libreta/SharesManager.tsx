"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";

import {
  type CreateShareResult,
  createLibretaShareAction,
  revokeLibretaShareAction,
} from "@/app/actions/libreta-share";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LnCheckbox } from "@/components/ui/Field";
import type { LibretaShareToken } from "@/db/schema";
import { notifySaved } from "@/lib/ui/action-feedback";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { AR_TIME_ZONE } from "@/lib/utils/format";
import { LIBRETA_SHARE_EXPIRY_DAYS, LIBRETA_SHARE_LABEL_MAX } from "@dim/contract/input";

type Props = {
  petPublicToken: string;
  shares: LibretaShareToken[];
  /**
   * Fired once after a link is successfully created, so the parent can
   * re-fetch the active-shares list. This component's list is a mirror of the
   * `shares` prop, which is a mount-time snapshot — without a parent re-fetch a
   * newly created link never appears until reload (staging regression O-3).
   */
  onShareCreated?: () => void;
};

/**
 * The share lifetimes, FROM THE CONTRACT.
 *
 * They used to be a literal array here and a DIFFERENT literal array in
 * `_share-libreta/ShareLibretaSheet.tsx` — 7/30/90/null with a 30-day default
 * against 7/30/null with a 7-day default. Both components are rendered by the
 * same `MergedShareSheet` (lines 156 and 226) and both call the same action, so
 * one sheet showed a person two different menus for one feature depending on
 * which half they had scrolled to. Nothing failed, because the server validates
 * none of it: `create-libreta-share.ts` multiplies whatever number it is handed
 * by 86_400_000.
 *
 * `LIBRETA_SHARE_EXPIRY_DAYS` is now the one menu — the `MAX_WEIGHT_KG` move,
 * for the same reason and with the same consequence — and `@dim/contract/input`
 * refuses anything outside it, so a third copy cannot appear without failing.
 */
const DURATION_OPTIONS = [
  ...LIBRETA_SHARE_EXPIRY_DAYS.map((days) => ({
    label: `${days} días`,
    days: days as number | null,
  })),
  { label: "Sin vencimiento", days: null },
] as const;

const initialCreateState: CreateShareResult | null = null;

export function SharesManager({ petPublicToken, shares, onShareCreated }: Props) {
  const [creating, setCreating] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<number | null>(30);
  const [noExpiryConfirmed, setNoExpiryConfirmed] = useState(false);
  const [label, setLabel] = useState("");
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  // The share pending a revoke confirmation — null when the dialog is closed.
  const [confirmingShare, setConfirmingShare] = useState<LibretaShareToken | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [isRevoking, startRevokeTransition] = useTransition();
  // The just-created share token whose "Enlace generado" box has been
  // dismissed — cleared independently of `newShareToken` (which comes from
  // `createState` and can't be reset directly) so revoking that same link
  // also clears its box instead of leaving a dead link on screen.
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const revokeTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Mirrors the `shares` prop but can also be trimmed locally on a
  // successful revoke — revalidatePath() (server action) only refreshes
  // RSC trees, it doesn't touch this already-mounted client component's
  // state, so without this the revoked row + its "Revocar" button stayed
  // live until a hard reload.
  const [localShares, setLocalShares] = useState(shares);

  useEffect(() => {
    setLocalShares(shares);
  }, [shares]);

  // forms/react19-reset-data-loss-inventory: "expiresInDays" is a controlled
  // radio group (`checked={expiresInDays === opt.days}`) — a rejected submit
  // falls it back to its mount value (30 days), discarding whatever
  // duration the person had actually picked.
  const { boundAction: keptCreateAction, keptChecked } = useKeptFields<CreateShareResult | null>(
    async (_prev: CreateShareResult | null, formData: FormData) => {
      const labelVal = (formData.get("label") as string | null)?.trim() || null;
      const daysStr = formData.get("expiresInDays") as string | null;
      const days = daysStr === "null" ? null : daysStr ? Number(daysStr) : 30;
      return createLibretaShareAction({
        petPublicToken,
        expiresInDays: days,
        label: labelVal,
      });
    },
  );
  const [createState, createAction, createPending] = useActionState(
    keptCreateAction,
    initialCreateState,
  );

  // Revoking requires a confirm step (matches the weight-correction
  // double-confirm pattern) so a stray tap can't silently kill a link a vet
  // or family member is actively using. Called from the ConfirmDialog, not
  // straight off the row button click.
  function handleConfirmRevoke() {
    const target = confirmingShare;
    if (!target) return;
    setRevokeError(null);
    startRevokeTransition(async () => {
      const result = await revokeLibretaShareAction(target.id);
      if ("error" in result) {
        setRevokeError(result.error);
        setConfirmingShare(null);
        return;
      }
      setLocalShares((prev) => prev.filter((s) => s.id !== target.id));
      if (newShareToken && target.shareToken === newShareToken) {
        setDismissedToken(newShareToken);
      }
      setConfirmingShare(null);
      // No reload here (revalidatePath alone doesn't touch this already-
      // mounted client list) — the toast is the confirmation (mutation-
      // feedback convention, lib/ui/action-feedback.ts).
      notifySaved("Enlace revocado");
    });
  }

  // On a successful create, ask the parent to re-fetch the active-shares list
  // so the just-generated link shows up in "Enlaces activos" immediately
  // (staging regression O-3). The parent pushing a fresh `shares` prop syncs
  // into localShares via the effect above.
  useEffect(() => {
    if (createState && "shareToken" in createState) onShareCreated?.();
  }, [createState, onShareCreated]);

  function buildShareUrl(token: string): string {
    return `${window.location.origin}/libreta/compartir/${token}`;
  }

  function copyToClipboard(token: string) {
    navigator.clipboard.writeText(buildShareUrl(token)).then(() => {
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    });
  }

  const rawNewShareToken =
    createState && "shareToken" in createState ? createState.shareToken : null;
  // Suppressed once its own share row has been revoked (see handleConfirmRevoke)
  // so the "Enlace generado" box doesn't keep showing a link that no longer works.
  const newShareToken =
    rawNewShareToken && rawNewShareToken !== dismissedToken ? rawNewShareToken : null;
  const createError = createState && "error" in createState ? createState.error : null;

  return (
    <section className="space-y-4 print:hidden">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold text-[var(--color-ln-ink)]">Compartir libreta</h2>
        {!creating && (
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setCopiedToken(null);
            }}
            className="text-xs px-3 py-1.5 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white hover:bg-[var(--color-ln-azul-700)] transition-colors"
          >
            Nuevo enlace
          </button>
        )}
      </div>

      {/* Create form */}
      {creating && (
        <form
          action={createAction}
          className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] p-4"
        >
          <div className="space-y-1">
            <label className="text-xs text-[var(--color-ln-ink-2)]" htmlFor="share-label">
              Etiqueta (opcional)
            </label>
            <input
              id="share-label"
              name="label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Ej: Para Dra. Perez"
              // The sibling sheet capped this at 80 and this one capped it at
              // nothing, over a `text` column with no limit either. One cap,
              // from the contract, for both.
              maxLength={LIBRETA_SHARE_LABEL_MAX}
              className="w-full text-sm rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-3 py-1.5 outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
            />
          </div>

          <fieldset className="space-y-1">
            <legend className="text-xs text-[var(--color-ln-ink-2)]">Duracion</legend>
            <div className="flex flex-wrap gap-2">
              {DURATION_OPTIONS.map((opt) => (
                <label key={String(opt.days)} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="expiresInDays"
                    value={String(opt.days)}
                    defaultChecked={keptChecked(
                      "expiresInDays",
                      expiresInDays === opt.days,
                      String(opt.days),
                    )}
                    onChange={() => {
                      setExpiresInDays(opt.days);
                      if (opt.days !== null) setNoExpiryConfirmed(false);
                    }}
                    className="accent-[var(--color-ln-azul)]"
                  />
                  <span className="text-xs">{opt.label}</span>
                </label>
              ))}
            </div>
            {expiresInDays === null && (
              <LnCheckbox
                checked={noExpiryConfirmed}
                onChange={(e) => setNoExpiryConfirmed(e.target.checked)}
                labelClassName="text-xs! text-[var(--color-ln-warn)]!"
              >
                Confirmo que este enlace no vence nunca
              </LnCheckbox>
            )}
          </fieldset>

          {createError && <p className="text-xs text-[var(--color-ln-err)]">{createError}</p>}

          {newShareToken && (
            <div className="space-y-1">
              <p className="text-xs text-[var(--color-ln-ok)] font-medium">
                Enlace generado. Copia y envialo.
              </p>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={buildShareUrl(newShareToken)}
                  className="flex-1 text-xs font-ln-mono rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-3 py-1.5"
                />
                <button
                  type="button"
                  onClick={() => copyToClipboard(newShareToken)}
                  className="text-xs px-3 py-1.5 rounded-[var(--radius-pill)] border border-[var(--color-ln-line)] hover:bg-[var(--color-ln-stripe)] transition-colors"
                >
                  {copiedToken === newShareToken ? "Copiado" : "Copiar"}
                </button>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={createPending || (expiresInDays === null && !noExpiryConfirmed)}
              className="text-xs px-3 py-1.5 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white hover:bg-[var(--color-ln-azul-700)] transition-colors disabled:opacity-50"
            >
              {createPending ? "Creando..." : "Crear enlace"}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setLabel("");
                setExpiresInDays(30);
                setNoExpiryConfirmed(false);
              }}
              className="text-xs px-3 py-1.5 rounded-[var(--radius-pill)] border border-[var(--color-ln-line)] hover:bg-[var(--color-ln-stripe)] transition-colors"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {/* Active shares list */}
      {localShares.length > 0 ? (
        <ul className="space-y-2">
          {localShares.map((share) => (
            <li
              key={share.id}
              className="flex items-start justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] px-3 py-2.5"
            >
              <div className="space-y-0.5 min-w-0">
                <p className="text-xs font-medium text-[var(--color-ln-ink)] truncate">
                  {share.label ?? "Sin etiqueta"}
                </p>
                <p className="text-xs text-[var(--color-ln-mute)]">
                  {share.expiresAt
                    ? `Vence ${new Date(share.expiresAt).toLocaleDateString("es-AR", { timeZone: AR_TIME_ZONE })}`
                    : "Sin vencimiento"}
                  {" · "}
                  {share.viewCountCached === 0
                    ? "Sin vistas"
                    : `${share.viewCountCached} vista${share.viewCountCached !== 1 ? "s" : ""}`}
                  {share.lastViewedAtCached &&
                    ` · Última: ${new Date(share.lastViewedAtCached).toLocaleDateString("es-AR", { timeZone: AR_TIME_ZONE })}`}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => copyToClipboard(share.shareToken)}
                  className="text-xs px-2 py-1 rounded-[var(--radius-pill)] border border-[var(--color-ln-line)] hover:bg-[var(--color-ln-stripe)] transition-colors"
                >
                  {copiedToken === share.shareToken ? "Copiado" : "Copiar"}
                </button>
                <button
                  type="button"
                  disabled={isRevoking && confirmingShare?.id === share.id}
                  onClick={(e) => {
                    revokeTriggerRef.current = e.currentTarget;
                    setRevokeError(null);
                    setConfirmingShare(share);
                  }}
                  className="text-xs px-2 py-1 rounded-[var(--radius-pill)] border border-[var(--color-ln-seal)] text-[var(--color-ln-seal)] hover:bg-[var(--color-ln-err-050)] transition-colors disabled:opacity-50"
                >
                  Revocar
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        !creating && (
          <p className="text-xs text-[var(--color-ln-mute)]">
            No hay enlaces activos. Crea uno para compartir la libreta.
          </p>
        )
      )}

      {revokeError && <p className="text-xs text-[var(--color-ln-err)]">{revokeError}</p>}

      <ConfirmDialog
        open={confirmingShare !== null}
        onClose={() => setConfirmingShare(null)}
        onConfirm={handleConfirmRevoke}
        title={`¿Revocar el enlace${confirmingShare?.label ? ` "${confirmingShare.label}"` : ""}?`}
        description="Quien lo tenga guardado deja de poder ver la libreta al instante. Esta acción no se puede deshacer."
        confirmLabel="Revocar"
        tone="danger"
        pending={isRevoking}
        triggerRef={revokeTriggerRef}
      />
    </section>
  );
}
