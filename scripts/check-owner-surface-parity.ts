// Owner-surface parity fence — the native app may not fall silently behind the owner's web.
//
// WHY THIS EXISTS. There is no iOS app, so the web is the only surface for a
// large share of owners, and the Android app must stay at capability parity
// with it. Until 2026-09-09 that parity was tracked in PROSE — the writers.ts
// header, the contract header, a plan document — and the repo's own plan says
// why that fails: "un informe se pudre en una semana y este repo lo demostró
// tres veces en un día". The same day the app reached the last of the owner
// kinds the prose knew about, and the PO asked for the instrument BEFORE the
// next native build, so that "nothing is pending in the native app" is
// something the gate MEASURES rather than something a header believes.
//
// DERIVED, NEVER ENUMERATED. This file contains no list of event kinds and no
// list of web actions. Both were tried elsewhere and both rotted the day they
// were written (a literal role array cast to a union; a hand-written union
// restating an enum). Everything below is read out of the code at run time:
//
//   · THE WEB'S SET is every exported server action under WEB_ACTION_ROOTS
//     whose body calls an OWNER GUARD — and the guards themselves are derived
//     from lib/infra/pet-access.ts + lib/infra/pets.ts by export name
//     (`require…PetAccess`, `require…PetByToken`, `require…TitularAccess`).
//     "Las server actions con guardia de dueño" is the plan's own phrase.
//   · THE APP'S SET is what the v1 surface (app/api/v1/**) reaches, and the
//     JOIN KEY between the two is the shared USE-CASE: `createVaccinationAction`
//     and `POST /api/v1/pets/{token}/events` both call `createVaccination` from
//     src/modules/events/application/…. A web action whose use-case no v1 route
//     reaches is a capability the app does not have. No mapping table is needed
//     because the two doors already meet at the module both import — the web
//     action relatively (`./application/…`, it lives inside the module) and the
//     route absolutely (`@/src/modules/…`); both resolve to one id here.
//   · THE KIND VOCABULARY is read from three places that must agree, because
//     each one has drifted from prose before: the contract's discriminated
//     union (`kind: z.literal(…)` in record-event.ts), the phone's
//     WRITABLE_KINDS (record-event-view-model.ts) and the router's
//     EVENT_TYPE_OF_KIND (writers.ts). A kind in one and not the others is a
//     door that exists on paper only.
//   · THE RECEIPT is the part that goes past event kinds. What a web action
//     READS off its use-case result and can show the person (`result.value.
//     casePublicCode`, the CAS-XXXX-XXXX on the mordedura receipt) must be
//     something the app can also get: either a v1 file THAT REACHES THE SAME
//     USE-CASE reads the same field, or a v1 DTO in packages/contract/src/api
//     carries it. A field the web hands its client and no v1 read carries is a
//     divergence, whatever the write endpoint answered. The read half is scoped
//     to the use-case since 2026-09-10: the rehome door reads its own
//     `casePublicCode` off `withdrawRehomeRequest`, and an unscoped check took
//     that as the mordedura's receipt arriving — a real gap waved through by a
//     field NAME. The DTO half stays global, because a DTO key has no use-case
//     to scope by; a DTO that names a different case must say so in the name.
//   · THE FIELD CENSUS (owner-pet-actions, 2026-10-01) is the part the join
//     could not see. The app reached `updatePet` through `edit_identity`, so the
//     join called the web's edit form covered — while the app wrote three of its
//     fields and the web fifteen. Sex, birth date, allergies, insurance and the
//     public toggles were all gaps, and none of them was a missing USE-CASE. So
//     the fields are counted too, from the code: every `{ field: "…" }` entry of
//     `diffPet` (what an edit can change, as the spine records it) plus the
//     column `updatePet` writes WITHOUT a diff entry (`const flagChanged =
//     parsed.…`), each against what `composePetProfileEdit` — the composer every
//     v1 profile edit goes through — writes from the request rather than
//     carrying from the stored row. A field no v1 command can write is
//     `field:<column>`, declared like any other divergence.
//
// EXCLUSIONS ARE EXPLICIT, REASONED AND FEW. A deliberate divergence lives in
// DECLARED_DIVERGENCES, once, with the sentence saying WHY and the sentence
// saying WHAT WOULD CLOSE IT. An entry missing either fails. An entry that no
// longer describes a live divergence fails too (a stale permission is how the
// next real gap gets waved through — the same rule scripts/check-mobile-icon-
// vocabulary.ts applies to its aliases). The list is the deliverable: it is
// where the PO reads what is pending in the native app.
//
// NON-VACUITY. Every derivation above is a scan that must FIND things before it
// can compare them. A moved file, a renamed export or a regex that stopped
// matching would make every set empty and every set trivially equal — parity
// by blindness. So each scan has a floor (MIN_*), measured well above zero on
// 2026-09-09 and set below the measurement, and an unreadable source is a
// failure and not a pass. The measurements are next to each floor.
//
// WHAT THIS FENCE DOES NOT DECIDE, on purpose:
//   · The REVERSE direction (a v1 door the web lacks) is not the PO's question
//     and is not checked. The app being ahead is not "pending in the native
//     app".
//   · Owner actions that write INLINE — no src/modules/**/application use-case
//     CALLED in their body — cannot be joined and are reported as `unjoined:`.
//     They need a declaration like any other divergence, because a fence that
//     cannot see an action must say so rather than count it as parity.
//   · Field-for-field parity of each kind's INPUT is the contract's job
//     (record-event.ts is "the web's own writers, field for field") and is not
//     re-derived here.
//   · A use-case is "reached" by v1 when a route file imports and names it.
//     Whether the route's guard is as wide as the web's is lint:authz's
//     question, not this one's.
//
// Run:  pnpm tsx scripts/check-owner-surface-parity.ts   (or: pnpm lint:owner-parity)
// Exits 1 with one line per failure. Exits 0 with the census when clean.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import { extractExportedAsyncFunctions } from "./check-authz-guards";
import { stripComments } from "./lib/strip-comments.mjs";

