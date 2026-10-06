// Pampa's facts — one pure module, read by the seed and by the landing.
//
// scripts/flagship-pampa-data.ts was extracted from scripts/seed-flagship-pampa.ts
// so the public landing tells the story of the SAME pet its hero QR resolves
// to. The extraction must not change what the seed writes: FROZEN_EVENTS below
// is the seed's event list verbatim as it stood before the refactor (wu5,
// 6722d4a72), and the module has to rebuild it deep-equal.
//
// The second half fences the landing: every date, batch, brand, vet, license
// and author it shows about Pampa comes from the module, and the facts the old
// landing invented (a vet the seed never created, a neighbours' alert, a
// radius, a libreta row for a scan the product purges) cannot come back.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children?: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

import { toAtenderCaptureMatch } from "@/app/org/[orgToken]/atender/[publicToken]/atender-quick-capture-match";
import { LandingHero } from "@/components/landing/LandingHero";
import { NativeAsiento } from "@/components/landing/LibretaFeed";
import { StorySection } from "@/components/landing/StorySection";
import {
  HERO_CREDENTIAL_FIELDS,
  LIBRETA_EVENTS,
  PAMPA_SHELTER,
  formatChip,
  seedInstant,
} from "@/components/landing/landing-content";
import {
  LOST_SEQUENCE,
  SHELTER_SEQUENCE,
  SIGHTING_BODY,
  SIGHTING_CONTACT,
  SIGHTING_MESSAGE,
  VET_NOTE,
  VET_NOTE_VACCINE,
  VET_SEQUENCE,
} from "@/components/landing/story-sequences";
import { toAsientoView } from "@/components/pet-profile/asiento-fields";
import { matchCaptureIntent } from "@/lib/events/event-capture-matcher";
import { formatDate } from "@/lib/utils/format";
import {
  OWNER_NAME,
  PAMPA_CHIP,
  PAMPA_EVENTS,
  PAMPA_PET,
  PAMPA_TOKEN,
  VET_CLINIC,
  VET_LICENSE,
  VET_NAME,
  buildPampaLibreta,
} from "@/scripts/flagship-pampa-data";
import { stripComments } from "@/scripts/lib/strip-comments.mjs";
import type { HistorialEventRow } from "@/src/modules/pets/application/tab-data/types";
import { credentialFieldLabel, fieldsForSurface } from "@dim/contract/credential";

