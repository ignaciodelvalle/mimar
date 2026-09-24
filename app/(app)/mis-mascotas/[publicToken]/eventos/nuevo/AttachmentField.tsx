/**
 * AttachmentField — Libreta Nacional file-drop for event forms.
 *
 * Redesigned with LN document aesthetic:
 *  - dashed border (line-strong)
 *  - stripe background
 *  - mono "opcional" label
 *  - paperclip icon glyph
 *
 * Field name ("attachment") and accept ("image/*") are unchanged.
 * The label, input id, hint text are preserved exactly.
 */
export function AttachmentField() {
  return (
    <div className="flex flex-col gap-[5px]">
      <span className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
        Foto adjunta{" "}
        <span className="font-normal lowercase tracking-[.04em] text-[var(--color-ln-faint)]">
          opcional
        </span>
      </span>
      <label
        htmlFor="attachment"
        className="flex cursor-pointer items-center justify-center gap-[9px] rounded-[var(--radius-md)] border-[1.5px] border-dashed border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] px-4 py-4 text-sm text-[var(--color-ln-mute)] transition-colors hover:bg-[var(--color-ln-line-2)]"
      >
        {/* Paperclip */}
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
        <span>Elegir imagen adjunta — hasta 5 MB</span>
      </label>
      <input id="attachment" name="attachment" type="file" accept="image/*" className="sr-only" />
      <p className="font-ln-mono text-sm leading-[1.45] text-[var(--color-ln-mute)]">
        Imagen de hasta 5 MB. Por ejemplo: carnet, receta, o foto del momento.
      </p>
    </div>
  );
}