// ---------------------------------------------------------------------------
// Where the fence reads
// ---------------------------------------------------------------------------

/** Roots that hold the owner's server actions ("use server" files). */
export const WEB_ACTION_ROOTS = ["app/actions", "app/(app)/mis-mascotas", "src/modules"] as const;
/** The whole native surface — every route the app can call. */
export const V1_ROOT = "app/api/v1";
/** The files whose `require…` exports are the owner guards. */
export const OWNER_GUARD_FILES = ["lib/infra/pet-access.ts", "lib/infra/pets.ts"] as const;
export const MOBILE_VIEW_MODEL = "apps/mobile/src/pets/record-event-view-model.ts";
export const CONTRACT_RECORD_EVENT = "packages/contract/src/input/record-event.ts";
export const ROUTER_WRITERS = "app/api/v1/pets/[publicToken]/events/writers.ts";
export const CONTRACT_API_DIR = "packages/contract/src/api";
/** A module is a use-case when its resolved path starts here and crosses this segment. */
export const USE_CASE_ROOT = "src/modules/";
export const USE_CASE_LAYER = "/application/";
/** The web edit's diff: which fields a save can change, as `pet_profile_updated` names them. */
export const PET_DIFF = "src/modules/pets/domain/pet-diff.ts";
/** The use-case behind both edit doors — where a column is written WITHOUT a diff entry. */
export const UPDATE_PET_USE_CASE = "src/modules/pets/application/update-pet.ts";
/** The composer every v1 profile edit lays its sections through. */
export const PROFILE_COMPOSER = "src/modules/pets/domain/pet-profile-edit.ts";
export const PROFILE_COMPOSER_EXPORT = "composePetProfileEdit";
const THIS_FILE = "scripts/check-owner-surface-parity.ts";

// ---------------------------------------------------------------------------
// Non-vacuity floors — measured 2026-09-09, set below the measurement
// ---------------------------------------------------------------------------
//
// Measured on the tree at 4459e670d (see the census line the fence prints):
// 4 owner guards; 92 "use server" files under the roots; 61 owner-guarded
// actions, 30 of them joined to at least one use-case a v1 route reaches;
// 47 distinct use-cases reached from app/api/v1; 18 kinds in each of the
// three vocabularies; 359 property keys across the v1 DTOs. Zero on any of
// these is what a broken scan looks like, and a floor at zero is no floor.
export const MIN_OWNER_GUARDS = 3;
export const MIN_USE_SERVER_FILES = 40;
export const MIN_OWNER_ACTIONS = 30;
export const MIN_JOINED_ACTIONS = 15;
export const MIN_V1_USE_CASES = 20;
export const MIN_KINDS = 12;
export const MIN_CONTRACT_API_KEYS = 200;
// The field census, measured 2026-10-01 on owner-pet-actions: 17 profile fields
// (16 `diffPet` entries plus the one flag `updatePet` writes without a diff
// entry), 26 properties in `composePetProfileEdit`'s returned literal, 15 of the
// 17 fields writable from the v1 surface.
export const MIN_PROFILE_FIELDS = 12;
export const MIN_COMPOSER_PROPERTIES = 18;

// ---------------------------------------------------------------------------
// Declared divergences — the list the PO reads
// ---------------------------------------------------------------------------

export type DeclaredDivergence = {
  /** Why the app does not have this today. One sentence, no hedging. */
  reason: string;
  /** What would close it — the change, not a wish. */
  closes: string;
};

/**
 * Keys are one of three shapes, each produced by the scan and never typed
 * from memory:
 *
 *   `write:<action>→<useCase>`  the action calls a use-case no v1 route reaches
 *   `read:<action>.<field>`     the action shows a result field no v1 read carries
 *   `unjoined:<action>`         the action writes inline; the join cannot see it
 *   `field:<column>`            the web's edit writes the column; no v1 command does
 *
 * Keep it sorted by key so a diff reads cleanly. Every entry here is pending
 * work in the native app until the PO says otherwise.
 */
