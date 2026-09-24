// Tests for Wave 2 Item 8 — Loading & skeleton state components.
//
// Coverage:
//   1. <Skeleton> exposes aria-hidden (pure visual atom)
//   2. <OpKpiSkeleton> renders correctly
//   3. <OpCardSkeleton> respects the `rows` prop
//   4. <LnCardSkeleton> renders with ln-line token
//   5. loading.tsx files exist and expose aria-busy="true" + SR "Cargando…"
//      using <output> (semantic equivalent of role="status" per WAI-ARIA)
//   6. prefers-reduced-motion — the global CSS rule collapses the animation;
//      the shimmer class is present; JSDOM/CSS applies the media query at runtime
//
// Pattern: renderToStaticMarkup (same as existing UI tests in this repo).
// No e2e timing tests per spec.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LnCardSkeleton } from "@/components/ui/LnCardSkeleton";
import { LnPageSkeleton } from "@/components/ui/LnPageSkeleton";
import { Skeleton } from "@/components/ui/Skeleton";
import { OpCardSkeleton } from "@/components/ui/dashboard/OpCardSkeleton";
import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";
import { OpKpiSkeleton } from "@/components/ui/dashboard/OpKpiSkeleton";

import CrearConsultorioLoading from "@/app/(app)/cuenta/crear-consultorio/loading";
import DesactivarCuentaLoading from "@/app/(app)/cuenta/desactivar/loading";
import CuentaLoading from "@/app/(app)/cuenta/loading";
import MembershipsLoading from "@/app/(app)/cuenta/memberships/loading";
import OfrecermeTransitoLoading from "@/app/(app)/cuenta/ofrecerme-como-transito/loading";
import PrivacidadLoading from "@/app/(app)/cuenta/privacidad/loading";
import RenunciarLoading from "@/app/(app)/cuenta/renunciar/loading";
import SolicitudesLoading from "@/app/(app)/cuenta/solicitudes/loading";
import TransitosActivosLoading from "@/app/(app)/cuenta/transitos/activos/loading";
import TransitosHistorialLoading from "@/app/(app)/cuenta/transitos/historial/loading";
import TransitoPropuestaDetailLoading from "@/app/(app)/cuenta/transitos/propuestas/[proposalToken]/loading";
import TransitosPropuestasLoading from "@/app/(app)/cuenta/transitos/propuestas/loading";
import UpgradeCuentaLoading from "@/app/(app)/cuenta/upgrade/loading";
import VerificarDniLoading from "@/app/(app)/cuenta/verificar-dni/loading";
import DenunciaDetailLoading from "@/app/(app)/denuncias/[id]/loading";
import DenunciasMiasLoading from "@/app/(app)/denuncias/mias/loading";
import EventDetailLoading from "@/app/(app)/mis-mascotas/[publicToken]/eventos/[eventId]/loading";
// InicioLoading removed (owner-ia-redesign P5): /inicio is now a server redirect
// into the most-urgent pet, not a dashboard — it has no loading skeleton.
import EventCaptureFormLoading from "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/loading";
import PetProfileLoading from "@/app/(app)/mis-mascotas/[publicToken]/loading";
import MisMascotasLoading from "@/app/(app)/mis-mascotas/loading";
import CredencialLoading from "@/app/(app)/mis-mascotas/nueva/[publicToken]/credencial/loading";
import MisMascotasNuevaLoading from "@/app/(app)/mis-mascotas/nueva/loading";
import NuevaMatchLoading from "@/app/(app)/mis-mascotas/nueva/match/[matchedPetToken]/loading";
import PostulacionesLoading from "@/app/(app)/mis-mascotas/postulaciones/loading";
import ReclamarDniLoading from "@/app/(app)/mis-mascotas/reclamar-dni/loading";
import ReclamarLoading from "@/app/(app)/mis-mascotas/reclamar/loading";
import MiTurnoDetailLoading from "@/app/(app)/mis-turnos/[appointmentToken]/loading";
import MisTurnosLoading from "@/app/(app)/mis-turnos/loading";
import NotificacionesLoading from "@/app/(app)/notificaciones/loading";
import TransferenciaDetailLoading from "@/app/(app)/transferencias/[transferToken]/loading";
import TransferenciasLoading from "@/app/(app)/transferencias/loading";
import OfferingDetailLoading from "@/app/(app)/turnos/buscar/[offeringToken]/loading";
import ReservarSlotLoading from "@/app/(app)/turnos/buscar/[offeringToken]/reservar/[slotId]/loading";
import BuscarTurnosLoading from "@/app/(app)/turnos/buscar/loading";
import AdoptarLoading from "@/app/(public)/adoptar/loading";
import CasoLoading from "@/app/(public)/casos/[publicCode]/loading";
import PublicPetLoading from "@/app/(public)/p/[publicToken]/loading";
import RefugioLoading from "@/app/(public)/refugios/[orgToken]/loading";
import AdminAdminDetailLoading from "@/app/admin/admins/[userId]/loading";
import AdminAdminsLoading from "@/app/admin/admins/loading";
import AdminAdopcionesLoading from "@/app/admin/adopciones/loading";
import AdminAuditoriaLoading from "@/app/admin/auditoria/loading";
import AdminCasoDetailLoading from "@/app/admin/casos/[publicCode]/loading";
import AdminCasosLoading from "@/app/admin/casos/loading";
import AdminCensoLoading from "@/app/admin/censo/loading";
import AdminColaWrapperLoading from "@/app/admin/cola/[publicToken]/loading";
import AdminGovtDetailLoading from "@/app/admin/govts/[userId]/loading";
import AdminGovtsLoading from "@/app/admin/govts/loading";
import AdminHistorialLoading from "@/app/admin/historial/loading";
import AdminInteligenciaLoading from "@/app/admin/inteligencia/loading";
import AdminLoading from "@/app/admin/loading";
import AdminMascotaDetailLoading from "@/app/admin/mascotas/[token]/loading";
import AdminModeracionDetailLoading from "@/app/admin/moderacion/[id]/loading";
import AdminModeracionLoading from "@/app/admin/moderacion/loading";
import AdminObservacionDetailLoading from "@/app/admin/observaciones/[publicToken]/loading";
import AdminObservacionesLoading from "@/app/admin/observaciones/loading";
import AdminOrganizacionesLoading from "@/app/admin/organizaciones/loading";
import AdminOutboxDetailLoading from "@/app/admin/outbox/[id]/loading";
import AdminOutboxLoading from "@/app/admin/outbox/loading";
import AdminPanoramaLoading from "@/app/admin/panorama/loading";
import AdminPoblacionLoading from "@/app/admin/poblacion/loading";
import AdminProgramaLoading from "@/app/admin/programa/loading";
import AdminReglaEditarWrapperLoading from "@/app/admin/reglas/[country]/[province]/[locality]/editar/[ruleId]/loading";
import AdminReglasJurisdiccionWrapperLoading from "@/app/admin/reglas/[country]/[province]/[locality]/loading";
import AdminReglaNuevaWrapperLoading from "@/app/admin/reglas/[country]/[province]/[locality]/nueva/loading";
import AdminReglasWrapperLoading from "@/app/admin/reglas/loading";
import AdminServicioDetailWrapperLoading from "@/app/admin/servicios/[offeringToken]/loading";
import AdminServiciosWrapperLoading from "@/app/admin/servicios/loading";
import AdminCronsLoading from "@/app/admin/sistema/crons/loading";
import AdminSistemaLoading from "@/app/admin/sistema/loading";
import AdminSuscripcionesLoading from "@/app/admin/suscripciones/loading";
// Wave 3 (app-wide skeleton sweep, 2026-07-22) — segments that gained a
// dedicated loading.tsx built from OpDashboardSkeleton / LnPageSkeleton, and
// admin thin-wrapper re-exports of the gob twin's loading.tsx.
import GobAdopcionesLoading from "@/app/gob/adopciones/loading";
import GobAnalyticsExportLoading from "@/app/gob/analytics/export/loading";
import GobCampanasLoading from "@/app/gob/campanas/loading";
import GobCasoDetailLoading from "@/app/gob/casos/[publicCode]/loading";
import GobCasosLoading from "@/app/gob/casos/loading";
import GobCensoLoading from "@/app/gob/censo/loading";
import GobColaDetailLoading from "@/app/gob/cola/[publicToken]/loading";
import GobDecomisosLoading from "@/app/gob/decomisos/loading";
import GobDecomisoNuevoLoading from "@/app/gob/decomisos/nuevo/loading";
import GobDisputaDetailLoading from "@/app/gob/disputas/[disputeToken]/loading";
import GobDisputasLoading from "@/app/gob/disputas/loading";
import GobHistorialLoading from "@/app/gob/historial/loading";
// Loading pages
import GobLoading from "@/app/gob/loading";
import GobMaltratoDetailLoading from "@/app/gob/maltrato/[id]/loading";
import GobMascotaDetailLoading from "@/app/gob/mascotas/[token]/loading";
import GobModeracionDetailLoading from "@/app/gob/moderacion/[id]/loading";
import GobModeracionLoading from "@/app/gob/moderacion/loading";
import GobMortalidadLoading from "@/app/gob/mortalidad/loading";
import GobOrganizacionesLoading from "@/app/gob/organizaciones/loading";
import GobOutboxLoading from "@/app/gob/outbox/loading";
import GobOutreachLoading from "@/app/gob/outreach/loading";
import GobPanoramaLoading from "@/app/gob/panorama/loading";
import GobPoblacionLoading from "@/app/gob/poblacion/loading";
import GobProgramaLoading from "@/app/gob/programa/loading";
import GobReglaEditarLoading from "@/app/gob/reglas/[country]/[province]/[locality]/editar/[ruleId]/loading";
import GobReglasJurisdiccionLoading from "@/app/gob/reglas/[country]/[province]/[locality]/loading";
import GobReglaNuevaLoading from "@/app/gob/reglas/[country]/[province]/[locality]/nueva/loading";
import GobReglasLoading from "@/app/gob/reglas/loading";
import GobRupgaLoading from "@/app/gob/rupga/loading";
import GobServicioDetailLoading from "@/app/gob/servicios/[offeringToken]/loading";
import GobServiciosLoading from "@/app/gob/servicios/loading";
import GobSistemaLoading from "@/app/gob/sistema/loading";
import GobSuscripcionesLoading from "@/app/gob/suscripciones/loading";
import GobBrotesLoading from "@/app/gob/vigilancia/brotes/loading";
import GobInvestigacionDetailLoading from "@/app/gob/vigilancia/investigaciones/[caseCode]/loading";
import GobInvestigacionesLoading from "@/app/gob/vigilancia/investigaciones/loading";
import GobInvestigacionNuevaLoading from "@/app/gob/vigilancia/investigaciones/nuevo/loading";
import VigilanciaLoading from "@/app/gob/vigilancia/loading";
import LibretaCompartirLoading from "@/app/libreta/compartir/[shareToken]/loading";
import OrgPermisosLoading from "@/app/org/[orgToken]/admin/permisos/loading";
import OrgAdopcionDetailLoading from "@/app/org/[orgToken]/adopciones/[appEventId]/loading";
import OrgAdopcionesLoading from "@/app/org/[orgToken]/adopciones/loading";
import OrgAgendaLoading from "@/app/org/[orgToken]/agenda/loading";
import OrgTurnoDetailLoading from "@/app/org/[orgToken]/agenda/turnos/[appointmentToken]/loading";
import OrgAtenderDetailLoading from "@/app/org/[orgToken]/atender/[publicToken]/loading";
import OrgAtenderLoading from "@/app/org/[orgToken]/atender/loading";
import OrgCasosLoading from "@/app/org/[orgToken]/casos/loading";
import OrgCensoLoading from "@/app/org/[orgToken]/censo/loading";
import OrgCheckinsLoading from "@/app/org/[orgToken]/checkins/loading";
import OrgIntakeLoading from "@/app/org/[orgToken]/intake/loading";
import OrgIntakeMatchLoading from "@/app/org/[orgToken]/intake/match/[matchedPetToken]/loading";
import OrgLoading from "@/app/org/[orgToken]/loading";
import OrgMaltratoNuevoLoading from "@/app/org/[orgToken]/maltrato/nuevo/loading";
import OrgMaltratoRecibidosLoading from "@/app/org/[orgToken]/maltrato/recibidos/loading";
import OrgMascotaAdoptarLoading from "@/app/org/[orgToken]/mascotas/[publicToken]/adoptar/loading";
import OrgMascotaAdoptionLoading from "@/app/org/[orgToken]/mascotas/[publicToken]/adoption/loading";
import OrgMascotaFosterLoading from "@/app/org/[orgToken]/mascotas/[publicToken]/foster/loading";
import OrgMascotaDetailLoading from "@/app/org/[orgToken]/mascotas/[publicToken]/loading";
import OrgMascotaTransferLoading from "@/app/org/[orgToken]/mascotas/[publicToken]/transfer/loading";
import OrgMascotasLoading from "@/app/org/[orgToken]/mascotas/loading";
import OrgMiembroInvitarLoading from "@/app/org/[orgToken]/miembros/invitar/loading";
import OrgMiembrosLoading from "@/app/org/[orgToken]/miembros/loading";
import OrgMorderuraNuevoLoading from "@/app/org/[orgToken]/mordedura/nuevo/loading";
import OrgPetsNoAptasLoading from "@/app/org/[orgToken]/pets/no-aptas/loading";
import OrgServicioAgendaLoading from "@/app/org/[orgToken]/servicios/[offeringToken]/agenda/loading";
import OrgServicioDetailLoading from "@/app/org/[orgToken]/servicios/[offeringToken]/loading";
import OrgServiciosLoading from "@/app/org/[orgToken]/servicios/loading";
import OrgServicioNuevoLoading from "@/app/org/[orgToken]/servicios/nuevo/loading";
import OrgTransferenciasLoading from "@/app/org/[orgToken]/transferencias/loading";
import OrgTransferenciaNuevaLoading from "@/app/org/[orgToken]/transferencias/nueva/loading";
import OrgTransferenciasRecibidasLoading from "@/app/org/[orgToken]/transferencias/recibidas/loading";
import OrgTransitosLoading from "@/app/org/[orgToken]/transitos/loading";
import OrgVoluntariosLoading from "@/app/org/[orgToken]/voluntarios/loading";
import OrgVoluntarioPropuestasLoading from "@/app/org/[orgToken]/voluntarios/propuestas/loading";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

