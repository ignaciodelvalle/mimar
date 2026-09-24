"use client";

// PetSubView — read-only projection of the pet linked to a denuncia (task #12,
// second inspector level). Fed by GET /api/gob/mascotas/[token], which enforces
// the linking-case jurisdiction gate. Purely presentational: identity,
// species/sex/status, microchip, owner-of-record, open cases. NO edit
// affordances — an operator reaches a pet only through a welfare nexus and only
// to read it.

import Link from "next/link";

import { OpCard, OpCardBody, OpCardHead, OpPill } from "@/components/ui/dashboard";
import type { GobPetSubView } from "@/lib/infra/gob-pet-subview";
import { formatDate, situationLabelForSex, speciesLabel, statusLabel } from "@/lib/utils/format";
import { caseKindLabel } from "@/src/modules/cases/domain/case-kinds";

// Antes: `{ dog: "Perro", cat: "Gato" }` con `?? pet.species` de fallback. Ese
// mapa cubría DOS de las seis especies, así que un conejo, un cobayo, un hurón
// o una "otra" llegaban a la pantalla del inspector como el enum crudo —
// exactamente la fuga que el fence de especies existe para prevenir.
// speciesLabel cubre las seis y es la única fuente.
const SEX_LABEL: Record<string, string> = { male: "Macho", female: "Hembra", unknown: "Sin dato" };

export function PetSubView({ pet }: { pet: GobPetSubView }) {
  return (
    <div className="space-y-4">
      <OpCard>
        <OpCardHead title={pet.name || "Mascota"} />
        <OpCardBody className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Token" value={pet.publicToken} mono />
            <Field label="Especie" value={speciesLabel(pet.species)} />
            <Field label="Sexo" value={SEX_LABEL[pet.sex] ?? pet.sex} />
            <Field label="Estado" value={situationLabelForSex(statusLabel(pet.status), pet.sex)} />
            {pet.breed && <Field label="Raza" value={pet.breed} />}
            {pet.color && <Field label="Color" value={pet.color} />}
          </div>
          {(pet.jurisdictionLocality || pet.jurisdictionProvince) && (
            <p className="text-xs text-ln-op-mute">
              {[pet.jurisdictionLocality, pet.jurisdictionProvince].filter(Boolean).join(", ")}
            </p>
          )}
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead title="Microchip" />
        <OpCardBody>
          {pet.microchipCode ? (
            <p className="font-ln-mono text-sm text-ln-op-ink">{pet.microchipCode}</p>
          ) : (
            <p className="text-sm text-ln-op-mute">Sin microchip activo registrado.</p>
          )}
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead title="Titular registrado" />
        <OpCardBody>
          <p className="text-sm text-ln-op-ink">
            {pet.ownerOfRecord ?? <span className="text-ln-op-mute">Sin titular registrado.</span>}
          </p>
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead title={`Casos abiertos (${pet.openCases.length})`} />
        <OpCardBody>
          {pet.openCases.length === 0 ? (
            <p className="text-sm text-ln-op-mute">No hay casos abiertos para esta mascota.</p>
          ) : (
            <ul className="space-y-2">
              {pet.openCases.map((c) => (
                <li key={c.id}>
                  {/* publicCode, not the uuid: /gob/casos/[publicCode] resolves
                      via getCaseDetailByPublicCode and notFound()s on a miss.
                      The row already prints the right code two lines down, so
                      the operator was reading a valid case number next to a
                      button that went nowhere. */}
                  <Link
                    href={`/gob/casos/${c.publicCode}`}
                    prefetch={false}
                    className="flex items-baseline justify-between gap-3 rounded-[var(--radius-md)] border border-ln-op-line px-3 py-2 hover:bg-ln-op-stripe"
                  >
                    <span className="min-w-0">
                      <span className="font-ln-mono text-xs text-ln-op-ink-2">{c.publicCode}</span>
                      <span className="ml-2 text-sm text-ln-op-ink">
                        {caseKindLabel(c.caseKind)}
                      </span>
                    </span>
                    <OpPill tone="neutral">{formatDate(c.openedAt)}</OpPill>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </OpCardBody>
      </OpCard>
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs uppercase tracking-wider text-ln-op-mute">{label}</p>
      <p className={`text-sm text-ln-op-ink ${mono ? "font-ln-mono" : ""}`}>{value}</p>
    </div>
  );
}