export const DECLARED_DIVERGENCES: Record<string, DeclaredDivergence> = {
  // --- Receipt facts the web shows and no v1 read carries -------------------
  // EMPTY SINCE 2026-09-10. `read:reportBiteAction.casePublicCode` — the
  // mordedura case code, the last entry on this list that was a real missing
  // capability rather than a shape difference — closed the way its own `closes`
  // sentence said it would: `OwnerPetCasesSection` now carries an `items` array
  // of `{ casePublicCode, kind, status }` per open case, the reader fills it
  // from the SAME capped window `openCount` already counted, and the phone
  // prints one selectable line per case under "Trámites". It did NOT close by
  // growing `EventRecordedV1`, and that was the whole point: a code that arrives
  // only on the write's answer is a receipt a person sees once and loses.
  //
  // Left as a heading with no entries on purpose. The next receipt divergence
  // belongs here, and a section that vanished would make the next one look like
  // it had nowhere to go.

  // --- Profile fields the web's edit writes and no v1 command does ---------
  // Before `edit_profile` the app's only composer wrote the name, the breed and
  // the colour, so this census would have named fourteen fields here. That
  // change closed twelve (sex, birth date, allergies, foods, training, the
  // conditions and their text, the public disclosure of them, both insurance
  // fields, origin and the emergency toggle). The two left are not missing
  // doors; each says why.
  "field:estimated_weight_kg": {
    reason:
      "The app moves this column through its governed door instead: a `weight` asiento (Anotar → Peso, POST /api/v1/pets/{token}/events) re-derives pets.estimated_weight_kg from the spine (`updateWeightProjection`). The web's edit form also overwrites the estimate directly, and that overwrite has no v1 twin by design — a measurement with a date is the better record.",
    closes:
      "Drop the weight field from the web's edit form so both doors record weight only as an asiento; this entry then goes stale. Adding the estimate to edit_profile would close it the other way, and is not the plan.",
  },
  "field:potentially_dangerous_breed": {
    reason:
      "Not a door on either side: no request value reaches the PPP flag. diffPet compares the value the SERVER re-resolves from the persisted species, the breed and the jurisdiction, and both doors resolve it the same way (resolvePppClassificationForJurisdiction) on every write, edit_profile included.",
    closes:
      "Nothing, while the flag stays derived. If it ever became a value a person sets, it would need its own governed command, and this entry would then be a real gap.",
  },

  // --- Web writers the join cannot see ------------------------------------
  // Not pending in the app: the web was the one behind. Listed because this
  // fence must say so when it cannot see an action, never count it as parity.
  "unjoined:updatePetPhotoAction": {
    reason:
      "At parity below this fence's reach: the web's photo door (`?sheet=foto`, owner-pet-actions) and POST /api/v1/pets/{token}/photo (`confirmPetPhoto`) write the row and the pointer through the SAME `recordPetPhoto` (lib/infra/pet-photo-upload.ts), under the same rule (any holder; event.write on the org path). That writer is infra, not a src/modules application use-case, and use-cases are all the join can see.",
    closes:
      "Move the photo's row-and-pointer write into a src/modules/pets/application use-case that the web action and the v1 photo route both name; the join then sees one act and this entry goes stale.",
  },

  // --- Web writers with no v1 door ---------------------------------------
  // TATUAJE SALIO DE ESTA LISTA EL 2026-09-10, cerrado y no despriorizado: el
  // contrato tiene su variante `tattoo`, el router llama a `createTattooForUser`
  // y el selector del telefono tiene su formulario. Lo que NO cierra este cambio
  // es que una persona pueda usarlo: la foto es obligatoria en las dos puertas y
  // esta build no tiene selector de imagenes, asi que el formulario dibuja el
  // callout honesto en vez de un boton muerto. Esa mitad es una decision de
  // build (`docs/mobile/camera-modules-handback.md`), no una brecha de la API, y
  // esta fence mide alcance de API.
  "write:dismissFirstStepAction→dismissFirstStep": {
    reason:
      "'Primeros pasos' is a web-only onboarding checklist on the pet page; the app has no such checklist, so there is nothing for it to dismiss. Not a capability an owner loses — a surface the app does not have.",
    closes:
      "If the app ever grows the checklist, a `dismiss_first_step` command on POST /api/v1/pets/{token}/profile calling dismissFirstStep. Until then this entry records a deliberate absence.",
  },
  "write:recordMoveAction→recordMovementWriter": {
    reason:
      "Not a missing capability: POST /api/v1/pets/{token}/move reaches recordMovementWriter THROUGH recordJurisdictionMove, whose header declares that recordMoveAction still carries its own copy of the same steps. The join is one hop deep and sees two doors where there is one act.",
    closes:
      "Migrate recordMoveAction to call recordJurisdictionMove (the migration record-jurisdiction-move.ts already announces); the two doors then share one use-case and this entry goes stale.",
  },
  "write:setPetDisclosurePrefsAction→disclosureKeyRequiresTitular": {
    reason:
      "Not a door: disclosureKeyRequiresTitular only decides WHICH guard the web action takes. The v1 lost surface reaches setPetDisclosurePrefs (the join sees that) and enforces the same titular-only rule with its own TITULAR_ONLY check (lost/commands.ts, the set_disclosure refusal), so the capability is at parity.",
    closes:
      "Have lost/commands.ts read disclosureKeyRequiresTitular instead of its own copy of the key set; one predicate on both doors and this entry goes stale.",
  },
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type SourceFile = { path: string; src: string };

export type ParityInputs = {
  /** The files whose exports define the owner guards. */
  guardSources: SourceFile[];
  /** Every "use server" .ts file under WEB_ACTION_ROOTS (tests excluded). */
  webActionFiles: SourceFile[];
  /** Every .ts under V1_ROOT (tests excluded). */
  v1Files: SourceFile[];
  /** Every .ts under CONTRACT_API_DIR. */
  contractApiFiles: SourceFile[];
  /** `null` means the file could not be read — a failure, never a pass. */
  mobileViewModel: string | null;
  contractRecordEvent: string | null;
  routerWriters: string | null;
  /** The field census's three sources; `null` = unreadable, a failure as above. */
  petDiff: string | null;
  updatePetUseCase: string | null;
  profileComposer: string | null;
};

function readOrNull(cwd: string, rel: string): string | null {
  try {
    return readFileSync(join(cwd, rel), "utf8");
  } catch {
    return null;
  }
}

function walk(cwd: string, rel: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(join(cwd, rel));
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const child = `${rel}/${name}`;
    if (statSync(join(cwd, child)).isDirectory()) walk(cwd, child, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(child);
    }
  }
}

/** Is this a server-action module? The directive, not the filename. */
export function isUseServerFile(src: string): boolean {
  const head = stripComments(src).trimStart();
  return head.startsWith('"use server"') || head.startsWith("'use server'");
}

