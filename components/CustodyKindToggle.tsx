"use client";

// Custody kind selector — "es mi mascota" (owner) vs "la estoy cuidando"
// (foster_in_transit / vecino en tránsito). Shared by:
//   - components/PetForm.tsx (create mode, only rendered in edit-only routes
//     today — /mis-mascotas/[token]/editar, SheetMounter);
//   - app/(app)/mis-mascotas/nueva/MinimalNewPetForm.tsx (the live citizen
//     alta — restored 2026-07-19 audit: it was the ONLY create path with no
//     custody selector, so every pet defaulted to `owner` and the foster
//     pillar was unreachable).
//
// Split into its own module (rather than importing it out of PetForm.tsx)
// so the high-traffic alta page doesn't pull in PetForm's edit-only lookups
// (insurance companies, allergies, permanent conditions, etc.) just for this
// one toggle.

export function CustodyKindToggle({
  value,
  onChange,
}: {
  value: "owner" | "foster_in_transit";
  onChange: (v: "owner" | "foster_in_transit") => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
        ¿Es tu mascota o la estás cuidando?
      </p>
      <input type="hidden" name="custodyKind" value={value} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <CustodyOptionCard
          checked={value === "owner"}
          onSelect={() => onChange("owner")}
          title="Es mi mascota"
          description="La adoptaste, te la regalaron, la compraste, o ya vive con vos como tuya."
        />
        <CustodyOptionCard
          checked={value === "foster_in_transit"}
          onSelect={() => onChange("foster_in_transit")}
          title="La estoy cuidando"
          description="La encontraste, te la pasó alguien, o la tenés en tránsito."
        />
      </div>
      {value === "foster_in_transit" && (
        <p className="rounded-[var(--radius-sm)] border border-[var(--color-ln-celeste-100)] bg-[var(--color-ln-celeste-050)] px-3 py-2.5 text-sm text-[var(--color-ln-ink-2)]">
          Vas a poder llevarle la libreta sanitaria mientras la cuidás. La información viaja con la
          mascota si aparece su familia o pasa a un refugio.
        </p>
      )}
    </div>
  );
}

function CustodyOptionCard({
  checked,
  onSelect,
  title,
  description,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={checked}
      className={[
        "rounded-[var(--radius-sm)] border p-3 text-left transition-colors",
        checked
          ? "border-[var(--color-ln-azul)] bg-[var(--color-ln-celeste-050)]"
          : "border-[var(--color-ln-line)] bg-[var(--color-ln-card)] hover:bg-[var(--color-ln-stripe)]",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <p className="text-sm font-semibold text-[var(--color-ln-ink)]">{title}</p>
      <p className="mt-0.5 text-xs text-[var(--color-ln-mute)]">{description}</p>
    </button>
  );
}
