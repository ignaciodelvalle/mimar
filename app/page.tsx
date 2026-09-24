import { and, eq, isNull } from "drizzle-orm";

// The lp-* layer. Imported HERE and nowhere else: it used to sit in
// globals.css, which the root layout imports, so every route in the product
// paid for ~2.3k lines of landing CSS it never used. See app/landing.css.
import "./landing.css";
import { redirect } from "next/navigation";
import QRCode from "qrcode";

import { BondBand } from "@/components/landing/BondBand";
import { CrisisBand } from "@/components/landing/CrisisBand";
import { EmpezarSection } from "@/components/landing/EmpezarSection";
import { FaqSection } from "@/components/landing/FaqSection";
import { FeaturesSection } from "@/components/landing/FeaturesSection";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingHero } from "@/components/landing/LandingHero";
import { LandingNav } from "@/components/landing/LandingNav";
import { MilestoneNav } from "@/components/landing/MilestoneNav";
import { RevealManager } from "@/components/landing/RevealManager";
import { StorySection } from "@/components/landing/StorySection";
import { resolveDemoPetToken } from "@/components/landing/demo-pet";
import { GobStripe } from "@/components/layout/GobStripe";
import { ScrollReset } from "@/components/layout/ScrollReset";
import { DemoModeBanner } from "@/components/ui/DemoModeBanner";
import { db, organizationMemberships, pets } from "@/db";
import { shouldShowDemoBanner } from "@/lib/domain/demo-mode";
import { getProfileCached } from "@/lib/infra/request-cache";
import {
  isDeactivatedInstitutional,
  pathForRole,
  resolveVetLanding,
} from "@/lib/infra/role-landing";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import { createClient } from "@/lib/supabase/server";

// Public landing — "una mascota, muchas manos" (design handoff
// docs/design_handoff_landing, benchmark L1–L8). Replaces the P4-1 hero /
// theme blocks with the storytelling landing:
//
//   Nav (sticky, ABOVE the gob stripe — intentional order) → Hero (Pampa's
//   credential + FlipCard-motif lost-mode demo + real scannable QR) →
//   CrisisBand (L1: perdí / encontré / code lookup, no login) → BondBand
//   (full-bleed emotional bridge: the human–animal bond the product protects)
//   → Story (CastFila + 6 chapters + sticky scroll-spy rail) → Features as life
//   moments (L6) → FAQ + trust row (L7/L4, beta chip) → Empezar (2 doors
//   ONLY: dueño / organización) → Footer (+ closing GobStripe).
//
// The landing owns its chrome (no AppShell): the handoff requires the nav
// ABOVE the institutional stripe, which no shell variant provides. The page
// still renders the single <main id="main-content"> that the root layout's
// skip-link targets.

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Logged-in users skip the landing and go straight to their portal.
  //
  // EXCEPT deactivated institutional accounts: their portal guards bounce
  // them right back to `/`, so redirecting them by role creates an infinite
  // 307 loop (/admin → / → /admin → ERR_TOO_MANY_REDIRECTS, task #39). They
  // fall through to the public landing instead; /login shows the deactivated
  // notice with a working "Cerrar sesión".
  const profile = user ? await getProfileCached(user.id) : null;
  if (user && !isDeactivatedInstitutional(profile)) {
    const role = profile?.role ?? "owner";
    if (role === "vet") {
      redirect(await resolveVetLanding(user.id));
    }
    let hasOrgAdminMembership = false;
    if (role === "owner") {
      const [membership] = await db
        .select({ id: organizationMemberships.id })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.userId, user.id),
            eq(organizationMemberships.role, "admin"),
            isNull(organizationMemberships.leftAt),
          ),
        )
        .limit(1);
      hasOrgAdminMembership = !!membership;
    }
    redirect(pathForRole(role, { hasOrgAdminMembership }));
  }

  // Hero QR — TWO gates before we promise anything scannable (RA-6 finding 1).
  //
  // 1. The deployment must DECLARE it has demo furniture (DEMO_PET_TOKEN, see
  //    components/landing/demo-pet.ts). Production, provisioned the way
  //    dim-interno:docs/ops/cutover-playbook.md mandates ("no seed pets, no demo
  //    accounts"), declares nothing.
  // 2. The declared token must actually resolve. This probe is the SAME
  //    condition /p/[publicToken] uses before calling notFound(), so a stale
  //    or mistyped value degrades here instead of shipping a QR that scans to
  //    a 404 — which on a government front door is worse than no QR at all.
  //
  // Either gate failing hands LandingHero nulls and it renders an illustrative
  // credential that promises nothing.
  const declaredDemoToken = resolveDemoPetToken();
  let demoToken: string | null = null;
  if (declaredDemoToken) {
    const [demoPet] = await db
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, declaredDemoToken))
      .limit(1);
    demoToken = demoPet ? declaredDemoToken : null;
  }

  // Real, scannable QR → declared demo pet credential. Same absolute-URL +
  // inline-SVG pattern as /mis-mascotas/[publicToken] (no image route).
  // resolveSiteUrl handles the set-but-empty env pitfall that would otherwise
  // encode a host-less relative URL no phone camera can resolve.
  const publicHref = demoToken ? `/p/${demoToken}` : null;
  // width 160 (up from 64) + errorCorrectionLevel "Q": the hero QR must scan
  // comfortably from a phone against the on-screen credential. The SVG is vector
  // so the real display size comes from the `.lp-hcard-qr` container (globals.css),
  // but generating at a larger module size keeps it crisp; "Q" adds scan
  // robustness (25% recovery) for camera reads off a glossy screen.
  const qrSvg = publicHref
    ? await QRCode.toString(`${resolveSiteUrl()}${publicHref}`, {
        type: "svg",
        margin: 1,
        width: 160,
        errorCorrectionLevel: "Q",
      })
    : null;

  return (
    <div className="lp flex min-h-screen flex-col" data-landing-root>
      <RevealManager />
      {/* ABOVE THE NAV, and above everything else on this page.
          `DemoModeBanner`'s header claims it is "mounted on EVERY shell —
          public, citizen, and operator", and the landing is on no shell at all:
          it lives at the app ROOT, outside `(public)`, so it never inherited
          that group's `banner` slot. Verified on the live origin 2026-09-09 —
          the credential page disclosed, this page did not, with demo mode on in
          both.
          NOT THE SAME THING as the two `datos ilustrativos · demo` captions
          further down (`story-screens.tsx`). Those say a particular CHART is
          made up; this says the SYSTEM is. A visitor who reads only the second
          kind can reasonably conclude the rest is real, which on the surface a
          funcionario enters through is the misreading that costs the most. */}
      <DemoModeBanner enabled={shouldShowDemoBanner(process.env.NEXT_PUBLIC_DEMO_MODE)} />
      <LandingNav />
      <GobStripe height={6} />
      <main id="main-content" data-scroll-reset className="flex-1">
        <ScrollReset />
        <LandingHero qrSvg={qrSvg} publicHref={publicHref} publicToken={demoToken} />
        <CrisisBand />
        <BondBand />
        <StorySection />
        <FeaturesSection />
        <FaqSection />
        <EmpezarSection />
      </main>
      <LandingFooter />
      {/* Milestone "Continuar ↓" CTA — progressive-reveal choreography over the
          six milestone sections above (FAQ + footer stay outside the sequence).
          Fixed bottom-right, so it can never collide with the sticky nav's
          sign-in/signup entry points; hidden past the last milestone. */}
      <MilestoneNav />
    </div>
  );
}