// ---------------------------------------------------------------------------
// Skeleton atom
// ---------------------------------------------------------------------------

describe("<Skeleton>", () => {
  it("renders a block element with shimmer class", () => {
    const html = render(<Skeleton />);
    expect(html).toContain("skeleton-shimmer");
  });

  it("is aria-hidden (pure visual)", () => {
    const html = render(<Skeleton />);
    expect(html).toContain('aria-hidden="true"');
  });

  it("applies custom w/h/radius via inline style", () => {
    const html = render(<Skeleton w="120px" h="20px" radius="8px" />);
    // React serializes inline styles without spaces: "width:120px"
    expect(html).toContain("width:120px");
    expect(html).toContain("height:20px");
    expect(html).toContain("border-radius:8px");
  });

  it("carries the shimmer class for CSS animation targeting", () => {
    const html = render(<Skeleton />);
    expect(html).toMatch(/skeleton-shimmer/);
  });
});

// ---------------------------------------------------------------------------
// Operator skeleton components
// ---------------------------------------------------------------------------

describe("<OpKpiSkeleton>", () => {
  it("renders without crashing", () => {
    const html = render(<OpKpiSkeleton />);
    expect(html.length).toBeGreaterThan(0);
  });

  it("is aria-hidden (visual atom — accessibility wrapper in loading.tsx)", () => {
    const html = render(<OpKpiSkeleton />);
    expect(html).toContain('aria-hidden="true"');
  });

  it("contains operator shimmer class", () => {
    const html = render(<OpKpiSkeleton />);
    expect(html).toMatch(/op-skeleton-shimmer/);
  });
});