const FROZEN_EVENTS = [
  {
    date: "2022-03-14",
    eventType: "pet_registered",
    authorRole: "owner",
    authorVerified: false,
    payload: {
      name: "Pampa",
      species: "dog",
      sex: "female",
      breed: "Caniche",
      date_of_birth: "2021-11-20",
      birth_date_is_estimated: true,
      color: "blanco",
      acquisition_method: "adopted",
      has_photo: true,
      has_microchip: false,
    },
  },
  {
    date: "2022-04-05",
    eventType: "microchip_implanted",
    authorRole: "vet",
    authorVerified: true,
    payload: {
      chip_number: "941000100000001",
      country_code: "941",
      implanted_by: "Veterinaria Belgrano",
      location_on_body: "interescapular",
      implant_date_known: true,
    },
  },
  {
    date: "2022-04-12",
    eventType: "vaccination_administered",
    authorRole: "vet",
    authorVerified: true,
    payload: {
      vaccine_name: "Antirrábica",
      brand: "Rabisin",
      batch: "AR-2214",
      administered_by: "Veterinaria Belgrano",
      next_due_at: "2023-04-12",
    },
  },
  {
    date: "2023-02-18",
    eventType: "sterilization_performed",
    authorRole: "vet",
    authorVerified: true,
    payload: {
      procedure: "spay",
      performed_by: "Veterinaria Belgrano",
      clinic: "Veterinaria Belgrano",
    },
  },
  {
    date: "2024-03-09",
    eventType: "status_changed",
    authorRole: "owner",
    authorVerified: false,
    payload: {
      from_status: "active",
      to_status: "lost",
      location_description: "Barrancas de Belgrano, CABA",
      reason: null,
      disclosure_prefs_snapshot: {
        first_name: true,
        phone: true,
        email: false,
        last_location: true,
        finder_form: true,
      },
      lost_description: {
        accessories_when_lost: "Collar celeste con chapita",
        behavior_notes: null,
        last_seen_context: "Se soltó en la plaza durante un paseo",
      },
    },
  },
  {
    date: "2024-03-10",
    eventType: "credential_scanned",
    authorRole: "scanner",
    authorVerified: false,
    payload: { is_self_scan: false, viewer_authenticated: false },
  },
  {
    date: "2024-03-11",
    eventType: "shelter_intake_recorded",
    authorRole: "shelter",
    authorVerified: false,
    payload: {
      intake_reason: "stray_found",
      intake_condition: "Sana, con chip verificado",
      rescue_jurisdiction: "CABA",
    },
  },
  {
    date: "2024-03-13",
    eventType: "status_changed",
    authorRole: "owner",
    authorVerified: false,
    payload: {
      from_status: "lost",
      to_status: "active",
      reason: "returned_to_owner",
    },
  },
  {
    date: "2024-08-20",
    eventType: "clinical_info_logged",
    authorRole: "vet",
    authorVerified: true,
    payload: {
      sub_kind: "other",
      title: "Dermatitis atópica",
      details: "Plan de tratamiento y control estacional",
      performed_by: "Veterinaria Belgrano",
    },
  },
  {
    date: "2026-06-15",
    eventType: "vaccination_administered",
    authorRole: "vet",
    authorVerified: true,
    payload: {
      vaccine_name: "Antirrábica",
      brand: "Nobivac Rabies",
      batch: "CAMP-C13-2026",
      administered_by: "Campaña antirrábica · Comuna 13",
      next_due_at: "2027-06-15",
    },
  },
];

