"use client";

// Step 5 — Cerrar: anónima vs con contacto + evidencia + submit.
// Two cards: "Anónima" (submit immediately) vs "Con contacto" (collect email/phone then submit).
// Evidence uploader: optional multi-file input with client-side mime/size/count validation
// and image preview thumbnails. Files are lifted into WizardState (evidenceFiles) so the
// wizard's handleSubmit can append them to FormData before calling createWelfareReportAction.

import { useRef } from "react";

import { Icon } from "@/components/Icon";
import { LnInput } from "@/components/ui/Field";
import { heicRefusalMessage, isDeclaredHeic } from "@/lib/media/heic";

export type ContactMode = "anonymous" | "with_contact";

export type EvidenceFile = {
  file: File;
  /** Object URL for image previews; null for video files. */
  objectUrl: string | null;
};

const MAX_EVIDENCE_FILES = 5;
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024; // 25 MB
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

type Step5ContactProps = {
  contactMode: ContactMode | null;
  contactEmail: string;
  contactPhone: string;
  evidenceFiles: EvidenceFile[];
  evidenceError: string | null;
  onContactModeChange: (mode: ContactMode) => void;
  onContactEmailChange: (email: string) => void;
  onContactPhoneChange: (phone: string) => void;
  onEvidenceFilesChange: (files: EvidenceFile[]) => void;
  onEvidenceErrorChange: (error: string | null) => void;
  onSubmit: () => void;
  isPending: boolean;
  error?: string | null;
};

