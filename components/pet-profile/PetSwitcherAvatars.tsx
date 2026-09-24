"use client";

// PetSwitcherAvatars — app-level navigation between the owner's LIVE pets, as an
// overlapping avatar group (red-team-admin-2, PO "reemplazo total" of the dots).
//
// Replaces PetSwitcherDots: same slot (above the credential card, app-level, PO
// 2026-07-18), same ranked/capped set, same tap-to-navigate. The upgrade over
// anonymous dots is IDENTITY + STATE + a visible cap: you recognise each pet by
// its photo (species-fallback via LnPetPhoto), see its status badge (lost = red)
// at a glance, and the "+N" chip makes the household cap visible (it was
// screen-reader-only on the dots). Discreet + floating, like the dots it
// replaces — small overlapping avatars, the current one ringed.
//
// Owner-only chrome (the caller gates with shouldShowCarousel). A bare avatar
// with no photo falls back to LnPetPhoto's placeholder, never a broken image.

import { useRouter } from "next/navigation";

import type { LnPetStatus } from "@/components/ui/Chip";
import { LnPetPhoto } from "@/components/ui/RegRow";

export type AvatarSwitcherPet = {
  token: string;
  status: LnPetStatus;
  /** Pet name — the avatar's accessible label. */
  name: string;
  /** Resolved photo URL, or null → LnPetPhoto's placeholder. */
  photoUrl: string | null;
};

export function PetSwitcherAvatars({
  pets,
  currentToken,
  liveTotal,
}: {
  /** Ranked, capped live pets (urgent-first) — one avatar each, in this order. */
  pets: AvatarSwitcherPet[];
  currentToken: string;
  /** Total live pets in the household; when it exceeds the shown count, a "+N" chip discloses the cap. */
  liveTotal?: number;
}) {
  const router = useRouter();

  const total = pets.length;
  const householdTotal = liveTotal ?? total;
  const hiddenCount = Math.max(0, householdTotal - total);
  const groupLabel =
    hiddenCount > 0 ? `Tus mascotas: mostrando ${total} de ${householdTotal}` : "Tus mascotas";

  return (
    <nav aria-label={groupLabel} data-testid="pet-carousel-avatars" className="ln-pet-switcher">
      <ul className="flex items-center justify-center">
        {pets.map((p, i) => {
          const isCurrent = p.token === currentToken;
          return (
            <li key={p.token} className={i > 0 ? "-ml-2" : ""}>
              <button
                type="button"
                onClick={() => {
                  if (!isCurrent) router.push(`/mis-mascotas/${p.token}`);
                }}
                aria-current={isCurrent ? "true" : undefined}
                aria-label={`${p.name} — mascota ${i + 1} de ${total}${isCurrent ? " (actual)" : ""}`}
                data-current={isCurrent ? "true" : undefined}
                className={[
                  "relative block rounded-full transition-transform",
                  isCurrent
                    ? "z-10 scale-110 ring-2 ring-[var(--color-ln-azul)] ring-offset-2 ring-offset-[var(--color-ln-paper)]"
                    : "opacity-75 hover:scale-105 hover:opacity-100",
                ].join(" ")}
              >
                <LnPetPhoto
                  src={p.photoUrl ?? undefined}
                  alt={p.name}
                  status={p.status}
                  size={isCurrent ? 34 : 30}
                />
              </button>
            </li>
          );
        })}
        {hiddenCount > 0 && (
          <li className="-ml-2">
            <span
              aria-hidden="true"
              style={{ width: 30, height: 30 }}
              className="grid place-items-center rounded-full border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] text-xs font-semibold text-[var(--color-ln-mute)]"
            >
              +{hiddenCount}
            </span>
          </li>
        )}
      </ul>
    </nav>
  );
}
