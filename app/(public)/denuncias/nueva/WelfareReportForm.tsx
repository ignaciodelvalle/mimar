"use client";

// WelfareReportForm — the org-side welfare denuncia form used at
// /org/[orgToken]/maltrato/nuevo. NOT legacy: it is the current, supported org
// path. The PUBLIC /denuncias/nueva route uses DenunciaWizard instead; this form
// serves the org flow (createOrgWelfareReportAction), which has materially
// different rules — min 100-char description, MANDATORY evidence, severity
// auto-overridden to critical — that don't fit the public wizard.
//
// FOLLOW-UP (deferred, M+ effort — do NOT treat as small): a dedicated org-side
// wizard could eventually replace this single-form UX with a stepped flow. That
// is a genuine feature build, not a refactor: it means re-creating DenunciaWizard's
// whole apparatus (per-step components, WizardShell, step gating) against the
// ORG action and its stricter rules (100-char gate, an evidence step that blocks
// on zero files, authenticated reporter context instead of the anonymous/contact
// modes), plus its own test suite. Until that is scoped and tracked as its own
// task, this form is the intended, maintained org path — extend it here, don't
// leave it implying a quick swap is pending.

import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import Link from "next/link";
import { useActionState, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { LocationFields } from "@/components/LocationFields";
import {
  LnField,
  LnInput,
  LnRadio,
  LnRadioGroup,
  LnSelect,
  LnTextarea,
} from "@/components/ui/Field";
import { heicRefusalMessage, isDeclaredHeic } from "@/lib/media/heic";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import type { WelfareReportFormState } from "@/src/modules/welfare/actions";
import {
  WELFARE_REPORT_KINDS,
  WELFARE_REPORT_SEVERITIES,
  WELFARE_REPORT_SUBJECT_KINDS,
  welfareReportKindLabel,
  welfareReportSeverityLabel,
  welfareReportSubjectKindLabel,
} from "@/src/modules/welfare/domain/types";

const initialState: WelfareReportFormState = { error: null };

type FormAction = (
  prev: WelfareReportFormState,
  formData: FormData,
) => Promise<WelfareReportFormState>;

const MAX_EVIDENCE_FILES = 5;
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
// No HEIC/HEIF: refused by PO decision D4 (lib/media/heic.ts). Leaving them out
// of `accept` below is also what makes iOS Safari hand over a JPEG instead.
const ALLOWED_EVIDENCE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

type EvidenceFile = {
  file: File;
  objectUrl: string | null; // null for videos
};

export function WelfareReportForm({
  action,
  isAnonymous,
  evidenceRequired = false,
  descriptionMinLength = 20,
}: {
  action: FormAction;
  isAnonymous: boolean;
  /**
   * The professional channel (`/org/[t]/maltrato/nuevo`) REQUIRES at least one
   * attachment, and the server enforces it: "Un reporte profesional requiere al
   * menos un adjunto de evidencia." The page header said "Mínimo 1 archivo de
   * evidencia" while this shared field rendered the "opcional" suffix right
   * below it — the same screen contradicting itself (staging clickthrough,
   * 2026-08-13). Not derivable from `isAnonymous`: a logged-in citizen on the
   * public form is also non-anonymous and does NOT owe evidence.
   */
  evidenceRequired?: boolean;
  /**
   * Second instance of the same defect, found 2026-08-20 and fixed the same
   * way. The professional channel rejects a description under 100 characters
   * (welfare/actions.ts:1365) and its page header says exactly that; this
   * shared field rendered `minLength={20}` and a counter reading "(mínimo 20)"
   * directly below that header. The browser submitted happily at 60 characters
   * and the counter told the operator they were well past the bar.
   *
   * A prop, not a derivation from `evidenceRequired`, for the same reason the
   * comment above gives about `isAnonymous`: two rules that happen to coincide
   * today are not one rule, and coupling them means the next channel with a
   * different pair silently inherits the wrong one. The public channel really
   * does allow 20 (welfare/actions.ts:1066), which is the default here.
   */
  descriptionMinLength?: number;
}) {
  const [subjectKind, setSubjectKind] = useState<string>("unowned_animal");
  const [description, setDescription] = useState("");
  const [showContact, setShowContact] = useState(false);

  // Evidence files state
  const [evidenceFiles, setEvidenceFiles] = useState<EvidenceFile[]>([]);
  const evidenceFilesRef = useRef<EvidenceFile[]>([]);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep ref in sync with state so the action closure always reads latest files.
  evidenceFilesRef.current = evidenceFiles;

  // WHAT THE OPERATOR TYPED, kept across a server-side rejection.
  //
  // React 19 automatically resets an uncontrolled form once its action resolves
  // — including when the action RETURNS AN ERROR, which is the case that
  // matters. A welfare report is long: kind, severity, the subject, symptoms,
  // the date. Bouncing on "the description is too short" used to wipe every one
  // of those, so the operator fixed one field and lost five. The same trap is
  // documented on the login form, which solved it by echoing the value back
  // from the server and seeding `defaultValue` with it.
  //
  // This used to be a hand-rolled `submittedRef` + `kept(name)` pair, exactly
  // this shape, lifted verbatim into `lib/ui/use-kept-fields.ts` as the shared
  // hook — see that file's docblock for why one hook and not a sixth
  // reimplementation. It missed the `kind`/`severity` SELECTS (2026-09-22):
  // `defaultValue={kept(name)}` alone does not move a `<select>` on an UPDATE
  // — only a MOUNT does, per the hook's docblock — so both selects fell back to
  // their placeholder on a rejected submit despite carrying `kept()`. Switched
  // to the hook itself for the fix (`keptChecked` also covers `subjectKind`,
  // previously a controlled radio group with the same defect class).
  //
  // The evidence-file append still happens here, wrapping the hook's own
  // `boundAction` rather than the raw action, so the hook still sees every
  // field (including the files it deliberately skips when capturing `kept`).
  const { boundAction: keptBoundAction, kept, keptChecked } = useKeptFields(action);

  function boundAction(prev: WelfareReportFormState, formData: FormData) {
    for (const entry of evidenceFilesRef.current) {
      formData.append("attachment", entry.file);
    }
    return keptBoundAction(prev, formData);
  }

  // useActionState receives boundAction which reads from evidenceFilesRef
  // (always current) and closes over the hook's own boundAction (stable via
  // useCallback) — so the first-render closure stays valid across the
  // component lifetime even as files are added/removed.
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3: the action returns the receipt's URL and this navigates to it. It used
  // to redirect() server-side, a transition the App Router drops in production —
  // which on a maltrato report means it is FILED and the operator sees nothing.
  useActionRedirect(state.redirectTo, state);
  const { key: idempotencyKey } = useIdempotencyKey();

  function handleFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return;
    setEvidenceError(null);

    const incoming = Array.from(files);
    const combined = [...evidenceFilesRef.current.map((e) => e.file), ...incoming];

    if (combined.length > MAX_EVIDENCE_FILES) {
      setEvidenceError(`Solo podés adjuntar hasta ${MAX_EVIDENCE_FILES} archivos en total.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    for (const f of incoming) {
      if (isDeclaredHeic(f)) {
        setEvidenceError(heicRefusalMessage(f.name));
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      if (!ALLOWED_EVIDENCE_MIME.has(f.type)) {
        setEvidenceError(
          `Tipo de archivo no soportado: "${f.name}". Solo imágenes (JPG, PNG, WebP, GIF) y videos (MP4, WebM, MOV).`,
        );
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      if (f.size > MAX_EVIDENCE_BYTES) {
        setEvidenceError(`El archivo "${f.name}" supera el límite de 25 MB.`);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
    }

    const newEntries: EvidenceFile[] = incoming.map((f) => ({
      file: f,
      objectUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
    }));

    setEvidenceFiles((prev) => [...prev, ...newEntries]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeEvidence(index: number) {
    setEvidenceFiles((prev) => {
      const entry = prev[index];
      if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
      return prev.filter((_, i) => i !== index);
    });
    setEvidenceError(null);
  }

  return (
    <form action={formAction} className="space-y-6">
      <input
        type="hidden"
        name="clientIdempotencyKey"
        value={idempotencyKey}
        suppressHydrationWarning
      />
      {isAnonymous && (
        <p className="text-sm text-ln-ink-2 bg-ln-stripe rounded-lg px-4 py-3">
          Estás denunciando de forma anónima. Si querés seguimiento, podés{" "}
          <Link href="/iniciar-sesion" className="underline underline-offset-2 hover:text-ln-ink">
            iniciar sesión
          </Link>{" "}
          o dejar un contacto opcional abajo.
        </p>
      )}

      {/* Kind */}
      <LnField label="Tipo de situación" required>
        {({ id, describedBy, invalid }) => (
          <LnSelect
            key={`kind-${kept("kind")}`}
            id={id}
            name="kind"
            required
            aria-describedby={describedBy}
            invalid={invalid}
            defaultValue={kept("kind")}
          >
            <option value="">Seleccioná una opción</option>
            {WELFARE_REPORT_KINDS.map((k) => (
              <option key={k} value={k}>
                {welfareReportKindLabel(k)}
              </option>
            ))}
          </LnSelect>
        )}
      </LnField>

      {/* Severity */}
      <LnField label="Gravedad" required>
        {({ id, describedBy, invalid }) => (
          <LnSelect
            key={`severity-${kept("severity")}`}
            id={id}
            name="severity"
            required
            aria-describedby={describedBy}
            invalid={invalid}
            defaultValue={kept("severity")}
          >
            <option value="">Seleccioná una opción</option>
            {WELFARE_REPORT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {welfareReportSeverityLabel(s)}
              </option>
            ))}
          </LnSelect>
        )}
      </LnField>

      {/* Description */}
      <LnField
        label="¿Qué pasó?"
        required
        hint={`${description.length} caracteres (mínimo ${descriptionMinLength})`}
      >
        {({ id, describedBy, invalid }) => (
          <LnTextarea
            id={id}
            name="description"
            rows={5}
            required
            minLength={descriptionMinLength}
            placeholder="Contá lo que viste con detalle: cuándo, dónde, quiénes están involucrados, qué condición está el animal…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      {/* Subject kind — RA-9 BR-6: requiredness now reaches assistive tech via
          the LnRadioGroup primitive (role="radiogroup" + aria-required + an
          sr-only "(obligatorio)"), instead of an aria-hidden asterisk only. */}
      <LnRadioGroup
        legend="¿Sobre quién?"
        required
        className="mb-7"
        optionsClassName="space-y-2 mt-1"
      >
        {WELFARE_REPORT_SUBJECT_KINDS.map((sk) => (
          <LnRadio
            key={sk}
            name="subjectKind"
            value={sk}
            defaultChecked={keptChecked("subjectKind", sk === "unowned_animal", sk)}
            onChange={() => setSubjectKind(sk)}
          >
            {welfareReportSubjectKindLabel(sk)}
          </LnRadio>
        ))}
      </LnRadioGroup>

      {/* Conditional subject fields */}
      {subjectKind === "registered_pet" && (
        <LnField label="Código miMAR de la mascota">
          {({ id, describedBy }) => (
            <LnInput
              id={id}
              name="subjectPetToken"
              type="text"
              placeholder="Ej: DIM-XXXX-XXXX"
              aria-describedby={describedBy}
              defaultValue={kept("subjectPetToken")}
            />
          )}
        </LnField>
      )}

      {subjectKind !== "registered_pet" && (
        <LnField
          label={
            subjectKind === "unowned_animal"
              ? "Descripción del animal"
              : subjectKind === "location"
                ? "Descripción del lugar"
                : "Descripción de la situación"
          }
          required
        >
          {({ id, describedBy, invalid }) => (
            <LnTextarea
              id={id}
              name="subjectDescription"
              rows={3}
              required
              placeholder={
                subjectKind === "unowned_animal"
                  ? "Describí al animal: especie aproximada, color, tamaño…"
                  : subjectKind === "location"
                    ? "Describí el lugar: dirección, características…"
                    : "Describí la situación…"
              }
              aria-describedby={describedBy}
              invalid={invalid}
              defaultValue={kept("subjectDescription")}
            />
          )}
        </LnField>
      )}

      {/* Observed symptoms (optional) */}
      <LnField label="¿Notaste síntomas en el animal?">
        {({ id, describedBy }) => (
          <LnTextarea
            id={id}
            name="observedSymptoms"
            rows={3}
            placeholder="Ej: baboso, agresivo, débil, cojeando, con heridas, etc."
            aria-describedby={describedBy}
            defaultValue={kept("observedSymptoms")}
          />
        )}
      </LnField>

      {/* Location */}
      <LocationFields mode="l2" />

      {/* Occurred at */}
      <LnField label="¿Cuándo pasó o desde cuándo viene pasando?">
        {({ id, describedBy }) => (
          <LnInput
            id={id}
            name="occurredAt"
            type="date"
            aria-describedby={describedBy}
            defaultValue={kept("occurredAt")}
          />
        )}
      </LnField>

      {/* Evidence (multimedia) — file input stays native (file:* classes), LnField
          handles label/id/hint wiring; evidenceError surfaces as the field error. */}
      <LnField
        label="Evidencia"
        required={evidenceRequired}
        hint={`${evidenceRequired ? "Al menos 1 archivo. " : ""}Hasta ${MAX_EVIDENCE_FILES} archivos, 25 MB cada uno. Imágenes (JPG, PNG, WebP, GIF) y videos (MP4, WebM, MOV).`}
        error={evidenceError ?? undefined}
      >
        {({ id }) => (
          <>
            <input
              ref={fileInputRef}
              id={id}
              type="file"
              multiple
              accept="image/*,video/mp4,video/webm,video/quicktime"
              onChange={(e) => handleFilesSelected(e.target.files)}
              className="text-sm text-ln-ink-2 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border file:border-ln-line-strong file:bg-ln-card file:text-ln-ink-2 file:text-sm file:cursor-pointer hover:file:bg-ln-stripe"
            />

            {evidenceFiles.length > 0 && (
              <div className="space-y-2 mt-2">
                <p className="text-xs text-ln-mute">
                  {evidenceFiles.length} de {MAX_EVIDENCE_FILES} archivos seleccionados
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {evidenceFiles.map((entry, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable list, no reordering
                    <div key={i} className="relative group">
                      {entry.objectUrl ? (
                        <img
                          src={entry.objectUrl}
                          alt={entry.file.name}
                          className="w-full aspect-square object-cover rounded-lg border border-ln-line"
                        />
                      ) : (
                        <div className="w-full aspect-square rounded-lg border border-ln-line bg-ln-stripe flex flex-col items-center justify-center gap-1 p-2">
                          <Icon name="reproducir" size="lg" decorative className="text-ln-mute" />
                          <p className="text-xs text-ln-mute text-center truncate w-full">
                            {entry.file.name}
                          </p>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => removeEvidence(i)}
                        aria-label={`Quitar ${entry.file.name}`}
                        // Always visible, 24px — see Step5Contact.tsx for the
                        // full reasoning. Hover-only reveal is unreachable on
                        // touch, and 20px is under the 24px AA target floor.
                        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-ln-azul text-white text-xs leading-none flex items-center justify-center"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </LnField>

      {/* Optional contact (collapsible) */}
      <div className="border border-ln-line rounded-lg">
        <button
          type="button"
          onClick={() => setShowContact((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-ln-ink-2 hover:bg-ln-stripe rounded-lg transition-colors"
        >
          <span>Contacto opcional</span>
          <Icon
            name="chevron-right"
            size="sm"
            decorative
            className={`text-ln-mute transition-transform duration-150 ${showContact ? "-rotate-90" : "rotate-90"}`}
          />
        </button>
        {showContact && (
          <div className="px-4 pb-4 space-y-4 border-t border-ln-line pt-4">
            <p className="text-xs text-ln-mute">
              No es obligatorio. Dejás tus datos solo si querés que te contactemos sobre esta
              denuncia.
            </p>
            <LnField label="Email de contacto">
              {({ id, describedBy }) => (
                <LnInput
                  id={id}
                  name="reporterContactEmail"
                  type="email"
                  placeholder="tu@email.com"
                  aria-describedby={describedBy}
                  defaultValue={kept("reporterContactEmail")}
                />
              )}
            </LnField>
            <LnField label="Teléfono de contacto">
              {({ id, describedBy }) => (
                <LnInput
                  id={id}
                  name="reporterContactPhone"
                  type="tel"
                  placeholder="+54 11 1234-5678"
                  aria-describedby={describedBy}
                  defaultValue={kept("reporterContactPhone")}
                />
              )}
            </LnField>
          </div>
        )}
      </div>

      {state.error && (
        <p className="text-sm text-ln-err" role="alert">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full px-4 py-3 rounded-lg bg-ln-azul text-white font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isPending ? "Enviando..." : "Enviar denuncia"}
      </button>
    </form>
  );
}