/** Read everything the fence judges. Pure I/O; the judging is in evaluate(). */
export function collectInputs(cwd = process.cwd()): ParityInputs {
  const read = (rel: string): SourceFile => ({ path: rel, src: readOrNull(cwd, rel) ?? "" });

  const webPaths: string[] = [];
  for (const root of WEB_ACTION_ROOTS) walk(cwd, root, webPaths);
  const v1Paths: string[] = [];
  walk(cwd, V1_ROOT, v1Paths);
  const apiPaths: string[] = [];
  walk(cwd, CONTRACT_API_DIR, apiPaths);

  return {
    guardSources: OWNER_GUARD_FILES.map(read),
    webActionFiles: webPaths.map(read).filter((f) => isUseServerFile(f.src)),
    v1Files: v1Paths.map(read),
    contractApiFiles: apiPaths.map(read),
    mobileViewModel: readOrNull(cwd, MOBILE_VIEW_MODEL),
    contractRecordEvent: readOrNull(cwd, CONTRACT_RECORD_EVENT),
    routerWriters: readOrNull(cwd, ROUTER_WRITERS),
    petDiff: readOrNull(cwd, PET_DIFF),
    updatePetUseCase: readOrNull(cwd, UPDATE_PET_USE_CASE),
    profileComposer: readOrNull(cwd, PROFILE_COMPOSER),
  };
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/**
 * The owner guards, by export name. Not a list: any `require…` export of the
 * two guard files whose name says it is about a pet or a titular. A guard
 * added there tomorrow is an owner guard here tomorrow.
 */
export function ownerGuardNames(sources: SourceFile[]): string[] {
  const names = new Set<string>();
  const re =
    /^export\s+async\s+function\s+(require\w*(?:PetAccess|PetByToken|TitularAccess))\s*\(/gm;
  for (const { src } of sources) {
    const text = stripComments(src);
    for (let m = re.exec(text); m !== null; m = re.exec(text)) names.add(m[1]);
  }
  return [...names].sort();
}

export type UseCaseRef = {
  /** The name this file uses (the alias, when there is one). */
  local: string;
  /** The exported name — what the other door imports too. */
  exported: string;
  /** Canonical module path, e.g. `src/modules/events/application/medical/weight-use-case`. */
  module: string;
};

/** `${module}#${exported}` — the identity both doors share. */
export function useCaseIdentity(ref: UseCaseRef): string {
  return `${ref.module}#${ref.exported}`;
}

/**
 * A repo-local specifier → the canonical module path, extension dropped; `null`
 * for a package. `@/a/b` and `./b` (from inside `a/`) both resolve to `a/b`.
 */
export function resolveModulePath(fromPath: string, specifier: string): string | null {
  let rel: string;
  if (specifier.startsWith("@/")) rel = specifier.slice(2);
  else if (specifier.startsWith(".")) {
    rel = posix.join(posix.dirname(fromPath.replaceAll("\\", "/")), specifier);
  } else return null;
  return rel.replace(/\.(?:ts|js)$/, "");
}

/**
 * A specifier → the canonical use-case module path, or `null` when it is not
 * one. `@/src/modules/x/application/y` and `./application/y` (from inside
 * `src/modules/x/`) both resolve to `src/modules/x/application/y`.
 */
export function resolveUseCaseModule(fromPath: string, specifier: string): string | null {
  const rel = resolveModulePath(fromPath, specifier);
  if (rel === null || !rel.startsWith(USE_CASE_ROOT) || !rel.includes(USE_CASE_LAYER)) return null;
  return rel;
}

/**
 * Every value import from a use-case module. Type-only imports are skipped: a
 * type is not a door.
 */
export function parseUseCaseImports(file: SourceFile): UseCaseRef[] {
  return parseValueImports(file, resolveUseCaseModule);
}

/** Every value import whose specifier `resolve` maps to a module, by name. */
function parseValueImports(
  file: SourceFile,
  resolve: (fromPath: string, specifier: string) => string | null,
): UseCaseRef[] {
  const refs: UseCaseRef[] = [];
  const re = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  const text = stripComments(file.src);
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[1]) continue;
    const module = resolve(file.path, m[3]);
    if (module === null) continue;
    for (const raw of m[2].split(",")) {
      const entry = raw.trim();
      if (entry.length === 0 || entry.startsWith("type ")) continue;
      const alias = entry.match(/^(\w+)\s+as\s+(\w+)$/);
      if (alias) refs.push({ local: alias[2], exported: alias[1], module });
      else if (/^\w+$/.test(entry)) refs.push({ local: entry, exported: entry, module });
    }
  }
  return refs;
}

/** The identifier appears as a whole word (not as a property of something). */
function mentions(text: string, ident: string): boolean {
  return new RegExp(`(?<![\\w$.])${ident}(?![\\w$])`).test(text);
}

/** The identifier is CALLED — a constant imported from an application dir is not a door. */
function calls(text: string, ident: string): boolean {
  return new RegExp(`(?<![\\w$.])${ident}\\s*\\(`).test(text);
}

/**
 * The fields an action reads off ONE use-case's result and can therefore show
 * the person: `const r = await useCase(…)` followed by `r.field` / `r.value.
 * field`, or `const { a, b } = await useCase(…)`.
 */
