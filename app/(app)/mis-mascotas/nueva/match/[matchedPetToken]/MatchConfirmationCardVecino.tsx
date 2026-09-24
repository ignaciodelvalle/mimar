"use client";

// MatchConfirmationCardVecino — same card as refugio but wired to vecino mode.
// Extracted as a thin wrapper so the vecino page can stay a pure server component.

import { confirmChipMatchAction } from "@/app/actions/chip-match";
import { AR_TIME_ZONE, speciesLabel } from "@/lib/utils/format";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Props = {
  matchedPetToken: string;
  /**
   * The code the actor typed into the alta, round-tripped through the page's
   * `?chip=` param. It is this screen's authorization: the confirm action
   * refuses unless it equals the matched pet's canonical chip. Nothing here
   * discloses it — the value originated in this browser one step ago.
   */
  attemptedMicrochipId: string;
  petName: string;
  petSpecies: string | null;
  petBreed: string | null;
  petColor: string | null;
  petSex: string | null;
  petPhotoUrl: string | null;
  ownerFirstName: string | null;
  lastLocationText: string | null;
  lastLocationDate: string | null;
};

export function MatchConfirmationCardVecino({
  matchedPetToken,
  attemptedMicrochipId,
  petName,
  petSpecies,
  petBreed,
  petColor,
  petSex,
  petPhotoUrl,
  ownerFirstName,
  lastLocationText,
  lastLocationDate,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleDecision(decision: "same" | "not_same") {
    startTransition(async () => {
      setError(null);
      const result = await confirmChipMatchAction({
        matchedPetToken,
        actorMode: "vecino",
        attemptedMicrochipId,
        decision,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      if (decision === "same") {
        // Vecino does NOT add the pet; original owner regains visibility.
        router.push("/mis-mascotas");
      } else {
        // Carry the adjudication receipt back to the alta (RA-2 F6).
        //
        // This used to push "?chipMismatched=true" — a flag NOTHING read
        // (nueva/page.tsx takes no props at all), so the vecino landed on a
        // blank form, re-entered the same chip, and was bounced right back to
        // this page. The button promised "podés continuar con el registro" and
        // the flow made that impossible.
        //
        // The receipt is the signed force token; the alta posts it back and
        // createPetAction registers the animal without the disputed code.
        //
        // The code in the return URL is OUR OWN attemptedMicrochipId, not
        // something the server told us. The response used to carry the matched
        // pet's canonical chip, which made this action a nationwide chip oracle
        // for anyone who could name a public token.
        const conflict = "chipConflict" in result ? result.chipConflict : undefined;
        if (conflict) {
          const params = new URLSearchParams({
            chipConflict: conflict.forceToken,
            microchipId: attemptedMicrochipId,
          });
          router.push(`/mis-mascotas/nueva?${params.toString()}`);
        } else {
          router.push("/mis-mascotas/nueva");
        }
      }
    });
  }

  const speciesLine = [petSpecies ? speciesLabel(petSpecies) : null, petBreed]
    .filter(Boolean)
    .join(", ");
  const details = [petColor, petSex ? sexLabel(petSex) : null].filter(Boolean).join(" · ");

  return (
    <div className="space-y-6">
      <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] p-4 space-y-1">
        <p className="text-sm font-semibold text-[var(--color-ln-warn)]">
          Posible coincidencia detectada
        </p>
        <p className="text-sm text-[var(--color-ln-warn)]">
          El microchip que ingresaste ya figura en miMAR asociado a la siguiente mascota.
        </p>
      </div>

      <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] overflow-hidden">
        {petPhotoUrl && (
          <div className="relative aspect-video overflow-hidden bg-[var(--color-ln-stripe)]">
            <Image
              src={petPhotoUrl}
              alt={petName}
              fill
              sizes="(max-width: 768px) 100vw, 600px"
              className="object-cover"
            />
          </div>
        )}
        <div className="p-4 space-y-3">
          <div>
            <h2 className="text-2xl font-semibold">{petName}</h2>
            {speciesLine && <p className="text-sm text-[var(--color-ln-ink-2)]">{speciesLine}</p>}
            {details && <p className="text-sm text-[var(--color-ln-mute)]">{details}</p>}
          </div>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--color-ln-err-050)] text-[var(--color-ln-seal)]">
            Perdida
          </span>
          {ownerFirstName && (
            <p className="text-sm">
              <span className="text-[var(--color-ln-mute)]">Dueño/a: </span>
              <span className="font-medium">{ownerFirstName}</span>
            </p>
          )}
          {lastLocationText && (
            <p className="text-sm">
              <span className="text-[var(--color-ln-mute)]">Última ubicación conocida: </span>
              <span>{lastLocationText}</span>
              {lastLocationDate && (
                <span className="text-[var(--color-ln-mute)] ml-1">
                  (
                  {new Date(lastLocationDate).toLocaleDateString("es-AR", {
                    timeZone: AR_TIME_ZONE,
                  })}
                  )
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      {error && (
        <p className="text-sm rounded-[var(--radius-sm)] border border-[var(--color-ln-seal)] bg-[var(--color-ln-err-050)] px-3 py-2 text-[var(--color-ln-seal)]">
          {error}
        </p>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <button
          type="button"
          disabled={isPending}
          onClick={() => handleDecision("same")}
          className="flex-1 px-4 py-3 rounded-[var(--radius-pill)] bg-[var(--color-ln-ok)] text-white font-medium hover:opacity-90 disabled:opacity-50 transition-colors"
        >
          {isPending ? "Procesando..." : "Es la misma mascota"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => handleDecision("not_same")}
          className="flex-1 px-4 py-3 rounded-[var(--radius-pill)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)] font-medium hover:opacity-80 disabled:opacity-50 transition-colors"
        >
          {isPending ? "Procesando..." : "No es la misma"}
        </button>
      </div>

      <p className="text-xs text-[var(--color-ln-mute)]">
        Si es la misma, no hace falta que la registres: el dueño/a ya la tiene en su cuenta y va a
        ser notificado. Si no es la misma, podés continuar con el registro de tu mascota.
      </p>
    </div>
  );
}

function sexLabel(sex: string) {
  if (sex === "male") return "Macho";
  if (sex === "female") return "Hembra";
  return null;
}