describe("flagship Pampa — the seed's output survives the extraction", () => {
  it("buildPampaLibreta rebuilds the pre-refactor events deep-equal", () => {
    const { events, recordedBy } = buildPampaLibreta("owner-id", "vet-id");
    expect(events).toEqual(FROZEN_EVENTS);
    expect(recordedBy).toEqual({
      owner: "owner-id",
      vet: "vet-id",
      shelter: "owner-id",
      scanner: null,
    });
  });

  it("the seed builds its libreta from the module, not from a local copy", () => {
    const seed = readFileSync("scripts/seed-flagship-pampa.ts", "utf8");
    expect(seed).toContain('from "./flagship-pampa-data"');
    expect(seed).toContain("buildPampaLibreta(ownerId, vetId)");
    for (const fact of ["AR-2214", "CAMP-C13-2026", "Rabisin", "V-99001-CABA", "2022-04-05"]) {
      expect(seed, `seed hardcodes "${fact}" instead of reading the module`).not.toContain(fact);
    }
  });

  it("the module is pure: it imports nothing", () => {
    const source = readFileSync("scripts/flagship-pampa-data.ts", "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/require\(|await import\(/);
  });

  it("events are chronological", () => {
    const dates = PAMPA_EVENTS.map((e) => e.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

// ---------------------------------------------------------------------------
// The landing tells the seed's story, and only the seed's story
// ---------------------------------------------------------------------------

/** Every file under components/landing, comments stripped (a comment may name what it removed). */
function landingSources(): Array<{ file: string; code: string }> {
  const out: Array<{ file: string; code: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|css)$/.test(entry.name)) {
        out.push({ file: path, code: stripComments(readFileSync(path, "utf8")) });
      }
    }
  };
  walk(join("components", "landing"));
  return out;
}

/** Rendered text with non-breaking spaces read as spaces. */
function flat(html: string): string {
  return html.replace(/ |&nbsp;|&#160;/g, " ");
}

/** Facts that exist ONLY in the data module — no landing file may spell them out itself. */
const MODULE_ONLY_FACTS: string[] = (() => {
  const facts = new Set<string>([
    PAMPA_CHIP,
    formatChip(PAMPA_CHIP),
    VET_NAME,
    VET_LICENSE,
    VET_CLINIC,
    "Marrone",
    OWNER_NAME,
  ]);
  for (const e of PAMPA_EVENTS) {
    facts.add(e.date);
    for (const key of [
      "brand",
      "batch",
      "next_due_at",
      "location_description",
      "administered_by",
    ]) {
      const v = e.payload[key];
      if (typeof v === "string") facts.add(v);
    }
  }
  return [...facts];
})();

/** Strings that told a story the seed does not have. */
const FORBIDDEN = [
  "Dra. Romero",
  "MP 4821",
  "alerta a vecinos",
  "1 km",
  "a 1,2 km",
  "refuerzo anual",
  "Credencial escaneada",
];

describe("flagship Pampa — the landing reads its facts from the module", () => {
  const sources = landingSources();

  it("scans the landing (guards against an emptied or renamed root)", () => {
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.some((s) => s.file.endsWith("landing-content.ts"))).toBe(true);
  });

  it("no landing file hardcodes a date, batch, brand, vet, license or author the module owns", () => {
    const hits: string[] = [];
    for (const { file, code } of sources) {
      for (const fact of MODULE_ONLY_FACTS) {
        if (code.includes(fact)) hits.push(`${file}: "${fact}"`);
      }
    }
    expect(hits, `hardcoded Pampa facts:\n${hits.join("\n")}`).toEqual([]);
  });

  it("no landing file carries a fact the seed does not have", () => {
    const hits: string[] = [];
    for (const { file, code } of sources) {
      for (const bad of FORBIDDEN) {
        if (code.includes(bad)) hits.push(`${file}: "${bad}"`);
      }
    }
    expect(hits, `invented Pampa facts:\n${hits.join("\n")}`).toEqual([]);
  });

  it("the libreta is the seed's entries minus the purged scan", () => {
    const seeded = PAMPA_EVENTS.filter((e) => e.eventType !== "credential_scanned");
    expect(LIBRETA_EVENTS).toHaveLength(seeded.length);
    expect(LIBRETA_EVENTS.map((e) => e.type)).toEqual(seeded.map((e) => e.eventType));
    expect(LIBRETA_EVENTS.map((e) => e.date)).toEqual(seeded.map((e) => e.date));
    // The last dose: the Comuna 13 campaign's, signed.
    const last = LIBRETA_EVENTS.at(-1);
    expect(last?.provenance).toContain("Comuna 13");
  });

  // Martín's phone is the native app (PO 2026-09-30). Its libreta draws what
  // the server's projection composes — components/pet-profile/asiento-fields.ts
  // toAsientoView, run by app/api/v1/pets/[publicToken]/libreta/payload.ts for
  // the OWNER audience. The landing transcribes it (the real module would pull
  // drizzle-orm into the client bundle); this runs the real one on every seed
  // event and asserts the transcription says exactly the same thing.
  it("every asiento the landing draws is what the real projection makes of the seed event", () => {
    const OWNER = "owner-user";
    const now = new Date("2026-09-30T12:00:00-03:00");
    for (const entry of LIBRETA_EVENTS) {
      const seed = PAMPA_EVENTS.find((e) => e.date === entry.date && e.eventType === entry.type);
      expect(seed, entry.title).toBeDefined();
      if (!seed) continue;
      const isShelter = seed.authorRole === "shelter";
      const row = {
        id: `${seed.eventType}-${seed.date}`,
        petId: "pet",
        eventType: seed.eventType,
        payload: seed.payload,
        occurredAt: seedInstant(seed.date),
        notes: null,
        recordedByUserId: seed.authorRole === "owner" ? OWNER : "someone-else",
        authorRole: seed.authorRole,
        authorVerified: seed.authorVerified,
        // The intake the chip match writes carries its organization
        // (confirm-chip-match-refugio.ts:208-211).
        authorOrganizationId: isShelter ? "org" : null,
        authorOrgName: isShelter ? PAMPA_SHELTER : null,
        attachmentUrl: null,
        hasAttachment: false,
        amendedAt: null,
      } as unknown as HistorialEventRow;
      const view = toAsientoView(
        row,
        "DIM-TEST-0001",
        { userId: OWNER, currentOwnerUserId: OWNER },
        now,
      );
      expect(entry.kind, entry.title).toBe(view.kind);
      expect(entry.title).toBe(view.title);
      expect(entry.whenAbsolute, entry.title).toBe(view.whenAbsolute);
      expect(entry.provenance, entry.title).toBe(view.provenance.label);
      // Every fact the landing draws is one of the real card's, verbatim.
      for (const fact of entry.facts) {
        expect(view.facts, `${entry.title} · ${fact.key}`).toContainEqual(
          expect.objectContaining({ key: fact.key, value: fact.value }),
        );
      }
      // And the relative half, from the same "now".
      const html = flat(renderToStaticMarkup(<NativeAsiento entry={entry} now={now} />));
      expect(html, entry.title).toContain(`${view.whenRelative} · ${flat(view.whenAbsolute)}`);
    }
  });

  it("the story renders the seed's vet, doses and lost report", () => {
    // SSR shows each animated chapter's FINAL step; every other step is only
    // one click (or one play-through) away, so all of them are checked — at
    // rest AND playing: a step that turns into the next screen within itself
    // (the sighting form → its thanks, the confirm → the closed search) only
    // draws its first screen while it plays.
    const steps = [VET_SEQUENCE, LOST_SEQUENCE, SHELTER_SEQUENCE].flatMap((spec) =>
      Array.from({ length: spec.total }, (_, i) => [
        renderToStaticMarkup(spec.device(i, false)),
        renderToStaticMarkup(spec.device(i, true)),
      ]).flat(),
    );
    const html = flat([renderToStaticMarkup(<StorySection />), ...steps].join(" "));
    // The vet chapter shows the atender page, which names the signer by
    // matrícula ("Firmás como matrícula …"), not by name — so the name is
    // not required here; the license and the clinic are.
    expect(html).toContain(VET_LICENSE);
    expect(html).toContain(VET_CLINIC);
    for (const e of PAMPA_EVENTS.filter((x) => x.eventType === "vaccination_administered")) {
      expect(html).toContain(String(e.payload.batch));
      expect(html).toContain(String(e.payload.brand));
    }
    // The chip as the intake form and the native libreta print it: ungrouped.
    expect(html).toContain(PAMPA_CHIP);
    // No screen claims a current rabies vaccine: the only dated screen that
    // could (2022-04-12) is the dose itself, and no product surface prints it.
    expect(html).not.toContain("Antirrábica vigente");
    // One pet on the sign-up screen, and the real product labels.
    expect(html).not.toMatch(/Beagle|Holland Lop|3 mascotas|alerta activa/);
    // The landing-vs-app audit (2026-09-30) found these in the devices; no
    // product surface draws them there.
    for (const invented of [
      "Credencial y QR creados",
      "Compartir miMAR",
      "Modo perdido",
      "Verificada",
      "Reportada perdida",
      "Ingresó a un refugio",
      "devuelta a su dueño",
      "Historial que solo se agrega",
      "Jurisdicciones con señal",
      "Señales por 100 mil",
    ]) {
      expect(html, invented).not.toContain(invented);
    }
    expect(html).toContain("Posible coincidencia detectada");
    expect(html).toContain("Es la misma mascota");
    // Chapter 3's sighting notification is EXACTLY what reportPetSighting
    // writes for a neighbour who leaves a message and a contact and no name
    // (report-pet-sighting.ts:349-365, joined by spaces at :434) — stated
    // here as a literal, not rebuilt from the landing's own template.
    expect(SIGHTING_BODY).toBe(
      'Alguien reportó haber visto a Pampa cerca de un punto. Mensaje: "La llevé al Refugio Patitas". Contacto de quien la vio: vecina@example.com. Mirá el detalle en su perfil.',
    );
    expect(html).toContain(SIGHTING_BODY.replaceAll('"', "&quot;"));
    // The neighbour names the story's refugio — the same one chapter 4's tablet is.
    expect(SIGHTING_MESSAGE).toContain(PAMPA_SHELTER);
    expect(html).toContain(SIGHTING_CONTACT);
    // And the use-case still writes those parts, in that order.
    const sightingSrc = readFileSync(
      "src/modules/pets/application/sighting/report-pet-sighting.ts",
      "utf8",
    );
    // Fragments around each interpolation (the source's templates, read as text).
    const parts = [
      "`Alguien reportó haber visto a ",
      " cerca de un punto.`",
      '`Mensaje: "',
      "`Contacto de quien la vio: ",
      '"Mirá el detalle en su perfil."',
      "title: `Avistaje de ",
      'body: bodyParts.join(" ")',
      'severity: "warning" as const',
      'ctaLabel: "Ver mascota"',
    ];
    let cursor = -1;
    for (const part of parts) {
      const at = sightingSrc.indexOf(part);
      expect(at, part).toBeGreaterThan(cursor);
      cursor = at;
    }
    // The finder-contact change removed this line from both found flows, and
    // the old found form is no longer drawn.
    expect(html).not.toContain("No dejó datos de contacto.");
    expect(html).not.toContain("Cómo te contactamos (opcional)");
    expect(html).not.toContain("¿Encontraste a esta mascota?");
    // Chapter 4's Devolución is the `inbound_pending` arm, and it is reachable
    // ONLY because the refugio's chip match leaves the return proposal
    // (PO 2026-10-01). If the match stops writing it, the owner lands on
    // `can_propose` — him offering the dog TO the refugio — and this chapter
    // would be drawing a screen nobody can reach. So the proposal is required
    // here, at its source, and the backwards arm may not be drawn.
    const chipMatchSrc = stripComments(
      readFileSync("src/modules/pets/application/chip-match/confirm-chip-match-refugio.ts", "utf8"),
    );
    expect(chipMatchSrc).toContain("writeRefugioReturnProposalInTx(tx, {");
    const proposalSrc = stripComments(
      readFileSync("src/modules/return-to-owner/application/propose-return-as-refugio.ts", "utf8"),
    );
    const helper = proposalSrc.slice(
      proposalSrc.indexOf("export async function writeRefugioReturnProposalInTx"),
      proposalSrc.indexOf("export async function proposeReturnAsRefugioUseCase"),
    );
    expect(helper).toContain('eventType: "custody_transfer_proposed"');
    expect(helper).toContain("to_user_id: ownerUserId");
    expect(helper).toContain("from_organization_id: organizationId");
    expect(html).not.toContain("Podés proponer devolver");
    expect(html).not.toContain("Devolver a la organización");
    expect(html).not.toContain("Proponer la devolución");
    // Confirming the return is what ends the search (owner-accept-return.ts
    // flips lost → active), so the chapter no longer needs "Sí, la encontré".
    expect(html).not.toContain("Sí, la encontré");
    expect(html).not.toContain("¡Hola! Soy");
    expect(html).not.toContain("Custodia devuelta");
    // No product surface prints these: the old attendance-form mock's
    // FIRMADO stamp on the vet's tablet, and a "La encontré" button (the
    // public page's is "La tengo conmigo").
    const vetHtml = Array.from({ length: VET_SEQUENCE.total }, (_, i) =>
      renderToStaticMarkup(VET_SEQUENCE.device(i, false)),
    ).join(" ");
    expect(vetHtml).not.toContain("FIRMADO");
    expect(vetHtml).not.toContain("Marcar asistencia");
    expect(html).not.toContain("La encontré");
    // Every string drawn inside a device in the animated chapters is the
    // product's own; the file:line of each is cited next to it in
    // components/landing/story-sequences.tsx.
    for (const label of [
      // Vet — the atender quick-capture flow (app/org/[orgToken]/atender/…).
      "Atender mascota",
      "Credencial de la mascota",
      "Código de la credencial (DIM-XXXX-XXXX)",
      "Buscar mascota",
      PAMPA_TOKEN,
      `Atendiendo a ${PAMPA_PET.name} · Perro`,
      `Firmás como <b>matrícula ${VET_LICENSE}</b> · verificado por profesional`,
      "Registrá lo que atendiste",
      "Identificar →",
      "Alta confianza",
      "Editar en el formulario",
      "Asentar vacuna",
      "Registrar vacuna",
      "Libreta sanitaria oficial",
      "Marca / laboratorio",
      "Evento clínico firmado. Podés registrar otro o volver al inicio.",
      // Lost — Martín's native "Modo perdida" (app/_layout.tsx:543), its
      // mark-lost pane (src/lost/LostScreen.tsx:724-728, :757, :837, :888;
      // lostAdjective lost-view-model.ts:44-53) and its PosterCard
      // (LostScreen.tsx:556-573, lost-view-model.ts:693-696).
      "Modo perdida",
      "Marcar a Pampa como perdida",
      "Su credencial pública va a mostrar el aviso de búsqueda. Abajo elegís qué datos tuyos se publican mientras la búsqueda esté activa.",
      "Dónde la viste por última vez",
      "Contexto del extravío",
      "Marcar como perdida",
      "Cartel para imprimir",
      "Un PDF tamaño A4 con su foto, los datos que elegiste mostrar y el QR de su credencial. Mandalo por WhatsApp o imprimilo.",
      "Compartir o imprimir el cartel",
      // The seed's lost report, read from the module.
      String(
        PAMPA_EVENTS.find((e) => e.payload.to_status === "lost")?.payload.location_description,
      ),
      "Se soltó en la plaza durante un paseo",
      // The neighbour — the public credential, lost (app/(public)/p/…).
      "Credencial pública",
      "Perdida",
      "Perro · Caniche · Hembra",
      // The lost CTA row (components/pet-profile/PublicLostSections.tsx:226,
      // foundPossessivePhrase / sightingPhrase in lib/utils/format.ts:538-562).
      "Llamar",
      "La tengo conmigo",
      "La vi cerca de acá",
      // The sighting page (sighting/page.tsx:148, :150-154) and its form
      // (PetSightingForm.tsx:145, :153, :192, :241, :267, :301) and thanks
      // (:106-108, :118).
      "← Volver al perfil",
      "Marcá dónde y cuándo viste a Pampa. El dueño/a recibe el aviso al instante.",
      "¿Cuándo la viste?",
      "Fecha",
      "11/03/2024",
      "Algún detalle (opcional)",
      "¿Querés que te puedan contactar? (opcional)",
      "Teléfono o email",
      "Avisar al dueño/a",
      "¡Gracias!",
      "Le avisamos al dueño/a con el punto que marcaste. Cualquier detalle más puede ayudar.",
      "Volver al perfil de Pampa",
      // Martín's phone, the NATIVE app (apps/mobile/…): the inbox row
      // (src/notifications/NotificationsScreen.tsx:497-545, severityLabel
      // notifications-view-model.ts:97-108: "urgent" → Urgente, "warning" →
      // Atención). Both CTAs map to native screens (deep-link-map.ts), so both
      // render as buttons. The sighting's title (report-pet-sighting.ts:433).
      "Notificaciones",
      "Avistaje de Pampa",
      "Atención",
      "Ver mascota",
      `¡Encontraron a ${PAMPA_PET.name}!`,
      "Urgente",
      "Marcar como leída",
      "Coordinar devolución",
      // The native Devolución in the state the refugio's proposal leaves it
      // in, `inbound_pending` (read-return-state.ts:143-175, the org named by
      // proposerIdentity :192-215): app/_layout.tsx:390; src/custody/
      // DevolucionScreen.tsx:162-163, :178-189, :191-194; returnStateHeadline,
      // devolucion-view-model.ts:94-101. Then the accept's notice
      // (DevolucionScreen.tsx:122, :165-169; acceptedMessage :170-176).
      "Devolución",
      "Devolución de Pampa",
      `Pampa está en ${PAMPA_SHELTER}, a salvo y esperándote.`,
      "Confirmar la devolución",
      "Tocá el botón cuando ya tengas a Pampa con vos. Ahí el refugio deja de cuidarla.",
      "Ya tengo a Pampa",
      "Rechazar la devolución",
      "Si no es tu mascota o algo no está bien, contale el motivo al refugio.",
      "¡Listo! Pampa ya está en casa con vos.",
      // "Mis mascotas" (app/_layout.tsx:288), its row and footer
      // (src/pets/PetRow.tsx:127-135, credential-view-model.ts:261,
      // app/mascotas/index.tsx:431).
      "Mis mascotas",
      "Activa",
      "Registrar otra mascota",
      // The pet screen on its libreta (app/_layout.tsx:302,
      // src/pets/DocumentChromeNative.tsx:391-395, LibretaScreen.tsx:316-322).
      "Mascota",
      "Libreta Sanitaria",
      "Libreta · dorso",
      "Asientos",
      "Marcada como perdida",
      "Marcada como encontrada",
      "Ingreso al refugio",
      `Registrado por ${PAMPA_SHELTER}`,
      // Refugio — the intake wizard (app/org/[orgToken]/intake/IntakeForm.tsx
      // :45, :335-338, :340, :376; components/ui/WizardShell.tsx:88).
      "Paso 1 de 4",
      "Identificación",
      // Chip-or-QR identification: ahead of the product (PO 2026-10-01, debt pending) —
      // IntakeForm.tsx:335 still prints the older chip-or-tattoo sentence.
      "Ingresá su microchip o tatuaje, o escaneá el QR de su chapa si tiene.",
      "vamos a redirigirte para confirmar la identidad.",
      "Escanear QR",
      "Número de microchip",
      // Plain "Continuar" (PO 2026-10-02): the real IntakeForm.tsx:376 still adds
      // "(chequearemos el chip al confirmar)"; the landing mock deliberately says less.
      'lp-vf-submit">Continuar</span>',
      // The match page (match/[matchedPetToken]/page.tsx:129) and its card
      // (MatchConfirmationCard.tsx:80-83, :154, :163).
      "Coincidencia de microchip",
      "Perro, Caniche",
      `${PAMPA_PET.color} · Hembra`,
      "No es la misma",
      // The intake queue it lands on (intake/page.tsx:127, :155, :180, :186).
      "Cola de ingresos",
      "Ingresos recientes",
      `Perro · ${formatDate(seedInstant(String(PAMPA_EVENTS.find((e) => e.eventType === "shelter_intake_recorded")?.date)))}`,
      "Ver ficha",
      `Pampa está a salvo en ${PAMPA_SHELTER}, que leyó su microchip. Coordiná con el refugio para ir a buscarla.`,
    ]) {
      expect(html, label).toContain(label);
    }
    // No map, no pin, no street for a scan.
    expect(html).not.toMatch(/lp-minimap|−?\d{2}\.\d{3,}, −?\d{2}\.\d{3,}/);
    expect(html).not.toContain("vecinos");
    expect(html).not.toContain("EN CASA");
    // Chapter 3 is ONE device now — no separately-labelled second phone.
    // (The chapter's own lead narration still legitimately says the finder
    // has "sin cuenta y sin app" — that is prose about the real flow, not a
    // second device label, and stays true regardless of how the mock renders.)
    expect(html).not.toContain("Celular del vecino");
    // The intake's first screen (PO 2026-10-02): no chip-country field, and the
    // two ways in side by side — [ Número de microchip ]  o  [ Escanear QR ].
    expect(html).not.toContain("País del chip");
    expect(html).not.toContain("chequearemos el chip");
    const intakeRow = html.slice(html.indexOf('<div class="lp-vf-or">'));
    const sep = intakeRow.indexOf('lp-vf-or-sep">o</span>');
    expect(intakeRow.indexOf("Número de microchip")).toBeGreaterThan(-1);
    expect(intakeRow.indexOf("Número de microchip")).toBeLessThan(sep);
    expect(sep).toBeLessThan(intakeRow.indexOf("Escanear QR"));
  });

  it("the vet's typed note is what the real matcher turns into the card drawn", () => {
    // VET_NOTE is the vet's own text; the card the chapter draws for it
    // (event "Vacuna", "Alta confianza", Vacuna = VET_NOTE_VACCINE) must be
    // what atender's quick capture actually resolves it to.
    const match = toAtenderCaptureMatch(matchCaptureIntent(VET_NOTE));
    expect(match).toEqual({
      evento: "vacuna",
      slots: { vaccineName: VET_NOTE_VACCINE },
      confidence: "high",
    });
    // The brand and batch she types into the form are the seed's first dose.
    const dose = PAMPA_EVENTS.find((e) => e.eventType === "vaccination_administered");
    expect(VET_NOTE).toContain(String(dose?.payload.brand));
    expect(VET_NOTE).toContain(String(dose?.payload.batch));
  });

  it("the hero credential's identity fields are the seed's pet row", () => {
    expect(HERO_CREDENTIAL_FIELDS.map((f) => f.label)).toEqual(
      fieldsForSurface("landing").map(credentialFieldLabel),
    );
    const byLabel = Object.fromEntries(HERO_CREDENTIAL_FIELDS.map((f) => [f.label, f.value]));
    // The native credential's own labels (CredentialScreen.tsx:375, :383).
    expect(byLabel).not.toHaveProperty("Especie y raza");
    expect(byLabel.Raza).toBe(PAMPA_PET.breed);
    expect(byLabel).not.toHaveProperty("Nacimiento estimado");
    // Pampa's libreta has a chip implant, so the card may say "Sí".
    expect(PAMPA_EVENTS.some((e) => e.eventType === "microchip_implanted")).toBe(true);
    expect(byLabel.Microchip).toBe("Sí");
  });

  // Sexo and Edad were removed from the front (PO 2026-09-30) to save one
  // line; only species/breed and microchip remain.
  it("no longer carries Sexo or Edad on the front", () => {
    const byLabel = Object.fromEntries(HERO_CREDENTIAL_FIELDS.map((f) => [f.label, f.value]));
    expect(byLabel).not.toHaveProperty("Sexo");
    expect(byLabel).not.toHaveProperty("Edad");
    expect(HERO_CREDENTIAL_FIELDS).toHaveLength(2);
  });

  it("the hero's libreta face lists vet-signed entries from the seed", () => {
    const html = flat(
      renderToStaticMarkup(<LandingHero qrSvg={null} publicHref={null} publicToken={null} />),
    );
    const newest = PAMPA_EVENTS.filter((e) => e.authorRole === "vet").at(-1);
    const [year, month] = String(newest?.date).split("-");
    expect(html).toContain(`Dra. Marrone · ${month}/${year}`);
    expect(html).not.toContain("M.N. 12.345");
    expect(html).not.toContain("Clínica Recoleta");
  });
});
