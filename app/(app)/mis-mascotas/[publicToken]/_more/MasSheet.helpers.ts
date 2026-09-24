// Pure helper for MasSheet — derives the "⋯ Más" sheet's action list.
// Mirrors components/PetActionsMenu.helpers.ts but scoped to design's sheets
// map (design.md "Sheets map (?sheet=)") — "Anotar" itself lives in the
// action row, not in this sheet.

export interface MasSheetInput {
  pet: {
    species: string;
    status: string;
    publicToken: string;
  };
  accessPath: "owner" | "org";
  ownershipRole: string | null;
  hasPendingReturnProposal: boolean;
}

export interface MasSheetItem {
  id: string;
  label: string;
  href: string;
  /** Non-interactive placeholder row (ADR-17c) — renders as aria-disabled, not a link. */
  disabled?: boolean;
  /** Small label shown next to a disabled item, e.g. "Próximamente". */
  badge?: string;
}

/**
 * Derives the list of links to render in the "⋯ Más" sheet. Pure function —
 * no side effects. Org-path viewers get an empty list (the sheet is not
 * offered to them at all — see the caller's isOwner gate).
 */
export function deriveMasSheetItems(input: MasSheetInput): MasSheetItem[] {
  const { pet, accessPath, ownershipRole, hasPendingReturnProposal } = input;
  if (accessPath !== "owner") return [];

  // custodia-temporal: a `caretaker` row is a Path-1 ownership row, so it
  // reaches this function with accessPath "owner" — and would otherwise be
  // offered every control below. The server already refuses the titular-only
  // ones (requireTitularAccess + migration 0190's RLS); hiding them here is the
  // half that keeps a caretaker from finding the boundary by pressing a button.
  //
  // A DENY, not an allow-list, and deliberately so: `co_owner`, `foster` and
  // `shelter_custody` keep today's list byte for byte. Turning this into "only
  // owner sees X" would smuggle a product decision about the other roles into a
  // security fix.
  const isCaretaker = ownershipRole === "caretaker";

  const items: MasSheetItem[] = [];

  if (!isCaretaker) {
    items.push({
      // "Editar datos y ficha" absorbs the old separate "Ficha" row — both
      // pointed at the identical ?sheet=editar-mascota (the ficha lives in
      // that form's "Otros" section), so two rows were a false choice
      // (flow audit 2026-07-03).
      //
      // Hidden from a caretaker: deny-list row `identity-field-edits`.
      id: "edit",
      label: "Editar datos y ficha",
      href: `/mis-mascotas/${pet.publicToken}?sheet=editar-mascota`,
    });
  }

  // Deceased (ADR-15/REQ-9.3): no write-affordances beyond corrections + who
  // to call. Everything else below (transfer/find-home/service-dog/confirm-
  // return/tracking) is suppressed.
  if (pet.status === "deceased") {
    // Same caretaker exclusion as the live-pet branch below — the contacts are
    // the titular's, and the sheet renders empty for anyone else.
    if (!isCaretaker) {
      items.push({
        id: "contacts",
        label: "Contactos de emergencia",
        href: `/mis-mascotas/${pet.publicToken}?sheet=emergencia`,
      });
    }
    return items;
  }

  // Chapa física — THE ENTRY POINT THAT WAS MISSING. `?sheet=chapita`
  // (PhysicalTagInterestSheet) has been mounted, data-wired (interest state +
  // the jurisdiction's physical_credential_channels) and reachable by URL since
  // ADR-17b — but NOTHING in the UI linked to it, so the whole surface was
  // dead weight: the printable-QR page it fronts, the interest toggle, and the
  // per-jurisdiction channel copy were all unreachable by clicking. This is the
  // remainder of the physical-credential-hub plan's Fase D.
  //
  // Placed AFTER the deceased early-return above on purpose: page.tsx nulls the
  // chapita data for deceased pets (and for org viewers), so the row must not
  // outlive the data that fills its sheet.
  items.push({
    id: "chapita",
    label: "Chapa física",
    href: `/mis-mascotas/${pet.publicToken}?sheet=chapita`,
  });

  if (ownershipRole === "owner" && pet.status === "active") {
    items.push({
      id: "transfer-pet",
      label: "Transferir mascota",
      href: `/mis-mascotas/${pet.publicToken}?sheet=transferir-mascota`,
    });
  }

  // Cuidador temporal (custodia-temporal). "Cuidador", never "custodia": the
  // latter is the live label for an organisation's `shelter_custody` role, and
  // two different arrangements sharing one word on the same screen is how a
  // vocabulary rots (PO decision 1, 2026-08-19).
  //
  // Titular-only twice over — it is deny-list row `caretaker-sub-designation`,
  // and the page behind it gates on requireTitularAccess as well.
  if (ownershipRole === "owner" && pet.status === "active") {
    items.push({
      id: "caretaker",
      label: "Cuidador temporal",
      href: `/mis-mascotas/${pet.publicToken}/cuidado`,
    });
  }

  // Two roles, two different asks, ONE page behind them — and the page agrees
  // (buscar-hogar/page.tsx serves `owner` and `foster`; the test beside this
  // file derives the row's audience from the page's own role gate, so the two
  // cannot drift apart again the way they did on 2026-08-20, when a titular
  // tapped a live row and got a 404).
  //
  //   foster → "Buscar hogar": the transit caregiver asks an org to find the
  //            animal a permanent home (the pre-existing feature).
  //   owner  → "Acompañamiento de adopción" (rehome-by-titular): the titular
  //            asks a verified org to sponsor the listing while the animal
  //            keeps living with them. Named by what the titular controls, in
  //            the titular's vocabulary, not the foster's.
  //
  // Not for a deceased pet, and not for a caretaker (titular-only, REQ-14).
  if (ownershipRole === "foster") {
    items.push({
      id: "find-home",
      label: "Buscar hogar",
      href: `/mis-mascotas/${pet.publicToken}/buscar-hogar`,
    });
  } else if (ownershipRole === "owner" && pet.status !== "deceased") {
    items.push({
      id: "find-home",
      label: "Acompañamiento de adopción",
      href: `/mis-mascotas/${pet.publicToken}/buscar-hogar`,
    });
  }

  if (pet.species === "dog" && ownershipRole === "owner") {
    items.push({
      id: "service-dog",
      label: "Perro de asistencia (Ley 26.858)",
      href: `/mis-mascotas/${pet.publicToken}/asistencia`,
    });
  }

  if (hasPendingReturnProposal) {
    items.push({
      id: "confirm-return",
      label: "Confirmar devolución",
      href: `/mis-mascotas/${pet.publicToken}/devolucion`,
    });
  }

  // "Documentos de viaje" was removed (flow audit 2026-07-03): its
  // `?section=docs` deep link was a noop — the edit sheet has no section
  // anchors — so the row promised a destination that didn't exist. Restore
  // it when a section anchor ships.
  //
  // "Ficha" merged into the "Editar datos y ficha" row above (same target).

  // Viaje transfronterizo (movilidad Fase 1): unlike the GPS-tracking row
  // removed by the lean audit below (a placeholder for a feature that never
  // existed), /viaje IS a real route — but no writer anywhere records a
  // transport_recorded event (only jurisdiction_changed moves via /mudanza
  // are wired; see TransportRecordedMovement in
  // src/modules/pets/application/movement/types.ts, still unused). PO
  // decision (UX honesty pass, 2026-07-19): keep the route, stop hiding that
  // it's non-functional — surface it here disabled with "Próximamente"
  // (ADR-17c idiom), same capability-gating spirit as MpfExportGate.
  items.push({
    id: "travel",
    label: "Viaje y movilidad",
    href: `/mis-mascotas/${pet.publicToken}/viaje`,
    disabled: true,
    badge: "Próximamente",
  });

  // Pet-scoped emergency sheet (?sheet=emergencia) — the same profile fields
  // the old /cuenta/editar path edited, without leaving the pet the user is
  // looking at (flow audit 2026-07-03: two surfaces for one dataset).
  //
  // Hidden from a caretaker. Not a deny-list row — these are the TITULAR's own
  // vet and emergency numbers, and page.tsx already nulls the data for any
  // holder who is not the legal owner. Leaving the row would have opened an
  // empty sheet: a control that does nothing, which reads as a bug rather than
  // as a boundary.
  if (!isCaretaker) {
    items.push({
      id: "contacts",
      label: "Contactos de emergencia",
      href: `/mis-mascotas/${pet.publicToken}?sheet=emergencia`,
    });
  }

  // The "Rastreo GPS · Próximamente" placeholder row was removed (lean audit
  // 2026-07-03): a disabled row advertising a feature that doesn't exist is
  // noise, not a roadmap. Re-add a real row when GPS tracking ships.

  return items;
}
