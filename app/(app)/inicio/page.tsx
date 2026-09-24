// /inicio folds into the pet profile (owner-ia-redesign P5, decision 7).
//
// The profile keeps its route; /inicio no longer renders a dashboard — it is a
// server redirect INTO the most-urgent live pet's credential. "Open the app →
// land on the pet that most needs you." The ordering is the SAME shared rank
// (rankOwnerCarousel / petUrgencyRank) the profile carousel (P4) and the
// /mis-mascotas index use, so the pet /inicio lands on is exactly the pet whose
// dot sits first in the swipe.
//
// Zero live pets → the index+inbox (/mis-mascotas), which is the only surface
// that exists for a pets-less owner (denuncias, inbound transfers, adoption
// postulaciones, foster proposals — none of which have a credential to live on;
// inventory §9.2).
//
// URL fragments never reach the server, but QUERY params do — so the tab-bar
// capture deep-link points at /inicio?sheet=anotar (CitizenTabBar) and this
// redirect FORWARDS its query string onto the resolved profile URL. The result
// is a single server redirect (/inicio?sheet=anotar → /mis-mascotas/DIM-XXXX?
// sheet=anotar) where the profile's SheetMounter opens the anotar sheet on
// arrival — no second hop, no capture-flow break. The zero-pet path forwards the
// SAME query onto the bare /mis-mascotas index for consistency (harmless — it
// preserves any OTHER forwarded params) but ?sheet=anotar itself is INERT there:
// the index doesn't mount SheetMounter, and with zero live pets there is nothing
// to capture an event against anyway. For a pets-less owner the index's own
// "Registrar mascota" CTA is the correct landing, not a capture sheet (W1
// review fix bar 2026-07-15: the prior comment claimed this forward "opens the
// capture sheet for zero-pet owners" — it never did). The former /cuenta/casos
// #casos anchor now points at /mis-mascotas#inbox directly.
//
// Vet gate: /inicio is also a post-login landing target, so a dual-role vet can
// arrive here. It honours the SAME vet-landing gate /mis-mascotas uses
// (resolveVetLanding unless ?as=owner) so the two owner entry points behave
// identically — otherwise /inicio was a back-door around the vet gate (Cursor).

import { redirect } from "next/navigation";

import {
  fetchComplianceStatesForPets,
  fetchLivePetsForCarouselRanking,
} from "@/lib/analytics/owner-dashboard";
import type { CarouselPetInput } from "@/lib/domain/owner-carousel";
import { rankOwnerCarousel } from "@/lib/domain/owner-carousel";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { getProfileCached } from "@/lib/infra/request-cache";
import { resolveVetLanding } from "@/lib/infra/role-landing";
import { lnPetStatusFromCompliance } from "@/lib/projections/pet-compliance";

export const dynamic = "force-dynamic";

export default async function InicioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireUserOrRedirect();
  const sp = await searchParams;

  // Vet gate — mirror of /mis-mascotas (page.tsx): a vet who also owns pets
  // reaches the owner surfaces only via ?as=owner; otherwise they land at their
  // org portal. Keeping this here closes the /inicio back-door around the gate.
  const profile = await getProfileCached(user.id);
  if (profile?.role === "vet" && sp.as !== "owner") {
    redirect(await resolveVetLanding(user.id));
  }

  // Forward the original query string (e.g. ?sheet=anotar from the tab bar) onto
  // whichever destination we redirect to — the profile OR the zero-pet index.
  const forwarded = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === "string") forwarded.set(key, value);
    else if (Array.isArray(value)) for (const v of value) forwarded.append(key, v);
  }
  const query = forwarded.toString();

  // The carousel source: EVERY live pet the owner can move between (foster/
  // transit included — no role filter, no cap). Ranking must see the whole
  // household or a most-urgent pet beyond the newest 50 would never surface
  // (QA ronda 4 CONFIRMED). Deceased pets never enter the swipe (decision 6);
  // they live in the index's "En memoria".
  const livePets = await fetchLivePetsForCarouselRanking(user.id);

  // No live pet → the index+inbox is the home. Forward the query for
  // consistency with the profile branch below (harmless — preserves any other
  // params), but note ?sheet=anotar itself is inert on the bare index: there is
  // no pet yet to capture an event against, and the index doesn't mount
  // SheetMounter. The index's own "Registrar mascota" CTA is the right next
  // step for a zero-pet owner.
  if (livePets.length === 0) {
    redirect(`/mis-mascotas${query ? `?${query}` : ""}`);
  }

  // Compliance over the live set — the SAME projection the index and the
  // profile read (deriveComplianceState → lnPetStatusFromCompliance), so the
  // urgency order here can never disagree with the carousel dots.
  const complianceByPet = await fetchComplianceStatesForPets(
    user.id,
    livePets.map((p) => p.id),
  );

  const carouselInput: CarouselPetInput[] = livePets.map((p) => {
    const compliance = complianceByPet.get(p.id);
    return {
      token: p.publicToken,
      status: p.status,
      pregnancyStatus: p.pregnancyStatus ?? null,
      complianceStatus: compliance
        ? lnPetStatusFromCompliance(
            { status: p.status, pregnancyStatus: p.pregnancyStatus ?? null },
            compliance,
          )
        : null,
    };
  });

  const ranked = rankOwnerCarousel(carouselInput);
  // rankOwnerCarousel returns at least one entry (livePets is non-empty and the
  // cap is > 0); the first is the most-urgent pet. The forwarded query (built
  // above) rides onto the profile so a capture deep-link opens the sheet in this
  // SAME redirect — no second hop.
  redirect(`/mis-mascotas/${ranked[0].token}${query ? `?${query}` : ""}`);
}