export function Step5Contact({
  contactMode,
  contactEmail,
  contactPhone,
  evidenceFiles,
  evidenceError,
  onContactModeChange,
  onContactEmailChange,
  onContactPhoneChange,
  onEvidenceFilesChange,
  onEvidenceErrorChange,
  onSubmit,
  isPending,
  error,
}: Step5ContactProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canSubmitAnonymous = contactMode === "anonymous";
  const canSubmitWithContact =
    contactMode === "with_contact" &&
    (contactEmail.trim().length > 0 || contactPhone.trim().length > 0);

  const canSubmit = canSubmitAnonymous || canSubmitWithContact;

  function handleFilesSelected(incoming: FileList | null) {
    if (!incoming || incoming.length === 0) return;
    onEvidenceErrorChange(null);

    const newFiles = Array.from(incoming);
    const combined = [...evidenceFiles.map((e) => e.file), ...newFiles];

    if (combined.length > MAX_EVIDENCE_FILES) {
      onEvidenceErrorChange(`Solo podés adjuntar hasta ${MAX_EVIDENCE_FILES} archivos en total.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    for (const f of newFiles) {
      if (isDeclaredHeic(f)) {
        onEvidenceErrorChange(heicRefusalMessage(f.name));
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      if (!ALLOWED_EVIDENCE_MIME.has(f.type)) {
        onEvidenceErrorChange(
          `Tipo de archivo no soportado: "${f.name}". Solo imágenes (JPG, PNG, WebP, GIF) y videos (MP4, WebM, MOV).`,
        );
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      if (f.size > MAX_EVIDENCE_BYTES) {
        onEvidenceErrorChange(`El archivo "${f.name}" supera el límite de 25 MB.`);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
    }

    const added: EvidenceFile[] = newFiles.map((f) => ({
      file: f,
      objectUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
    }));
    onEvidenceFilesChange([...evidenceFiles, ...added]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeEvidence(index: number) {
    const entry = evidenceFiles[index];
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    onEvidenceFilesChange(evidenceFiles.filter((_, i) => i !== index));
    onEvidenceErrorChange(null);
  }

  return (
    <section className="space-y-5">
      <div className="space-y-1">
        <h1
          className="text-2xl font-semibold tracking-tight text-[var(--color-ln-ink)]"
          style={{ fontFamily: "var(--font-ln-serif)" }}
        >
          ¿Cómo querés enviarla?
        </h1>
        <p className="text-sm text-[var(--color-ln-mute)]">
          Podés enviar sin dar ningún dato personal.
        </p>
      </div>

      {/* Mode cards */}
      <div className="space-y-3">
        {/* Anonymous card — B-5: aria-pressed reflects selection state */}
        <button
          type="button"
          onClick={() => onContactModeChange("anonymous")}
          aria-pressed={contactMode === "anonymous"}
          className={`w-full text-left rounded-[var(--radius-md)] border px-4 py-3.5 transition-colors ${
            contactMode === "anonymous"
              ? "border-[var(--color-ln-azul)] bg-[var(--color-ln-celeste-050)] shadow-[inset_0_0_0_1px_var(--color-ln-azul)]"
              : "border-[var(--color-ln-line)] bg-[var(--color-ln-card)] hover:border-[var(--color-ln-line-strong)]"
          }`}
        >
          <span className="flex items-center gap-3">
            <span className="flex-shrink-0 w-6 flex items-center justify-center text-[var(--color-ln-mute)]">
              <Icon name="anonimo" size="md" decorative />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold text-[var(--color-ln-ink)]">
                Enviar anónima
              </span>
              <span className="block text-xs text-[var(--color-ln-mute)] mt-0.5">
                Sin datos de contacto. El código DEN-XXXX es tu única forma de seguimiento.
              </span>
            </span>
            <span
              className={`flex-shrink-0 w-[18px] h-[18px] rounded-full border-2 ml-auto ${
                contactMode === "anonymous"
                  ? "border-[var(--color-ln-azul)] bg-[var(--color-ln-azul)] shadow-[inset_0_0_0_3px_white]"
                  : "border-[var(--color-ln-line-strong)]"
              }`}
              aria-hidden="true"
            />
          </span>
        </button>

        {/* With contact card — B-5: aria-pressed reflects selection state */}
        <button
          type="button"
          onClick={() => onContactModeChange("with_contact")}
          aria-pressed={contactMode === "with_contact"}
          className={`w-full text-left rounded-[var(--radius-md)] border px-4 py-3.5 transition-colors ${
            contactMode === "with_contact"
              ? "border-[var(--color-ln-azul)] bg-[var(--color-ln-celeste-050)] shadow-[inset_0_0_0_1px_var(--color-ln-azul)]"
              : "border-[var(--color-ln-line)] bg-[var(--color-ln-card)] hover:border-[var(--color-ln-line-strong)]"
          }`}
        >
          <span className="flex items-center gap-3">
            <span className="flex-shrink-0 w-6 flex items-center justify-center text-[var(--color-ln-mute)]">
              <Icon name="telefono" size="md" decorative />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold text-[var(--color-ln-ink)]">
                Sumar mi contacto (más útil)
              </span>
              <span className="block text-xs text-[var(--color-ln-mute)] mt-0.5">
                Email o teléfono. Sin DNI. El equipo puede contactarte para más info.
              </span>
            </span>
            <span
              className={`flex-shrink-0 w-[18px] h-[18px] rounded-full border-2 ml-auto ${
                contactMode === "with_contact"
                  ? "border-[var(--color-ln-azul)] bg-[var(--color-ln-azul)] shadow-[inset_0_0_0_3px_white]"
                  : "border-[var(--color-ln-line-strong)]"
              }`}
              aria-hidden="true"
            />
          </span>
        </button>
      </div>

      {/* Contact fields — shown when mode is with_contact */}
      {contactMode === "with_contact" && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] p-4 space-y-4">
          <p className="text-xs text-[var(--color-ln-ink-2)] leading-relaxed">
            Tu contacto es anónimo en el sentido de que no pedimos DNI ni nombre. Solo para que
            podamos avisarte si avanza la denuncia.
          </p>
          <div className="space-y-1.5">
            <label
              htmlFor="reporterContactPhone"
              className="block text-xs font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)]"
              style={{ fontFamily: "var(--font-ln-mono)" }}
            >
              Teléfono (preferido)
            </label>
            <LnInput
              id="reporterContactPhone"
              name="reporterContactPhone"
              type="tel"
              placeholder="+54 11 1234-5678"
              value={contactPhone}
              onChange={(e) => onContactPhoneChange(e.target.value)}
              autoComplete="tel"
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="reporterContactEmail"
              className="block text-xs font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)]"
              style={{ fontFamily: "var(--font-ln-mono)" }}
            >
              Email (alternativo)
            </label>
            <LnInput
              id="reporterContactEmail"
              name="reporterContactEmail"
              type="email"
              placeholder="tu@email.com"
              value={contactEmail}
              onChange={(e) => onContactEmailChange(e.target.value)}
              autoComplete="email"
            />
          </div>
          {contactMode === "with_contact" &&
            contactEmail.trim().length === 0 &&
            contactPhone.trim().length === 0 && (
              <p className="text-xs text-[var(--color-ln-warn)]">
                Completá al menos un dato de contacto, o cambiá a "Enviar anónima".
              </p>
            )}
        </div>
      )}

      {/* Evidence uploader — multi-file with client-side validation.
          Files are lifted into WizardState.evidenceFiles and appended to FormData
          in DenunciaWizard.handleSubmit. The file input is cleared after each
          selection to allow incremental adds (same pattern as WelfareReportForm). */}
      <div className="space-y-3 rounded-[var(--radius-md)] border border-dashed border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-[var(--color-ln-ink)]">
            <Icon name="adjuntar" size="sm" decorative className="inline align-text-bottom mr-1" />
            Sumar fotos o videos{" "}
            <span className="font-normal text-[var(--color-ln-mute)]">(opcional)</span>
          </span>
          {evidenceFiles.length > 0 && (
            <span
              className="text-xs text-[var(--color-ln-mute)]"
              style={{ fontFamily: "var(--font-ln-mono)" }}
            >
              {evidenceFiles.length}/{MAX_EVIDENCE_FILES}
            </span>
          )}
        </div>

        <p className="text-xs text-[var(--color-ln-mute)]">
          Hasta {MAX_EVIDENCE_FILES} archivos, 25 MB cada uno. Imágenes (JPG, PNG, WebP, GIF) y
          videos (MP4, WebM, MOV).
        </p>

        {/* File input — cleared after each selection to allow incremental adds */}
        {/* B-1: explicit label for the file input */}
        <label htmlFor="evidenceFiles" className="sr-only">
          Adjuntar fotos o videos como evidencia (opcional)
        </label>
        <input
          ref={fileInputRef}
          id="evidenceFiles"
          type="file"
          multiple
          accept="image/*,video/mp4,video/webm,video/quicktime"
          capture="environment"
          onChange={(e) => handleFilesSelected(e.target.files)}
          className="block w-full text-xs text-[var(--color-ln-ink-2)] file:mr-3 file:px-3 file:py-1.5 file:rounded-[var(--radius-sm)] file:border-0 file:bg-[var(--color-ln-stripe)] file:text-[var(--color-ln-ink)] file:cursor-pointer"
        />

        {evidenceError && (
          <p className="text-xs text-[var(--color-ln-seal)]" role="alert">
            {evidenceError}
          </p>
        )}

        {evidenceFiles.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {evidenceFiles.map((entry, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable list, no reordering
              <div key={i} className="relative group">
                {entry.objectUrl ? (
                  <img
                    src={entry.objectUrl}
                    alt={entry.file.name}
                    className="w-full aspect-square object-cover rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)]"
                  />
                ) : (
                  <div className="w-full aspect-square rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] flex flex-col items-center justify-center gap-1 p-2 text-[var(--color-ln-mute)]">
                    <Icon name="reproducir" size={24} decorative />
                    <p className="text-xs text-[var(--color-ln-mute)] text-center truncate w-full">
                      {entry.file.name}
                    </p>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removeEvidence(i)}
                  aria-label={`Quitar ${entry.file.name}`}
                  // Always visible, 24px. It used to be opacity-0 until hover,
                  // which on a touch screen means it never appears at all —
                  // `(hover: none)` never fires `:hover`, so the only way to
                  // detach a file was a keyboard focus no phone has. At 20px it
                  // was also under the 24px WCAG 2.5.8 AA target-size floor this
                  // repo holds buttons to (adversarial review 2026-08-08,
                  // S1-F04; same markup in WelfareReportForm and DecomisoForm).
                  className="absolute top-1 right-1 w-6 h-6 rounded-full bg-[var(--color-ln-ink)] text-white text-xs leading-none flex items-center justify-center"
                >
                  <Icon name="close" size="sm" decorative />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && (
        <p
          className="text-sm text-[var(--color-ln-seal)] rounded-[var(--radius-sm)] bg-[var(--color-ln-err-050)] border border-[var(--color-ln-err-100)] px-3 py-2"
          role="alert"
        >
          {error}
        </p>
      )}

      {/* Submit button */}
      {contactMode && (
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit || isPending}
          className="w-full px-4 py-[13px] rounded-[var(--radius-md)] bg-[var(--color-ln-azul)] text-white font-semibold text-sm hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isPending ? "Enviando denuncia…" : "Enviar denuncia →"}
        </button>
      )}

      {/* Liability notice. Two sentences that have to coexist: the reader is
          usually someone who just saw an animal being hurt and is afraid of
          getting it wrong, so the good-faith reassurance stays FIRST and stays
          the louder of the two. But a denuncia names a person who has not been
          investigated and cannot answer, and a knowingly false one is not a
          mistake — it exposes the reporter civilly and criminally. Saying so is
          part of what makes the accusation worth taking seriously. */}
      <div className="space-y-1.5 text-xs text-[var(--color-ln-mute)] text-center leading-relaxed">
        <p>
          Al enviar confirmás que lo que describiste es lo que viste. No se requiere certeza — solo
          buena fe.
        </p>
        <p>
          Una denuncia falsa hecha a sabiendas no es un error de buena fe: puede hacerte responsable
          civil y penalmente.
        </p>
      </div>
    </section>
  );
}
