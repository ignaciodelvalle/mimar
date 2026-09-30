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
  FINDER_MESSAGE,
  LOST_SEQUENCE,
  OWNER_FOUND_BODY,
  SHELTER_SEQUENCE,
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
        // (confirm-chip-match-refugio.ts:185-187).
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
    // one click (or one play-through) away, so all of them are checked.
    const steps = [VET_SEQUENCE, LOST_SEQUENCE, SHELTER_SEQUENCE].flatMap((spec) =>
      Array.from({ length: spec.total }, (_, i) => renderToStaticMarkup(spec.device(i, false))),
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
    // Chapter 3's found-report notification is EXACTLY what
    // notifyOwnerOfFoundPet writes for a finder who leaves a message and no
    // name or contact (notify-owner-of-found-pet.ts:220-226, :257).
    expect(html).toContain(OWNER_FOUND_BODY.replaceAll('"', "&quot;"));
    expect(OWNER_FOUND_BODY).toBe(
      `Alguien dejó un mensaje: "${FINDER_MESSAGE}". No dejó datos de contacto.`,
    );
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
      // Lost — the public credential and its found form (app/(public)/p/…).
      "Credencial pública",
      "Perdida",
      "Perro · Caniche · Hembra",
      // The lost CTA row (components/pet-profile/PublicLostSections.tsx:226,
      // foundPossessivePhrase / sightingPhrase in lib/utils/format.ts:538-562).
      "Llamar",
      "La tengo conmigo",
      "La vi cerca de acá",
      "¿Encontraste a esta mascota?",
      "Tocá acá para avisarle al dueño.",
      "Tu nombre (opcional)",
      "Nombre y apellido",
      "Cómo te contactamos (opcional)",
      "Teléfono o email",
      "Mensaje (opcional)",
      "Avisar al dueño",
      "¡Gracias!",
      "Le avisamos al dueño. Mientras tanto, cuidala lo mejor que puedas.",
      `¡Encontraron a ${PAMPA_PET.name}!`,
      "Ver mascota",
      // Martín's phone, the NATIVE app (apps/mobile/…): the inbox row
      // (src/notifications/NotificationsScreen.tsx:497-545, severityLabel
      // notifications-view-model.ts:100). Both CTAs map to native screens
      // (deep-link-map.ts), so both render as buttons.
      "Notificaciones",
      "Urgente",
      "Marcar como leída",
      "Coordinar devolución",
      // "Modo perdida" (app/_layout.tsx:543) and its PosterCard
      // (src/lost/LostScreen.tsx:559, lost-view-model.ts:693-696).
      "Modo perdida",
      "Cartel para imprimir",
      "Un PDF tamaño A4 con su foto, los datos que elegiste mostrar y el QR de su credencial. Mandalo por WhatsApp o imprimilo.",
      "Compartir o imprimir el cartel",
      "Cancelar",
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
      // :45, :335-338, :340, :351, :376; components/ui/WizardShell.tsx:88).
      "Paso 1 de 4",
      "Identificación",
      "vamos a redirigirte al flujo de match para confirmar la identidad.",
      "Número de microchip",
      "País del chip",
      "Continuar (chequearemos el chip al confirmar)",
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
      "detectó a Pampa por su microchip. Coordiná la devolución.",
      "Sí, la encontré",
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
