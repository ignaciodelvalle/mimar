"use client";

// MatchConfirmationCard — presented to the actor (refugio or vecino) when a
// microchip cross-check detected a possible match during intake.
//
// Shows the matched pet's public-facing data and offers two actions:
//   "Es la misma mascota" → confirmChipMatchAction(decision='same')
//   "No es la misma"     → confirmChipMatchAction(decision='not_same')

import Image from "next/image";
import { useState, useTransition } from "react";

import { confirmChipMatchAction } from "@/app/actions/chip-match";
import { OpBreach, OpButton, OpPill } from "@/components/ui/dashboard";
import { AR_TIME_ZONE, speciesLabel } from "@/lib/utils/format";
import { useRouter } from "next/navigation";

type Props = {
  matchedPetToken: string;
  petName: string;
  petSpecies: string | null;
  petBreed: string | null;
  petColor: string | null;
  petSex: string | null;
  petPhotoUrl: string | null;
  ownerFirstName: string | null;
  lastLocationText: string | null;
  lastLocationDate: string | null;
  // Routing after decision
  actorMode: "refugio" | "vecino";
  orgToken?: string; // required when actorMode='refugio'
  // HMAC intake-match claim binding (orgToken, matchedPetToken). Required for
  // the refugio path — forwarded to the action so the writer can re-verify the
  // org-scoped claim before mutating (review 24 HIGH #7).
  claim?: string;
  // Where to go after confirmation
  successRedirect: string;
  cancelRedirect: string;
};

export function MatchConfirmationCard({
  matchedPetToken,
  petName,
  petSpecies,
  petBreed,
  petColor,
  petSex,
  petPhotoUrl,
  ownerFirstName,
  lastLocationText,
  lastLocationDate,
  actorMode,
  orgToken,
  claim,
  successRedirect,
  cancelRedirect,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleDecision(decision: "same" | "not_same") {
    startTransition(async () => {
      setError(null);
      const result = await confirmChipMatchAction({
        matchedPetToken,
        actorMode,
        orgToken,
        claim,
        decision,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.push(decision === "same" ? successRedirect : cancelRedirect);
    });
  }

  const speciesLine = [petSpecies ? speciesLabel(petSpecies) : null, petBreed]
    .filter(Boolean)
    .join(", ");
  const details = [petColor, petSex ? sexLabel(petSex) : null].filter(Boolean).join(" · ");

  return (
    <div className="space-y-6">
      <OpBreach
        title="Posible coincidencia detectada"
        detail="El microchip ya figura en miMAR asociado a la siguiente mascota."
      />

      <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card overflow-hidden">
        {petPhotoUrl && (
          <div className="relative aspect-video overflow-hidden bg-ln-op-stripe">
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
            <h2 className="text-lg font-semibold text-ln-op-ink">{petName}</h2>
            {speciesLine && <p className="text-md text-ln-op-ink-2">{speciesLine}</p>}
            {details && <p className="text-sm text-ln-op-mute">{details}</p>}
          </div>

          <div className="flex items-center gap-2">
            <OpPill tone="danger">Perdida</OpPill>
          </div>

          {ownerFirstName && (
            <p className="text-md text-ln-op-ink">
              <span className="text-ln-op-mute">Dueño/a: </span>
              <span className="font-medium">{ownerFirstName}</span>
            </p>
          )}

          {lastLocationText && (
            <p className="text-md text-ln-op-ink">
              <span className="text-ln-op-mute">Última ubicación conocida: </span>
              <span>{lastLocationText}</span>
              {lastLocationDate && (
                <span className="text-ln-op-mute ml-1">
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
        <p className="rounded-[var(--radius-md)] border border-ln-op-danger bg-ln-op-danger/10 px-3 py-2 text-md text-ln-op-danger">
          {error}
        </p>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <OpButton
          type="button"
          disabled={isPending}
          onClick={() => handleDecision("same")}
          className="flex-1"
        >
          {isPending ? "Procesando..." : "Es la misma mascota"}
        </OpButton>
        <OpButton
          type="button"
          variant="ghost"
          disabled={isPending}
          onClick={() => handleDecision("not_same")}
          className="flex-1"
        >
          {isPending ? "Procesando..." : "No es la misma"}
        </OpButton>
      </div>

      <p className="text-sm text-ln-op-mute">
        Si es la misma mascota, se notificará al dueño/a para coordinar la devolución. Si no es la
        misma, esta acción queda registrada y podés continuar el ingreso normalmente.
      </p>
    </div>
  );
}

// Helper: simple sex label without importing the full format module on the client
function sexLabel(sex: string) {
  if (sex === "male") return "Macho";
  if (sex === "female") return "Hembra";
  return null;
}
