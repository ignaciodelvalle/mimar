// No panel writes the catalogue's words itself (owner-pet-actions, plan step 4).
//
// WHY. Before this change the owner's doors were written out three times — the
// web's "⋯ Más" sheet, the app's "Más" list, the Anotar catalogue's "Perfil"
// category — and the three drifted ("Transferir mascota" beside "Transferir la
// titularidad") because each kept its OWN labels. The catalogue
// (`packages/contract/src/reference/pet-actions.ts`) is now the one home for
// every label, hint, heading and grey-row reason. A panel that types one of
// those strings again is the first step of the next drift, and nothing else
// would notice: the copy would read right on the day it was typed.
//
// THE SUBJECT IS DERIVED, not listed. A file is a panel CONSUMER when it names
// the catalogue or the web's resolved view of it (`derivePetActions`,
// `resolveWebPetActions`, `WebPetAction`, …), under the web roots AND the app's
// source tree — so the native panel is judged the day it imports the catalogue,
// with nothing to add here. Tests are not consumers: asserting a label is their
// job.
//
// THE CHECK IS ON LITERALS. Every string literal and every JSX text node of a
// consumer, comments stripped, is compared — trimmed, whole — against the
// catalogue's strings. Equality, not "contains": a sheet id like "foto" or a
// sentence that happens to include "Salud" is not a copy of a label.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FOSTER_FIND_HOME_COPY,
  PET_ACTION_COPY,
  PET_ACTION_GROUPS,
  PET_ACTION_IDS,
  PET_ACTION_INERT_CAPTIONS,
  derivePetActions,
} from "@dim/contract/reference";

import { stripComments } from "@/scripts/lib/strip-comments.mjs";

const REPO = join(import.meta.dirname, "..");
const WEB_ROOTS = ["components", "app"];
const NATIVE_ROOT = "apps/mobile/src";

/** A source names the catalogue, or the web's resolved view of it. */
const CONSUMER_MARK =
  /\b(?:derivePetActions|findPetAction|DerivedPetActions?|DerivedPetActionGroup|PetActionId|resolveWebPetActions|WebPetActions?|WebPetActionGroup)\b/;

function walk(rel: string, out: string[]): void {
  for (const name of readdirSync(join(REPO, rel))) {
    if (name === "node_modules" || name.startsWith(".") || name === "__tests__") continue;
    const child = `${rel}/${name}`;
    if (statSync(join(REPO, child)).isDirectory()) walk(child, out);
    else if (
      /\.tsx?$/.test(name) &&
      !/\.(?:test|spec)\.tsx?$/.test(name) &&
      !name.endsWith(".d.ts")
    ) {
      out.push(child);
    }
  }
}

function sourcesUnder(roots: string[]): Array<{ path: string; text: string }> {
  const paths: string[] = [];
  for (const root of roots) walk(root, paths);
  return paths.map((path) => ({
    path,
    text: stripComments(readFileSync(join(REPO, path), "utf8")),
  }));
}

/** Every string literal (no interpolation) and every JSX text node, trimmed. */
function literalsOf(text: string): string[] {
  const out: string[] = [];
  const strings = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.)*)`/g;
  for (const m of text.matchAll(strings)) out.push((m[1] ?? m[2] ?? m[3] ?? "").trim());
  for (const m of text.matchAll(/>([^<>{}]+)</g)) out.push((m[1] as string).trim());
  return out.filter((s) => s.length > 0);
}

/** Every string the catalogue owns: labels, hints, headings, reasons and notes. */
function catalogueStrings(): Set<string> {
  const out = new Set<string>();
  for (const copy of [...Object.values(PET_ACTION_COPY), FOSTER_FIND_HOME_COPY]) {
    out.add(copy.label);
    out.add(copy.hint);
  }
  for (const caption of Object.values(PET_ACTION_INERT_CAPTIONS)) out.add(caption);
  for (const group of PET_ACTION_GROUPS) if (group.heading) out.add(group.heading);
  // The standing notes under live rows are private to the catalogue; read them
  // off a panel it derived, the way a consumer would receive them.
  const derived = derivePetActions({
    viewerRole: "owner",
    isTitular: true,
    petStatus: "active",
    species: "dog",
    pppDoor: false,
  });
  for (const action of [...derived.primary, ...derived.groups.flatMap((g) => g.actions)]) {
    if (action.caption) out.add(action.caption);
  }
  return out;
}

const STRINGS = catalogueStrings();
const web = sourcesUnder(WEB_ROOTS);
const native = sourcesUnder([NATIVE_ROOT]);
const consumers = [...web, ...native].filter((s) => CONSUMER_MARK.test(s.text));
const webConsumers = consumers.filter((s) => !s.path.startsWith(NATIVE_ROOT));
const nativeConsumers = consumers.filter((s) => s.path.startsWith(NATIVE_ROOT));

describe("the catalogue's words live in the catalogue only", () => {
  it("derives a vocabulary worth checking — every label, hint, heading and reason", () => {
    // Two strings per action at the very least (label and hint).
    expect(STRINGS.size).toBeGreaterThan(PET_ACTION_IDS.length * 2);
    expect(STRINGS).toContain("Transferir la titularidad");
    expect(STRINGS).toContain("Cierra el registro del animal");
  });

  it("finds the web's panel among the consumers (non-vacuity)", () => {
    const paths = webConsumers.map((s) => relative(REPO, join(REPO, s.path)).replaceAll("\\", "/"));
    expect(paths).toContain("components/pet-profile/PetActionRow.tsx");
    expect(paths).toContain("components/pet-profile/PetActionPanel.tsx");
    expect(paths.length).toBeGreaterThanOrEqual(3);
  });

  it("reads the app's source tree too, so the native panel is judged once it imports the catalogue", () => {
    // The scan root must be real: a moved tree would judge nothing and pass.
    expect(native.length).toBeGreaterThan(50);
    // The native panel lands with phase 5 of owner-pet-actions; until it
    // imports the catalogue it is not a consumer, and that is not a failure.
    expect(nativeConsumers.length).toBeGreaterThanOrEqual(0);
  });

  it("no consumer types a catalogue string itself", () => {
    const offences: string[] = [];
    for (const source of consumers) {
      for (const literal of literalsOf(source.text)) {
        if (STRINGS.has(literal)) offences.push(`${source.path}: "${literal}"`);
      }
    }
    expect(
      offences,
      "read the string from the catalogue (packages/contract/src/reference/pet-actions.ts) instead of typing it",
    ).toEqual([]);
  });

  it("would catch one — a typed label in a consumer is an offence", () => {
    // The detector itself, on a synthetic consumer: if this goes green for the
    // wrong reason, the check above means nothing.
    const fake = stripComments(
      'import { derivePetActions } from "@dim/contract/reference";\nconst x = <span>Transferir la titularidad</span>;\nconst y = "Solo el titular";',
    );
    expect(CONSUMER_MARK.test(fake)).toBe(true);
    const caught = literalsOf(fake).filter((l) => STRINGS.has(l));
    expect(caught.sort()).toEqual(["Solo el titular", "Transferir la titularidad"]);
  });
});