export function receiptFields(body: string, local: string): string[] {
  const fields = new Set<string>();
  const assign = new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*await\\s+${local}\\s*\\(`, "g");
  for (let m = assign.exec(body); m !== null; m = assign.exec(body)) {
    const v = m[1];
    const read = new RegExp(`(?<![\\w$.])${v}(?:\\.value)?\\.([A-Za-z_$][\\w$]*)`, "g");
    for (let r = read.exec(body); r !== null; r = read.exec(body)) {
      if (r[1] !== "value") fields.add(r[1]);
    }
  }
  const destructure = new RegExp(
    `(?:const|let)\\s+\\{([^}]*)\\}\\s*=\\s*await\\s+${local}\\s*\\(`,
    "g",
  );
  for (let m = destructure.exec(body); m !== null; m = destructure.exec(body)) {
    for (const raw of m[1].split(",")) {
      const key = raw.trim().split(/[:\s=]/)[0];
      if (/^\w+$/.test(key)) fields.add(key);
    }
  }
  return [...fields].sort();
}

/** Every `.name` property read (not a call) in a source, comments stripped. */
export function propertyReads(src: string): Set<string> {
  const out = new Set<string>();
  const re = /\.([A-Za-z_$][\w$]*)(?!\s*\()/g;
  const text = stripComments(src);
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.add(m[1]);
  return out;
}

/** Every `key:` / `key?:` property declaration across the v1 DTO sources. */
export function contractApiKeys(sources: SourceFile[]): Set<string> {
  const out = new Set<string>();
  const re = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??:/gm;
  for (const { src } of sources) {
    const text = stripComments(src);
    for (let m = re.exec(text); m !== null; m = re.exec(text)) out.add(m[1]);
  }
  return out;
}

/** `kind: z.literal("x")` — the contract's discriminated union. */
export function kindsFromContract(src: string | null): string[] | null {
  if (src === null) return null;
  const out = new Set<string>();
  const re = /kind:\s*z\.literal\("([a-z_]+)"\)/g;
  const text = stripComments(src);
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.add(m[1]);
  return out.size === 0 ? null : [...out].sort();
}

function literalsIn(block: string): string[] {
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

/**
 * The phone's WRITABLE_KINDS: `new Set<WritableKind>([...RECORD_KINDS, "x", …])`,
 * with the spread expanded from `export const RECORD_KINDS = […] as const`.
 */
export function kindsFromMobile(src: string | null): string[] | null {
  if (src === null) return null;
  const text = stripComments(src);
  const recordStart = text.indexOf("export const RECORD_KINDS = [");
  const recordEnd = recordStart === -1 ? -1 : text.indexOf("] as const;", recordStart);
  const recordKinds =
    recordStart === -1 || recordEnd === -1 ? null : literalsIn(text.slice(recordStart, recordEnd));

  const setStart = text.indexOf("export const WRITABLE_KINDS");
  if (setStart === -1) return null;
  const open = text.indexOf("([", setStart);
  const close = open === -1 ? -1 : text.indexOf("])", open);
  if (open === -1 || close === -1) return null;
  const body = text.slice(open + 2, close);
  const out = new Set<string>();
  if (body.includes("...RECORD_KINDS")) {
    if (recordKinds === null) return null;
    for (const k of recordKinds) out.add(k);
  }
  for (const k of literalsIn(body)) out.add(k);
  return out.size === 0 ? null : [...out].sort();
}

/** The router's `EVENT_TYPE_OF_KIND = { kind: "event_type", … }` — keys. */
export function kindsFromRouter(src: string | null): string[] | null {
  if (src === null) return null;
  const text = stripComments(src);
  const start = text.indexOf("const EVENT_TYPE_OF_KIND = {");
  const end = start === -1 ? -1 : text.indexOf("} as const", start);
  if (start === -1 || end === -1) return null;
  const out = new Set<string>();
  for (const m of text.slice(start, end).matchAll(/^\s*([a-z_]+):\s*"[a-z_]+"/gm)) out.add(m[1]);
  return out.size === 0 ? null : [...out].sort();
}

// ---------------------------------------------------------------------------
// The field census's derivations
// ---------------------------------------------------------------------------

/** A field the web's edit writes: its column, and the request value feeding it. */
export type ProfileField = {
  /** The column, as `pet_profile_updated` names it (`insurance_company`). */
  field: string;
  /** The `ParsedPet` property the new value comes from; `null` when none does. */
  reads: string | null;
};

/** The index of the bracket closing the one at `open`, strings skipped; -1 if unbalanced. */
function matchingClose(text: string, open: number): number {
  const closer: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch in closer) stack.push(closer[ch] as string);
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** The body of `export function <name>(…) {…}`, or `null` when it cannot be found. */
function functionBody(text: string, name: string): string | null {
  const anchor = text.indexOf(`export function ${name}(`);
  if (anchor === -1) return null;
  const paramsEnd = matchingClose(text, text.indexOf("(", anchor));
  if (paramsEnd === -1) return null;
  const open = text.indexOf("{", paramsEnd);
  const close = open === -1 ? -1 : matchingClose(text, open);
  return close === -1 ? null : text.slice(open + 1, close);
}

/** A list split at its top-level commas, blanks dropped. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i] as string;
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      parts.push(list.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(list.slice(from));
  return parts.filter((p) => p.trim().length > 0);
}

/**
 * `diffPet`'s entries — `{ field: "x", oldVal: …, newVal: <expr> }` — each with
 * the `parsed.<prop>` its new value comes from. Scoped to the function's own
 * body, so nothing else in the file can add a field.
 */
export function profileFieldsFromDiff(src: string | null): ProfileField[] | null {
  if (src === null) return null;
  const body = functionBody(stripComments(src), "diffPet");
  if (body === null) return null;
  const out: ProfileField[] = [];
  const re = /\{\s*field:\s*"([a-z_]+)"\s*,\s*oldVal:\s*[^,]+,\s*newVal:\s*([^}]*)\}/g;
  for (const m of body.matchAll(re)) {
    const read = (m[2] as string).match(/(?<![\w$.])parsed\.([A-Za-z_$][\w$]*)/);
    out.push({ field: m[1] as string, reads: read ? (read[1] as string) : null });
  }
  return out.length === 0 ? null : out;
}

/** `emergencyInfoVisible` → `emergency_info_visible`: the column a property writes. */
export function columnName(prop: string): string {
  return prop.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * The columns `updatePet` writes WITHOUT a diff entry — `const flagChanged =
 * parsed.x !== …`. One today, `emergencyInfoVisible`: a public-credential
 * toggle, and exactly the kind of field a census of `diffPet` alone would miss.
 */
export function flagFieldsFromUpdatePet(src: string | null): ProfileField[] | null {
  if (src === null) return null;
  const m = stripComments(src).match(/const\s+flagChanged\s*=\s*([^;]+);/);
  if (!m) return null;
  const props = [...(m[1] as string).matchAll(/(?<![\w$.])parsed\.([A-Za-z_$][\w$]*)/g)];
  if (props.length === 0) return null;
  return props.map((p) => ({ field: columnName(p[1] as string), reads: p[1] as string }));
}

/** What the composer's returned `ParsedPet` writes from the edit, and how many properties it read. */
export type ComposerWrites = { written: Set<string>; properties: number };

/** A value that is not the edit: the stored row's own property, or a constant. */
const CARRIED_LITERAL = /^(?:null|true|false|-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')$/;

/**
 * The properties `composePetProfileEdit` fills FROM THE EDIT. A property is
 * carried — not written — when its value is `existing.<same name>` or a
 * constant; anything else is the request reaching the column. A shorthand or a
 * spread is not counted as written: the fence cannot read it, and an unread
 * property must surface as a gap rather than pass as parity.
 */
export function composerWrites(src: string | null): ComposerWrites | null {
  if (src === null) return null;
  const body = functionBody(stripComments(src), PROFILE_COMPOSER_EXPORT);
  if (body === null) return null;
  const ret = body.lastIndexOf("return {");
  if (ret === -1) return null;
  const open = body.indexOf("{", ret);
  const close = matchingClose(body, open);
  if (close === -1) return null;
  const written = new Set<string>();
  let properties = 0;
  for (const part of splitTopLevel(body.slice(open + 1, close))) {
    properties++;
    const m = part.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+?)\s*$/);
    if (!m) continue;
    const key = m[1] as string;
    const value = (m[2] as string).replace(/\s+/g, " ");
    if (value !== `existing.${key}` && !CARRIED_LITERAL.test(value)) written.add(key);
  }
  return properties === 0 ? null : { written, properties };
}

/** Some v1 file imports the composer by name and CALLS it. */
export function v1ReachesComposer(v1Files: SourceFile[]): boolean {
  const target = PROFILE_COMPOSER.replace(/\.ts$/, "");
  return v1Files.some((file) => {
    const text = stripComments(file.src);
    return parseValueImports(file, resolveModulePath).some(
      (ref) =>
        ref.module === target && ref.exported === PROFILE_COMPOSER_EXPORT && calls(text, ref.local),
    );
  });
}

// ---------------------------------------------------------------------------
// The two sets
// ---------------------------------------------------------------------------

export type OwnerAction = {
  path: string;
  name: string;
  /** Use-cases the action CALLS, by identity. */
  useCases: UseCaseRef[];
  /** Per use-case LOCAL name, the result fields the action reads. */
  receipt: Map<string, string[]>;
};

/** The owner-guarded actions in one file, with what they reach and read. */
export function ownerActionsIn(file: SourceFile, guards: string[]): OwnerAction[] {
  const imports = parseUseCaseImports(file);
  const out: OwnerAction[] = [];
  for (const fn of extractExportedAsyncFunctions(file.src)) {
    const body = stripComments(fn.body);
    if (!guards.some((g) => calls(body, g))) continue;
    const useCases = imports.filter((ref) => calls(body, ref.local));
    const receipt = new Map<string, string[]>();
    for (const ref of useCases) receipt.set(ref.local, receiptFields(body, ref.local));
    out.push({ path: file.path, name: fn.name, useCases, receipt });
  }
  return out;
}

type Derived = {
  guards: string[];
  actions: OwnerAction[];
  /** Use-case identities some v1 route imports and names. */
  v1UseCases: Set<string>;
  /**
   * Per use-case identity, every property read in the v1 files that REACH it.
   * Scoped, not global: a `.casePublicCode` read off one use-case's result is
   * not the receipt of another use-case that happens to name a field the same.
   */
  v1ReadsByUseCase: Map<string, Set<string>>;
  apiKeys: Set<string>;
  contract: string[] | null;
  mobile: string[] | null;
  router: string[] | null;
  /** `diffPet`'s fields plus `updatePet`'s undiffed flag; `null` = could not derive. */
  profileFields: ProfileField[] | null;
  composer: ComposerWrites | null;
  composerReached: boolean;
};

function derive(inputs: ParityInputs): Derived {
  const diffFields = profileFieldsFromDiff(inputs.petDiff);
  const flagFields = flagFieldsFromUpdatePet(inputs.updatePetUseCase);
  const guards = ownerGuardNames(inputs.guardSources);
  const v1UseCases = new Set<string>();
  const v1ReadsByUseCase = new Map<string, Set<string>>();
  for (const file of inputs.v1Files) {
    const text = stripComments(file.src);
    const reads = propertyReads(file.src);
    for (const ref of parseUseCaseImports(file)) {
      if (!mentions(text, ref.local)) continue;
      const identity = useCaseIdentity(ref);
      v1UseCases.add(identity);
      const bucket = v1ReadsByUseCase.get(identity) ?? new Set<string>();
      for (const r of reads) bucket.add(r);
      v1ReadsByUseCase.set(identity, bucket);
    }
  }
  return {
    guards,
    actions: inputs.webActionFiles.flatMap((f) => ownerActionsIn(f, guards)),
    v1UseCases,
    v1ReadsByUseCase,
    apiKeys: contractApiKeys(inputs.contractApiFiles),
    contract: kindsFromContract(inputs.contractRecordEvent),
    mobile: kindsFromMobile(inputs.mobileViewModel),
    router: kindsFromRouter(inputs.routerWriters),
    profileFields: diffFields && flagFields ? [...diffFields, ...flagFields] : null,
    composer: composerWrites(inputs.profileComposer),
    composerReached: v1ReachesComposer(inputs.v1Files),
  };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type Divergence = { key: string; detail: string };

export type Census = {
  ownerGuards: string[];
  useServerFiles: number;
  ownerActions: number;
  joinedActions: number;
  v1UseCases: number;
  contractApiKeys: number;
  kinds: { contract: number; mobile: number; router: number };
  /** Fields the web's edit writes, and how many of them a v1 command writes too. */
  profileFields: number;
  v1WritableFields: number;
  composerProperties: number;
};

export type Verdict = {
  failures: string[];
  divergences: Divergence[];
  census: Census;
};

function floor(actual: number, min: number, what: string, consequence: string): string | null {
  if (actual >= min) return null;
  return `non-vacuity: ${what} — found ${actual}, floor ${min}. ${consequence}`;
}

function vacuityFailures(inputs: ParityInputs, d: Derived, joined: number): string[] {
  return [
    floor(
      d.guards.length,
      MIN_OWNER_GUARDS,
      `owner guard exports across ${OWNER_GUARD_FILES.join(", ")}`,
      "The guards moved or were renamed; with no guards every action reads as not-an-owner-action and the fence passes by seeing nothing.",
    ),
    floor(
      inputs.webActionFiles.length,
      MIN_USE_SERVER_FILES,
      `"use server" files under ${WEB_ACTION_ROOTS.join(", ")}`,
      "The roots moved or the directive scan broke.",
    ),
    floor(
      d.actions.length,
      MIN_OWNER_ACTIONS,
      "owner-guarded actions",
      "An empty web set is trivially at parity with anything; this is the scan failing, not the web shrinking.",
    ),
    floor(
      d.v1UseCases.size,
      MIN_V1_USE_CASES,
      `use-cases reached from ${V1_ROOT}`,
      "With an empty app set every web action is a divergence — or, if the exclusions swallow it, none is. Either way the scan is broken.",
    ),
    floor(
      d.apiKeys.size,
      MIN_CONTRACT_API_KEYS,
      `property keys across ${CONTRACT_API_DIR}`,
      "The receipt check would then call every field the web shows a divergence.",
    ),
    floor(
      joined,
      MIN_JOINED_ACTIONS,
      "owner actions joined to a use-case the v1 surface reaches",
      "The join key is the shared application module; if imports moved or USE_CASE_ROOT changed, this is what it looks like.",
    ),
  ].filter((f): f is string => f !== null);
}

/** The join: every owner action against what v1 reaches and reads. */
function findDivergences(d: Derived): { divergences: Divergence[]; joined: number } {
  const divergences: Divergence[] = [];
  let joined = 0;
  for (const action of d.actions) {
    if (action.useCases.length === 0) {
      divergences.push({
        key: `unjoined:${action.name}`,
        detail: `${action.path} — ${action.name} calls no ${USE_CASE_ROOT}**${USE_CASE_LAYER}** use-case, so nothing ties it to a v1 route. The app may or may not have this; the fence cannot tell, and cannot count it as parity.`,
      });
      continue;
    }
    let anyAtParity = false;
    for (const ref of action.useCases) {
      if (!d.v1UseCases.has(useCaseIdentity(ref))) {
        divergences.push({
          key: `write:${action.name}→${ref.exported}`,
          detail: `${action.path} — ${action.name} calls ${ref.exported} (${ref.module}) and no route under ${V1_ROOT} reaches it. The web owner can do this; the app cannot.`,
        });
        continue;
      }
      anyAtParity = true;
      const v1Reads = d.v1ReadsByUseCase.get(useCaseIdentity(ref)) ?? new Set<string>();
      for (const field of action.receipt.get(ref.local) ?? []) {
        if (v1Reads.has(field) || d.apiKeys.has(field)) continue;
        divergences.push({
          key: `read:${action.name}.${field}`,
          detail: `${action.path} — ${action.name} reads \`${field}\` off ${ref.exported}'s result and can show it; no file under ${V1_ROOT} that reaches ${ref.exported} reads that field and no DTO in ${CONTRACT_API_DIR} carries it. The web shows a fact the app cannot obtain.`,
        });
      }
    }
    if (anyAtParity) joined++;
  }
  return { divergences, joined };
}

