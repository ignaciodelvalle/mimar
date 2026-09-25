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

import { LandingHero } from "@/components/landing/LandingHero";
import { StorySection } from "@/components/landing/StorySection";
import { LIBRETA_EVENTS, formatChip } from "@/components/landing/landing-content";
import {
  LOST_SEQUENCE,
  SHELTER_SEQUENCE,
  VET_SEQUENCE,
} from "@/components/landing/story-sequences";
import {
  OWNER_NAME,
  PAMPA_CHIP,
  PAMPA_EVENTS,
  PAMPA_PET,
  VET_CLINIC,
  VET_LICENSE,
  VET_NAME,
  buildPampaLibreta,
} from "@/scripts/flagship-pampa-data";
import { stripComments } from "@/scripts/lib/strip-comments.mjs";

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

  it("the libreta is the seed's entries minus the purged scan, authored as in the seed", () => {
    const seeded = PAMPA_EVENTS.filter((e) => e.eventType !== "credential_scanned");
    expect(LIBRETA_EVENTS).toHaveLength(seeded.length);
    expect(LIBRETA_EVENTS.map((e) => e.type)).toEqual(seeded.map((e) => e.eventType));
    expect(LIBRETA_EVENTS.map((e) => e.year)).toEqual(seeded.map((e) => e.date.slice(0, 4)));
    const vetShort = `Dra. ${VET_NAME.split(" ").at(-1)}`;
    const expectedBy = seeded.map((e) =>
      e.authorRole === "owner"
        ? `${OWNER_NAME} · dueño`
        : e.authorRole === "vet"
          ? `${vetShort} · vet`
          : "Refugio · org",
    );
    expect(LIBRETA_EVENTS.map((e) => flat(e.by))).toEqual(expectedBy);
    // The last dose: signed by the vet, at the Comuna 13 campaign.
    const last = LIBRETA_EVENTS.at(-1);
    expect(flat(last?.by ?? "")).toBe(`${vetShort} · vet`);
    expect(last?.meta).toContain("Comuna 13");
  });

  it("the story renders the seed's vet, doses and lost report", () => {
    // SSR shows each animated chapter's FINAL step; every other step is only
    // one click (or one play-through) away, so all of them are checked.
    const steps = [VET_SEQUENCE, LOST_SEQUENCE, SHELTER_SEQUENCE].flatMap((spec) =>
      Array.from({ length: spec.total }, (_, i) => renderToStaticMarkup(spec.device(i, false))),
    );
    const html = flat([renderToStaticMarkup(<StorySection />), ...steps].join(" "));
    expect(html).toContain(VET_NAME);
    expect(html).toContain(VET_LICENSE);
    expect(html).toContain(VET_CLINIC);
    for (const e of PAMPA_EVENTS.filter((x) => x.eventType === "vaccination_administered")) {
      expect(html).toContain(String(e.payload.batch));
      expect(html).toContain(String(e.payload.brand));
    }
    expect(html).toContain(flat(formatChip(PAMPA_CHIP)));
    expect(html).toContain(`Lo busca ${OWNER_NAME}.`);
    expect(html).toContain("Sin punto exacto en el mapa");
    // No screen claims a current rabies vaccine: the only dated screen that
    // could (2022-04-12) is the dose itself, and no product surface prints it.
    expect(html).not.toContain("Antirrábica vigente");
    // One pet on the sign-up screen, and the real product labels.
    expect(html).not.toMatch(/Beagle|Holland Lop|3 mascotas|alerta activa/);
    expect(html).toContain("Caniche · hembra · nacimiento estimado nov 2021");
    expect(html).toContain("Posible coincidencia detectada");
    expect(html).toContain("Es la misma mascota");
    expect(html).toContain("La tengo conmigo");
    expect(html).not.toContain("¡Hola! Soy");
    expect(html).not.toContain("Custodia devuelta");
    // The real product labels of the animated chapters.
    for (const label of [
      "Marca / laboratorio",
      "Lote / número de batch",
      "Administrado por",
      "Próxima dosis (fecha)",
      "Marcar asistencia",
      "FIRMADO",
      "Marcar como perdida",
      "Compartir o imprimir el cartel",
      "Llamar",
      "Escanearon su QR",
      "Identificación",
      `Encontraron a ${PAMPA_PET.name}`,
      "detectó a Pampa por su microchip. Coordiná la devolución.",
      "Sí, la encontré",
    ]) {
      expect(html, label).toContain(label);
    }
    // No map, no pin, no street for a scan.
    expect(html).not.toMatch(/lp-minimap|−?\d{2}\.\d{3,}, −?\d{2}\.\d{3,}/);
    expect(html).not.toContain("vecinos");
    expect(html).not.toContain("EN CASA");
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
