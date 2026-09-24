import type { ReactNode } from "react";
import type { LnPetStatus } from "./Chip";
import { LnPetPhoto } from "./RegRow";
import { LnStatusFlag } from "./StatusFlag";

/**
 * Libreta Nacional Hero — pet profile blue band.
 *
 * Structure:
 *  - Azul-900 → azul → celeste diagonal gradient band (86px tall) with
 *    diagonal texture overlay and "LIBRETA SANITARIA NACIONAL" watermark
 *  - Photo (132px, radius-6) overlapping the band by 50px
 *  - Name (serif 32px) + status flag
 *  - Breed text
 *  - Tags row (microchip, sterilized, location, etc.)
 *  - Action buttons (right side)
 */

export type LnHeroTag = {
  key: string;
  label: string;
  icon?: ReactNode;
  variant?: "celeste" | "gray";
};

export type LnHeroProps = {
  name: string;
  status?: LnPetStatus;
  /** The animal's sex — the status flag inflects on it ("PERDIDA", not "PERDIDO"). */
  sex?: string | null;
  breed?: string;
  photoSrc?: string;
  /**
   * When there is NO photo, makes the placeholder a link that starts adding
   * one. Pass only for a viewer who can actually edit this pet — the hero also
   * renders for read-only viewers, and offering an action they cannot take is
   * worse than offering none. See LnPetPhoto.addPhotoHref.
   */
  addPhotoHref?: string;
  tags?: LnHeroTag[];
  actions?: ReactNode;
  className?: string;
};

export function LnHero({
  name,
  status = "ok",
  sex,
  breed,
  photoSrc,
  addPhotoHref,
  tags = [],
  actions,
  className = "",
}: LnHeroProps) {
  return (
    <div
      className={[
        "mb-6 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Blue gradient band */}
      <div
        className="relative h-[86px]"
        style={{
          background:
            "repeating-linear-gradient(135deg,rgba(255,255,255,.5) 0 1px,transparent 1px 9px)," +
            "linear-gradient(120deg,var(--color-ln-azul-900),var(--color-ln-azul) 60%,var(--color-ln-celeste))",
        }}
        aria-hidden="true"
      >
        {/* Watermark */}
        <span className="absolute bottom-[8px] right-[16px] font-ln-mono text-xs uppercase tracking-[.24em] text-white/60">
          LIBRETA SANITARIA NACIONAL
        </span>
      </div>

      {/* Main content — UX 3.5 item 4: only the PHOTO overlaps the band (via its
          own negative margin); the text column stays fully below the band so the
          dark serif name never sits over the patterned band (legibility). The
          old row-level marginTop pulled the name up into the band when breed +
          wrapping tags made the text column tall. */}
      <div className="flex items-end gap-[22px] px-6 pb-[22px]">
        {/* Photo overlapping band (pokes 50px up into the band) */}
        <div className="-mt-[50px] flex-shrink-0">
          <LnPetPhoto
            src={photoSrc}
            alt={name}
            status={status}
            size={132}
            radius="md"
            addPhotoHref={addPhotoHref}
            addPhotoLabel={name}
          />
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1 pb-1">
          <div className="flex flex-wrap items-center gap-3.5">
            <h1 className="m-0 font-ln-serif text-4xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
              {name}
            </h1>
            {status && <LnStatusFlag status={status} sex={sex} />}
          </div>

          {breed && <p className="mt-[3px] text-md text-[var(--color-ln-mute)]">{breed}</p>}

          {tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-[7px]">
              {tags.map((tag) => {
                const isCeleste = tag.variant !== "gray";
                return (
                  <span
                    key={tag.key}
                    className={[
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-sm font-medium",
                      isCeleste
                        ? "border-[var(--color-ln-celeste-100)] bg-[var(--color-ln-celeste-050)] text-[var(--color-ln-azul-700)]"
                        : "border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] text-[var(--color-ln-ink-2)]",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {tag.icon}
                    {tag.label}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {/* Actions */}
        {actions && <div className="flex flex-shrink-0 items-end gap-2 pb-2">{actions}</div>}
      </div>
    </div>
  );
}