/** The census: every field the web's edit writes, against what a v1 command writes. */
function findFieldDivergences(d: Derived): { divergences: Divergence[]; writable: number } {
  const divergences: Divergence[] = [];
  let writable = 0;
  // A census it could not read reports NO gaps rather than every field as one:
  // the floor below names the broken source, and a wall of "not declared" lines
  // would bury it (the vocabulary check holds back the same way).
  if (d.profileFields === null || d.composer === null) return { divergences, writable };
  for (const f of d.profileFields) {
    if (d.composerReached && f.reads !== null && d.composer.written.has(f.reads)) {
      writable++;
      continue;
    }
    divergences.push({ key: `field:${f.field}`, detail: fieldGapDetail(f, d.composerReached) });
  }
  return { divergences, writable };
}

function fieldGapDetail(f: ProfileField, composerReached: boolean): string {
  if (f.reads === null) {
    return `${PET_DIFF} — diffPet derives \`${f.field}\` from no request value, so no edit command can write it on either door.`;
  }
  if (!composerReached) {
    return `${PROFILE_COMPOSER} — no route under ${V1_ROOT} calls ${PROFILE_COMPOSER_EXPORT}, so no v1 command writes \`${f.field}\`. The web owner can edit it; the app cannot.`;
  }
  return `${PROFILE_COMPOSER} — ${PROFILE_COMPOSER_EXPORT} carries \`${f.reads}\` from the stored row on every v1 edit, so no v1 command writes \`${f.field}\`. The web owner can edit it; the app cannot.`;
}

