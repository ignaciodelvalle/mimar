// The composition root for the owner-face reader's cross-module collaborators.
//
// WHY THIS FILE EXISTS, AND WHY IT IS HERE AND NOT IN `src/modules/pets`
// ---------------------------------------------------------------------------
// The owner face needs three things that belong to OTHER modules: caretaker
// state, rehome state, and the surveillance predicate for whether a rabies
// observation is open. `pets` importing any of them is the single edge that
// inverts `check-dependency-direction` — and that is not an accident of the
// fence's configuration, it is the custodia-temporal design decision (design H)
// written into the fence's own comment: the owner cockpit reads caretaker state
// through a PAGE-level import precisely because `app/**` is outside the module
// graph, and routing it through a `pets` use-case is the import that must not
// happen.
//
// The page carried a comment saying "do not tidy it there". Extracting the read
// into an application-layer reader moved it there anyway, and the fence caught
// it — which is what a fence is for. The answer is not to widen the fence: it is
// to keep the reader's dependency on these three EXPRESSED AS PORTS and satisfy
// them from the layer that is allowed to know all three modules. That layer is
// this one.
//
// `app/_composition/` is a private folder (the leading underscore is Next's own
// convention for "never a route"), so nothing here is reachable over HTTP.
//
// BOTH CALLERS SHARE THIS OBJECT, and that is the point: the web page at
// `/mis-mascotas/{token}` and the native endpoint `GET /api/v1/pets/{token}`
// must resolve a caretaker arrangement the same way. Two wirings would be two
// answers to the same question.

import { getCaretakerStateForPet } from "@/src/modules/caretakers/application/get-caretaker-state-for-pet";
import { CaretakersRepository } from "@/src/modules/caretakers/infrastructure/caretakers-repository";
import type { OwnerPetDetailPorts } from "@/src/modules/pets/application/read/load-owner-pet-detail";
import { getRehomeStateForPet } from "@/src/modules/rehome/application/get-rehome-state-for-pet";
import { RehomeRepository } from "@/src/modules/rehome/infrastructure/rehome-repository";
import { isObservationOpen } from "@/src/modules/surveillance/domain/rabies-observation";

/**
 * The real wiring. The generic parameters are inferred from these functions'
 * return types, so a caller gets `CaretakerState` and `RehomeState` back with
 * their true shapes — the reader's structural mirrors never leak outward.
 */
export const ownerPetDetailPorts = {
  loadCaretakerState: (petId: string) =>
    getCaretakerStateForPet(petId, { repo: CaretakersRepository, now: () => new Date() }),
  loadRehomeState: (petId: string) => getRehomeStateForPet(petId, { repo: RehomeRepository }),
  isObservationOpen: (status: string | null) => isObservationOpen(status),
} satisfies OwnerPetDetailPorts<
  Awaited<ReturnType<typeof getCaretakerStateForPet>>,
  Awaited<ReturnType<typeof getRehomeStateForPet>>
>;