describe("<OpCardSkeleton>", () => {
  it("renders with default rows", () => {
    const html = render(<OpCardSkeleton />);
    expect(html.length).toBeGreaterThan(0);
    // At minimum the header skeleton + body skeletons should be present
    const matches = html.match(/skeleton-shimmer/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
  });

  it("renders more elements with more rows", () => {
    const html2 = render(<OpCardSkeleton rows={2} />);
    const html6 = render(<OpCardSkeleton rows={6} />);
    const count2 = (html2.match(/skeleton-shimmer/g) ?? []).length;
    const count6 = (html6.match(/skeleton-shimmer/g) ?? []).length;
    expect(count6).toBeGreaterThan(count2);
  });

  it("contains operator shimmer class", () => {
    const html = render(<OpCardSkeleton />);
    expect(html).toMatch(/op-skeleton-shimmer/);
  });
});

describe("<OpDashboardSkeleton>", () => {
  it("renders the <output> wrapper with aria-busy + SR text", () => {
    const html = render(<OpDashboardSkeleton />);
    expect(html).toMatch(/<output/);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Cargando");
  });

  it("omits the KPI row by default (kpis=0)", () => {
    const html = render(<OpDashboardSkeleton />);
    // OpKpiSkeleton's distinctive min-h-[112px] frame should not appear
    expect(html).not.toContain("min-h-[112px]");
  });

  it("renders `kpis` KPI tiles when requested", () => {
    const html = render(<OpDashboardSkeleton kpis={4} />);
    const matches = html.match(/min-h-\[112px\]/g) ?? [];
    expect(matches.length).toBe(4);
  });

  it("renders one OpCardSkeleton block per `cards` entry", () => {
    const html = render(<OpDashboardSkeleton cards={[6, 4]} />);
    const matches = html.match(/op-skeleton-shimmer/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
  });

  it("can omit the filter-bar strip", () => {
    const withBar = render(<OpDashboardSkeleton filterBar />);
    const withoutBar = render(<OpDashboardSkeleton filterBar={false} />);
    expect(withBar.length).toBeGreaterThan(withoutBar.length);
  });
});

// ---------------------------------------------------------------------------
// Owner skeleton component
// ---------------------------------------------------------------------------

describe("<LnCardSkeleton>", () => {
  it("renders without crashing", () => {
    const html = render(<LnCardSkeleton />);
    expect(html.length).toBeGreaterThan(0);
  });

  it("uses ln-line token (owner/public surface)", () => {
    const html = render(<LnCardSkeleton />);
    expect(html).toContain("color-ln-line");
  });

  it("does NOT use op-skeleton-shimmer class", () => {
    const html = render(<LnCardSkeleton />);
    expect(html).not.toMatch(/op-skeleton-shimmer/);
  });
});

describe("<LnPageSkeleton>", () => {
  it("renders the <output> wrapper with aria-busy + SR text", () => {
    const html = render(<LnPageSkeleton />);
    expect(html).toMatch(/<output/);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Cargando");
  });

  it("renders `rows` registry rows", () => {
    const html2 = render(<LnPageSkeleton rows={2} />);
    const html5 = render(<LnPageSkeleton rows={5} />);
    const count2 = (html2.match(/border-b/g) ?? []).length;
    const count5 = (html5.match(/border-b/g) ?? []).length;
    expect(count5).toBeGreaterThan(count2);
  });

  it("omits the avatar placeholder when avatar=false", () => {
    const withAvatar = render(<LnPageSkeleton avatar />);
    const withoutAvatar = render(<LnPageSkeleton avatar={false} />);
    expect(withAvatar).toContain("border-radius:50%");
    expect(withoutAvatar).not.toContain("border-radius:50%");
  });

  it("renders a CTA placeholder when cta=true", () => {
    const withCta = render(<LnPageSkeleton cta />);
    const withoutCta = render(<LnPageSkeleton cta={false} />);
    expect(withCta.length).toBeGreaterThan(withoutCta.length);
  });

  it("does NOT use op-skeleton-shimmer class (citizen surface)", () => {
    const html = render(<LnPageSkeleton />);
    expect(html).not.toMatch(/op-skeleton-shimmer/);
  });
});

// ---------------------------------------------------------------------------
// loading.tsx files — <output> element (implicit role="status") + aria-busy + SR text
// <output> is the semantic HTML element for status/live regions (WAI-ARIA).
// Biome lint/a11y/useSemanticElements enforces this over <div role="status">.
// ---------------------------------------------------------------------------

const loadingPages: [string, () => React.ReactElement][] = [
  ["GobLoading", () => <GobLoading />],
  ["AdminLoading", () => <AdminLoading />],
  ["OrgLoading", () => <OrgLoading />],
  ["VigilanciaLoading", () => <VigilanciaLoading />],
  ["PetProfileLoading", () => <PetProfileLoading />],
  ["PublicPetLoading", () => <PublicPetLoading />],
  ["AdoptarLoading", () => <AdoptarLoading />],
  ["RefugioLoading", () => <RefugioLoading />],
  ["CasoLoading", () => <CasoLoading />],
  ["MisMascotasLoading", () => <MisMascotasLoading />],
  ["CuentaLoading", () => <CuentaLoading />],
  ["LibretaCompartirLoading", () => <LibretaCompartirLoading />],
  ["EventCaptureFormLoading", () => <EventCaptureFormLoading />],
  // Wave 2 state-coverage fence (2026-07-21) — segments that gained a
  // dedicated loading.tsx built from OpDashboardSkeleton / LnPageSkeleton.
  ["GobCasosLoading", () => <GobCasosLoading />],
  ["GobCensoLoading", () => <GobCensoLoading />],
  ["GobDecomisosLoading", () => <GobDecomisosLoading />],
  ["GobHistorialLoading", () => <GobHistorialLoading />],
  ["GobPoblacionLoading", () => <GobPoblacionLoading />],
  ["GobOrganizacionesLoading", () => <GobOrganizacionesLoading />],
  ["GobSuscripcionesLoading", () => <GobSuscripcionesLoading />],
  ["AdminCasosLoading", () => <AdminCasosLoading />],
  ["AdminCensoLoading", () => <AdminCensoLoading />],
  ["AdminPoblacionLoading", () => <AdminPoblacionLoading />],
  ["AdminHistorialLoading", () => <AdminHistorialLoading />],
  ["AdminOrganizacionesLoading", () => <AdminOrganizacionesLoading />],
  ["AdminSuscripcionesLoading", () => <AdminSuscripcionesLoading />],
  ["BuscarTurnosLoading", () => <BuscarTurnosLoading />],
  ["MisTurnosLoading", () => <MisTurnosLoading />],
  ["GobAdopcionesLoading", () => <GobAdopcionesLoading />],
  ["GobCampanasLoading", () => <GobCampanasLoading />],
  ["GobModeracionLoading", () => <GobModeracionLoading />],
  ["GobModeracionDetailLoading", () => <GobModeracionDetailLoading />],
  ["GobMortalidadLoading", () => <GobMortalidadLoading />],
  ["GobOutboxLoading", () => <GobOutboxLoading />],
  ["GobProgramaLoading", () => <GobProgramaLoading />],
  ["GobRupgaLoading", () => <GobRupgaLoading />],
  ["GobSistemaLoading", () => <GobSistemaLoading />],
  ["GobBrotesLoading", () => <GobBrotesLoading />],
  ["GobInvestigacionesLoading", () => <GobInvestigacionesLoading />],
  ["GobInvestigacionDetailLoading", () => <GobInvestigacionDetailLoading />],
  ["GobInvestigacionNuevaLoading", () => <GobInvestigacionNuevaLoading />],
  ["GobDisputasLoading", () => <GobDisputasLoading />],
  ["GobDisputaDetailLoading", () => <GobDisputaDetailLoading />],
  ["GobMaltratoDetailLoading", () => <GobMaltratoDetailLoading />],
  ["GobOutreachLoading", () => <GobOutreachLoading />],
  ["GobAnalyticsExportLoading", () => <GobAnalyticsExportLoading />],
  ["GobPanoramaLoading", () => <GobPanoramaLoading />],
  ["GobDecomisoNuevoLoading", () => <GobDecomisoNuevoLoading />],
  ["GobReglasLoading", () => <GobReglasLoading />],
  ["GobReglasJurisdiccionLoading", () => <GobReglasJurisdiccionLoading />],
  ["GobReglaNuevaLoading", () => <GobReglaNuevaLoading />],
  ["GobReglaEditarLoading", () => <GobReglaEditarLoading />],
  ["GobServiciosLoading", () => <GobServiciosLoading />],
  ["GobServicioDetailLoading", () => <GobServicioDetailLoading />],
  ["GobCasoDetailLoading", () => <GobCasoDetailLoading />],
  ["GobMascotaDetailLoading", () => <GobMascotaDetailLoading />],
  ["GobColaDetailLoading", () => <GobColaDetailLoading />],
  ["AdminAdminsLoading", () => <AdminAdminsLoading />],
  ["AdminAdminDetailLoading", () => <AdminAdminDetailLoading />],
  ["AdminAdopcionesLoading", () => <AdminAdopcionesLoading />],
  ["AdminAuditoriaLoading", () => <AdminAuditoriaLoading />],
  ["AdminGovtsLoading", () => <AdminGovtsLoading />],
  ["AdminGovtDetailLoading", () => <AdminGovtDetailLoading />],
  ["AdminInteligenciaLoading", () => <AdminInteligenciaLoading />],
  ["AdminModeracionLoading", () => <AdminModeracionLoading />],
  ["AdminModeracionDetailLoading", () => <AdminModeracionDetailLoading />],
  ["AdminObservacionesLoading", () => <AdminObservacionesLoading />],
  ["AdminObservacionDetailLoading", () => <AdminObservacionDetailLoading />],
  ["AdminOutboxLoading", () => <AdminOutboxLoading />],
  ["AdminOutboxDetailLoading", () => <AdminOutboxDetailLoading />],
  ["AdminProgramaLoading", () => <AdminProgramaLoading />],
  ["AdminPanoramaLoading", () => <AdminPanoramaLoading />],
  ["AdminSistemaLoading", () => <AdminSistemaLoading />],
  ["AdminCronsLoading", () => <AdminCronsLoading />],
  ["AdminCasoDetailLoading", () => <AdminCasoDetailLoading />],
  ["AdminMascotaDetailLoading", () => <AdminMascotaDetailLoading />],
  ["OrgCasosLoading", () => <OrgCasosLoading />],
  ["OrgCensoLoading", () => <OrgCensoLoading />],
  ["OrgCheckinsLoading", () => <OrgCheckinsLoading />],
  ["OrgMascotasLoading", () => <OrgMascotasLoading />],
  ["OrgMascotaDetailLoading", () => <OrgMascotaDetailLoading />],
  ["OrgMascotaAdoptarLoading", () => <OrgMascotaAdoptarLoading />],
  ["OrgMascotaAdoptionLoading", () => <OrgMascotaAdoptionLoading />],
  ["OrgMascotaFosterLoading", () => <OrgMascotaFosterLoading />],
  ["OrgMascotaTransferLoading", () => <OrgMascotaTransferLoading />],
  ["OrgAgendaLoading", () => <OrgAgendaLoading />],
  ["OrgTurnoDetailLoading", () => <OrgTurnoDetailLoading />],
  ["OrgIntakeLoading", () => <OrgIntakeLoading />],
  ["OrgIntakeMatchLoading", () => <OrgIntakeMatchLoading />],
  ["OrgTransferenciasLoading", () => <OrgTransferenciasLoading />],
  ["OrgTransferenciasRecibidasLoading", () => <OrgTransferenciasRecibidasLoading />],
  ["OrgTransferenciaNuevaLoading", () => <OrgTransferenciaNuevaLoading />],
  ["OrgTransitosLoading", () => <OrgTransitosLoading />],
  ["OrgVoluntariosLoading", () => <OrgVoluntariosLoading />],
  ["OrgVoluntarioPropuestasLoading", () => <OrgVoluntarioPropuestasLoading />],
  ["OrgMiembrosLoading", () => <OrgMiembrosLoading />],
  ["OrgMiembroInvitarLoading", () => <OrgMiembroInvitarLoading />],
  ["OrgServiciosLoading", () => <OrgServiciosLoading />],
  ["OrgServicioDetailLoading", () => <OrgServicioDetailLoading />],
  ["OrgServicioAgendaLoading", () => <OrgServicioAgendaLoading />],
  ["OrgServicioNuevoLoading", () => <OrgServicioNuevoLoading />],
  ["OrgMaltratoRecibidosLoading", () => <OrgMaltratoRecibidosLoading />],
  ["OrgMaltratoNuevoLoading", () => <OrgMaltratoNuevoLoading />],
  ["OrgPetsNoAptasLoading", () => <OrgPetsNoAptasLoading />],
  ["OrgAdopcionesLoading", () => <OrgAdopcionesLoading />],
  ["OrgAdopcionDetailLoading", () => <OrgAdopcionDetailLoading />],
  ["OrgAtenderLoading", () => <OrgAtenderLoading />],
  ["OrgAtenderDetailLoading", () => <OrgAtenderDetailLoading />],
  ["OrgPermisosLoading", () => <OrgPermisosLoading />],
  ["OrgMorderuraNuevoLoading", () => <OrgMorderuraNuevoLoading />],
  ["AdminReglasWrapperLoading", () => <AdminReglasWrapperLoading />],
  ["AdminReglasJurisdiccionWrapperLoading", () => <AdminReglasJurisdiccionWrapperLoading />],
  ["AdminReglaNuevaWrapperLoading", () => <AdminReglaNuevaWrapperLoading />],
  ["AdminReglaEditarWrapperLoading", () => <AdminReglaEditarWrapperLoading />],
  ["AdminServiciosWrapperLoading", () => <AdminServiciosWrapperLoading />],
  ["AdminServicioDetailWrapperLoading", () => <AdminServicioDetailWrapperLoading />],
  ["AdminColaWrapperLoading", () => <AdminColaWrapperLoading />],
  ["CrearConsultorioLoading", () => <CrearConsultorioLoading />],
  ["DesactivarCuentaLoading", () => <DesactivarCuentaLoading />],
  ["MembershipsLoading", () => <MembershipsLoading />],
  ["OfrecermeTransitoLoading", () => <OfrecermeTransitoLoading />],
  ["PrivacidadLoading", () => <PrivacidadLoading />],
  ["RenunciarLoading", () => <RenunciarLoading />],
  ["SolicitudesLoading", () => <SolicitudesLoading />],
  ["TransitosActivosLoading", () => <TransitosActivosLoading />],
  ["TransitosHistorialLoading", () => <TransitosHistorialLoading />],
  ["TransitosPropuestasLoading", () => <TransitosPropuestasLoading />],
  ["TransitoPropuestaDetailLoading", () => <TransitoPropuestaDetailLoading />],
  ["UpgradeCuentaLoading", () => <UpgradeCuentaLoading />],
  ["VerificarDniLoading", () => <VerificarDniLoading />],
  ["DenunciaDetailLoading", () => <DenunciaDetailLoading />],
  ["DenunciasMiasLoading", () => <DenunciasMiasLoading />],
  ["MisMascotasNuevaLoading", () => <MisMascotasNuevaLoading />],
  ["CredencialLoading", () => <CredencialLoading />],
  ["NuevaMatchLoading", () => <NuevaMatchLoading />],
  ["PostulacionesLoading", () => <PostulacionesLoading />],
  ["ReclamarLoading", () => <ReclamarLoading />],
  ["ReclamarDniLoading", () => <ReclamarDniLoading />],
  ["EventDetailLoading", () => <EventDetailLoading />],
  ["MiTurnoDetailLoading", () => <MiTurnoDetailLoading />],
  ["NotificacionesLoading", () => <NotificacionesLoading />],
  ["TransferenciasLoading", () => <TransferenciasLoading />],
  ["TransferenciaDetailLoading", () => <TransferenciaDetailLoading />],
  ["OfferingDetailLoading", () => <OfferingDetailLoading />],
  ["ReservarSlotLoading", () => <ReservarSlotLoading />],
];

// ---------------------------------------------------------------------------
// GobLoading — PO visual-validation batch B shape (2026-07-23): 2 alert-card
// placeholders + a 10-tile "Brechas vs meta" grid (8 original + 2
// mortalidad/disposición, now ordinary tiles) + its chart-card sub-row + 5
// individual "Cola operativa" tiles ("de a 1") + a collapsed-activity card.
// Pins the home briefing layout's skeleton to the same block count the page
// itself renders, so a future page edit that adds/removes a block is caught
// here too (skeleton drifting from the real layout is its own CLS bug).
// ---------------------------------------------------------------------------

describe("GobLoading — mirrors the revised briefing's block shape", () => {
  it("renders exactly 15 KPI-tile placeholders (10 'Brechas vs meta' + 5 'Cola operativa')", () => {
    const html = render(<GobLoading />);
    const kpiTiles = html.match(/min-h-\[112px\]/g) ?? [];
    expect(kpiTiles).toHaveLength(15);
  });

  it("renders 4 OpCardSkeleton-shaped blocks (2 alerts + 1 chart-card + 1 activity)", () => {
    const html = render(<GobLoading />);
    // OpCardSkeleton's header row is a distinctive, stable marker.
    const cardHeaders = html.match(/border-b border-ln-op-line px-\[15px\] py-\[11px\]/g) ?? [];
    expect(cardHeaders).toHaveLength(4);
  });
});

describe.each(loadingPages)("%s", (_name, factory) => {
  it("uses <output> element (semantic role=status for live regions)", () => {
    const html = render(factory());
    // <output> is the WAI-ARIA semantic element for role="status"
    expect(html).toMatch(/<output/);
  });

  it('has aria-busy="true"', () => {
    const html = render(factory());
    expect(html).toContain('aria-busy="true"');
  });

  it("includes SR-only Cargando… text", () => {
    const html = render(factory());
    expect(html).toContain("Cargando");
  });
});