/** The census's own floors: a source it cannot read must fail, never pass. */
function fieldCensusVacuityFailures(d: Derived): string[] {
  const failures: string[] = [];
  if (d.profileFields === null) {
    failures.push(
      `non-vacuity: could not derive the profile field list from ${PET_DIFF} (diffPet's \`{ field: "…" }\` entries) and ${UPDATE_PET_USE_CASE} (\`const flagChanged = parsed.…\`). A file moved, a function was renamed or the entries were reshaped; a census of nothing must not read as parity.`,
    );
  } else {
    const f = floor(
      d.profileFields.length,
      MIN_PROFILE_FIELDS,
      "profile fields the web's edit writes",
      "Either the diff really shrank — say so by lowering MIN_PROFILE_FIELDS — or the parser is missing entries.",
    );
    if (f !== null) failures.push(f);
  }
  if (d.composer === null) {
    failures.push(
      `non-vacuity: could not derive what ${PROFILE_COMPOSER_EXPORT} writes from ${PROFILE_COMPOSER}: the file is unreadable, the function was renamed, or its \`return { … }\` literal was reshaped. Without it every field reads as unwritable — or, swallowed by declarations, as nothing.`,
    );
  } else {
    const f = floor(
      d.composer.properties,
      MIN_COMPOSER_PROPERTIES,
      `properties in ${PROFILE_COMPOSER_EXPORT}'s returned ParsedPet`,
      "The composer must build the whole row the writer stores; fewer properties is the parser losing them.",
    );
    if (f !== null) failures.push(f);
  }
  return failures;
}

function setDiff(a: string[], b: string[]): string[] {
  const bs = new Set(b);
  return a.filter((x) => !bs.has(x));
}

function describeDisagreement(
  aName: string,
  a: string[],
  bName: string,
  b: string[],
): string | null {
  const onlyA = setDiff(a, b);
  const onlyB = setDiff(b, a);
  if (onlyA.length === 0 && onlyB.length === 0) return null;
  const parts = [
    onlyA.length > 0 ? `in ${aName} only: ${onlyA.join(", ")}` : null,
    onlyB.length > 0 ? `in ${bName} only: ${onlyB.join(", ")}` : null,
  ].filter((p): p is string => p !== null);
  return `kind vocabulary: ${aName} and ${bName} disagree — ${parts.join("; ")}. A kind the contract accepts must have a form on the phone and a branch in the router; a kind in one place only is a door that exists on paper.`;
}

/** The three vocabularies: each must parse, clear the floor, and agree. */
function vocabularyFailures(d: Derived): string[] {
  const failures: string[] = [];
  const vocab: Array<[string, string, string[] | null]> = [
    ["contract", CONTRACT_RECORD_EVENT, d.contract],
    ["mobile", MOBILE_VIEW_MODEL, d.mobile],
    ["router", ROUTER_WRITERS, d.router],
  ];
  for (const [label, path, kinds] of vocab) {
    if (kinds === null) {
      failures.push(
        `non-vacuity: could not derive the ${label} kind vocabulary from ${path}. The file is unreadable, or the export the parser anchors on (kind: z.literal / WRITABLE_KINDS / EVENT_TYPE_OF_KIND) was renamed or reshaped. A vocabulary of nothing must not read as parity.`,
      );
    } else if (kinds.length < MIN_KINDS) {
      failures.push(
        `non-vacuity: derived only ${kinds.length} kind(s) from ${path} (floor ${MIN_KINDS}). Either the vocabulary really shrank — say so by lowering MIN_KINDS — or the parser is missing rows.`,
      );
    }
  }
  if (d.contract && d.mobile && d.router) {
    for (const f of [
      describeDisagreement("contract", d.contract, "mobile", d.mobile),
      describeDisagreement("contract", d.contract, "router", d.router),
    ]) {
      if (f !== null) failures.push(f);
    }
  }
  return failures;
}

/**
 * Every divergence declared with both sentences; every declaration still live.
 * `uncomputed` names key prefixes whose scan could not run this time — their
 * declarations are not called stale, because nothing was looked for.
 */
function declarationFailures(
  divergences: Divergence[],
  declared: Record<string, DeclaredDivergence>,
  uncomputed: readonly string[] = [],
): string[] {
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const d of divergences) {
    seen.add(d.key);
    const entry = declared[d.key];
    if (entry === undefined) {
      failures.push(
        `divergence not declared: ${d.key}\n      ${d.detail}\n      Either close it, or declare it in DECLARED_DIVERGENCES (${THIS_FILE}) with a reason and what would close it.`,
      );
    } else if (entry.reason.trim().length === 0 || entry.closes.trim().length === 0) {
      failures.push(
        `declared without a reason: ${d.key} — every entry in DECLARED_DIVERGENCES needs both \`reason\` and \`closes\`. An exclusion nobody can argue with is a hole.`,
      );
    }
  }
  for (const key of Object.keys(declared)) {
    if (seen.has(key)) continue;
    if (uncomputed.some((prefix) => key.startsWith(prefix))) continue;
    failures.push(
      `stale declaration: ${key} is in DECLARED_DIVERGENCES but the scan no longer finds that divergence. Remove it in the same commit that closed it — a declaration nobody re-reads is how the next real gap gets waved through.`,
    );
  }
  return failures;
}

export function evaluate(
  inputs: ParityInputs,
  declared: Record<string, DeclaredDivergence> = DECLARED_DIVERGENCES,
): Verdict {
  const d = derive(inputs);
  const { divergences: actionDivergences, joined } = findDivergences(d);
  const fields = findFieldDivergences(d);
  const divergences = [...actionDivergences, ...fields.divergences];
  const censusRan = d.profileFields !== null && d.composer !== null;
  const failures = [
    ...vacuityFailures(inputs, d, joined),
    ...fieldCensusVacuityFailures(d),
    ...vocabularyFailures(d),
    ...declarationFailures(divergences, declared, censusRan ? [] : ["field:"]),
  ];
  return {
    failures,
    divergences,
    census: {
      ownerGuards: d.guards,
      useServerFiles: inputs.webActionFiles.length,
      ownerActions: d.actions.length,
      joinedActions: joined,
      v1UseCases: d.v1UseCases.size,
      contractApiKeys: d.apiKeys.size,
      kinds: {
        contract: d.contract?.length ?? 0,
        mobile: d.mobile?.length ?? 0,
        router: d.router?.length ?? 0,
      },
      profileFields: d.profileFields?.length ?? 0,
      v1WritableFields: fields.writable,
      composerProperties: d.composer?.properties ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run(): void {
  const verdict = evaluate(collectInputs());
  const c = verdict.census;
  const censusLine =
    `owner guards ${c.ownerGuards.join("/")}; ${c.useServerFiles} "use server" files; ` +
    `${c.ownerActions} owner-guarded actions, ${c.joinedActions} joined to the v1 surface; ` +
    `${c.v1UseCases} use-cases reached from ${V1_ROOT}; ` +
    `kinds contract ${c.kinds.contract} / mobile ${c.kinds.mobile} / router ${c.kinds.router}; ` +
    `${c.contractApiKeys} v1 DTO keys; ` +
    `${c.profileFields} profile fields the web's edit writes, ${c.v1WritableFields} writable from ${V1_ROOT}.`;

  if (verdict.failures.length > 0) {
    console.error(`\n✗ Owner-surface parity — ${verdict.failures.length} failure(s):\n`);
    for (const f of verdict.failures) console.error(`  · ${f}\n`);
    console.error(`  Census: ${censusLine}`);
    process.exit(1);
  }

  console.log(`✓ Owner-surface parity — ${censusLine}`);
  console.log(
    `  ${verdict.divergences.length} declared divergence(s) pending in the native app (DECLARED_DIVERGENCES in ${THIS_FILE}):`,
  );
  for (const d of verdict.divergences.slice().sort((a, b) => a.key.localeCompare(b.key))) {
    console.log(`    · ${d.key}`);
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-owner-surface-parity.ts") ||
    process.argv[1].endsWith("check-owner-surface-parity.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) run();
