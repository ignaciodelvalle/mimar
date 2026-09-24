// useKeptFields adoption ratchet.
//
// THE DEFECT THIS GUARDS AGAINST
// ---------------------------------------------------------------------------
// React 19 resets a `<form action={fn}>` once the action settles — INCLUDING
// when it settles with a validation error — and an uncontrolled field, a
// `<select>`, or a controlled checkbox/radio has nothing (or the WRONG thing)
// to restore from. Measured and fixed for the first time in `PregnancyEndedForm`
// (forms/react19-reset-data-loss-inventory, engram #3098): a sweep on
// 2026-09-17 found ~74 forms in this class. `lib/ui/use-kept-fields.ts` is the
// shared fix; see its docblock for the full mechanism (also measured directly
// in __tests__/react19-form-reset-contract.test.tsx).
//
// A doctrine with no enforcement is a preference (the same lesson
// lint:action-redirect's docblock names). Without this fence, a new
// `useActionState` form can ship with the exact defect the last N forms were
// migrated away from, and nothing would notice until a person loses their own
// typed answer.
//
// WHAT COUNTS AS SAFE
// ---------------------------------------------------------------------------
// A file that calls `useActionState(` is safe when it is ONE of:
//   1. It uses `useKeptFields` (imported and wired — correctness of the
//      wiring is the job of that form's own field-reset test, not this fence).
//   2. It is allowlisted: a `// kept-fields-allowlist: <reason>` comment
//      anywhere in the file. For a genuine non-form use of useActionState
//      (a single button with no typed fields to lose) or a field this fence
//      cannot see is already safe.
//   3. Every `name`-bearing `<input>`/`<textarea>`/`<select>` field in the
//      file is written in a shape this fence can prove is safe on its own —
//      currently that is ONLY a controlled text-ish `<input>`/`<textarea>`
//      (`value=` AND `onChange=` together; per the contract test, React keeps
//      a controlled text/textarea's DOM default in sync, so the reset lands
//      back on the value already there). A `<select>` is safe ONLY with
//      `defaultValue=` PAIRED WITH a changing `key=` — `value=` (genuinely
//      controlled) is NEVER safe here even with a key — see the contract
//      test's "counter-intuitive pair". A CHECKBOX/RADIO is safe as EITHER
//      `defaultChecked={keptChecked(...)}` OR `defaultChecked={<any expr>}`
//      PAIRED WITH BOTH a `key=` AND an `onChange=` (proof the expression
//      tracks live, click-updated state, not a value fixed once at mount) —
//      `checked=` (controlled), a static `defaultChecked={x === y}`, the bare
//      JSX boolean `defaultChecked`, no `defaultChecked` at all, and a keyed
//      `defaultChecked` with no `onChange=` (an ordinary React list key,
//      present on nearly every list-rendered checkbox regardless of safety —
//      AgendaRuleForm.tsx's original bug) are ALL exactly as unsafe as
//      `checked=` (T4-F1 batch 4, found via ShareLibretaSheet.tsx,
//      ExportFormClient.tsx, and AgendaRuleForm.tsx, all previously invisible
//      to this rule; FinalizeAdoptionForm.tsx's __appChoice/useFosterShortcut
//      are the genuinely-safe key+onChange shape this rule is FOR).
//
// A `useActionState<StateType, PayloadType>(` call — explicit generic type
// arguments between the name and the parens — is also detected: the
// file-level gate used to require `useActionState(` immediately, which took
// a whole file (ShareLibretaSheet.tsx) off this fence's radar (T4-F1 batch
// 4).
//
// RATCHET, NOT A HARD BAN
// ---------------------------------------------------------------------------
// Measured 2026-09-23, after T4-F1 batches 1-2: dozens of forms in this class
// still remain (damage-ordered migration, tracked in the engram inventory
// above). Failing every one at once would block unrelated work. Like
// lint:action-redirect and lint:brand, this starts at the CURRENT count and
// only fails on GROWTH — a new unsafe form, or a previously-safe one
// regressing. Each migration wave lowers BASELINE.
//
// Run: pnpm lint:kept-fields  (or: tsx scripts/check-kept-fields-adoption.ts)

import { globSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Total unsafe `useActionState` files across app/ and components/, measured
 *  after T4-F1 batch 2 (13 forms migrated: PregnancyEndedForm,
 *  WelfareReportForm, FinalizeAdoptionForm (incl. its residual radio/
 *  checkbox), CrearConsultorioForm, LegalMetadataFieldset, NoteForm,
 *  TattooForm, SymptomForm, MedicationEndForm, MedicationStartForm,
 *  ClinicalInfoForm, CheckinForm, EndFosterForm, BiteForm,
 *  DangerousBreedAttestationForm, RecordDeathInObservationForm,
 *  MinimalNewPetForm) and batch 3 (31 → 15): the `detectLocalTextWrappers`
 *  fix (dropped `CrearConsultorioForm.tsx`'s false positive, 31 → 30), 6 auth
 *  forms (LoginForm/SignupForm/ResetRequestForm/ResetCodeStep/
 *  ChangePasswordForm allowlisted — safe via the server-echo pattern or a
 *  deliberate non-restore; DniVerifyForm converted to a real controlled
 *  field, 30 → 24), and the 9 `/gob/reglas/.../nueva` rule forms
 *  (ComplianceTargetsForm, MicrochipRequiredForm, MpfExportFormatForm,
 *  NumericWindowRuleForm, ObligationRuleForm (covers
 *  RabiesVaccinationForm/SterilizationForm), PhysicalCredentialChannelsForm,
 *  PppAttestationRegistriesForm, PppBreedListForm, PppWeightThresholdForm),
 *  all migrated onto useKeptFields and each proven with a real
 *  form.requestSubmit() + mutation-tested field-reset test (24 → 15).
 *
 *  Batch 4 (the last one) started from that 15, fixed OrgCreateForm,
 *  OwnerInitiateReturnForm, ReturnAcceptanceCard, and WeightForm (15 → 11),
 *  then widened the fence's own detection — honestly, since the wider check
 *  surfaced 8 real unsafe forms it used to miss entirely (11 → 19):
 *  ShareLibretaSheet.tsx (newly IN SCOPE at all, via the
 *  useActionState<T, P>(...) generic-detection fix, on top of its own
 *  uncontrolled label + duration radio), DewormingForm, SterilizationForm,
 *  ReplaceMicrochipForm, ExportFormClient.tsx, EditOrgForm,
 *  FinalizeAdoptionForm, AgendaRuleForm. A second refinement (requiring
 *  `onChange=` alongside a plain-state `defaultChecked=`+`key=`, not `key=`
 *  alone) then cleared FinalizeAdoptionForm's __appChoice/useFosterShortcut
 *  WITHOUT any change to that form — they were already safe, a genuine fence
 *  false positive — while correctly keeping AgendaRuleForm.tsx flagged (its
 *  `key={d.value}` was an ordinary React list key with no `onChange=`, the
 *  same defect class as ShareLibretaSheet's original static
 *  `defaultChecked`). The remaining 18 (SharesManager, ShareLibretaSheet,
 *  MoveForm, UpdateLastSeenForm, BookingFormClient, SolicitarAccesoForm,
 *  RequestCapabilityForm, DecideForm, CodeEntryForm, ProposeReturnForm,
 *  AssignFosterForm, PetForm (7 unsafe `<select>`s in one file — the fence
 *  dedupes by MESSAGE TEXT, not by instance, so fixing one and re-running
 *  showed the file still flagged until every select in it was fixed),
 *  DewormingForm, SterilizationForm, ReplaceMicrochipForm, ExportFormClient,
 *  EditOrgForm, AgendaRuleForm) were each migrated onto useKeptFields (or,
 *  for PetForm's other selects, the plain-state defaultValue+key idiom) and
 *  proven with a real form.requestSubmit() + mutation-tested field-reset
 *  test — 19 → 0. Lower this every time a migration wave lands. */
export const BASELINE = 0;

/**
 * Total files carrying a `// kept-fields-allowlist:` marker, measured after
 * T4-F1 batch 3's 5 auth forms (LoginForm, SignupForm, ResetRequestForm,
 * ResetCodeStep, ChangePasswordForm) plus 2 pre-existing markers from earlier
 * batches (BiteForm, RecordDeathInObservationForm) — 7.
 *
 * A SECOND ratchet, uncounted until now (fresh-context review, T4-F1 batches
 * 3-4): the marker exempts a file from this fence ENTIRELY — see
 * `findKeptFieldsViolations`'s `ALLOWLIST_MARKER` check, which returns `[]`
 * before looking at a single field — and BASELINE only ever counted files
 * WITH a violation, so a new marker added to duck a real bug was invisible to
 * both numbers: it does not raise BASELINE's count (the file now reports
 * zero violations) and there was nothing tracking the marker itself. Every
 * field in a marked file, including ones added years from now, is invisible
 * to this fence forever, on the strength of a comment nobody has to justify
 * to anything but a code reviewer who happens to be looking. This ratchet
 * makes growing that count a DELIBERATE, tracked act — a new marker without
 * a matching bump here fails the same way a new unsafe form does. */
export const ALLOWLISTED_BASELINE = 7;

const SCAN_GLOB = "{app,components}/**/*.tsx";

const ALLOWLIST_MARKER = /\/\/\s*kept-fields-allowlist:\s*\S/;
const SAFE_TYPES = new Set(["hidden", "file", "submit", "button", "reset", "image"]);

// DIM's actual field primitives (components/ui/Field.tsx,
// components/ui/dashboard/OpField.tsx) — almost no form in this repo writes a
// bare <input>/<select>/<textarea> (that is what lint:select and
// lint:op-controls exist to ratchet down). A scan of only the raw HTML tags
// would be all but vacuous here; it has to follow the wrappers this codebase
// actually writes.
const SELECT_LIKE = new Set(["select", "LnSelect", "OpSelect"]);
const TEXT_LIKE = new Set([
  "input",
  "textarea",
  "LnInput",
  "LnTextarea",
  "LnPasswordInput",
  "OpInput",
  "OpTextarea",
]);
const CHECKBOX_RADIO_COMPONENTS = new Set(["LnCheckbox", "LnRadio", "OpCheckbox"]);
/** Always renders type="file" internally — out of scope, same as a raw file input. */
const FILE_COMPONENTS = new Set(["LnFileInput"]);

// ---------------------------------------------------------------------------
// Core logic (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Slice the full opening tag starting at `start`, tracking JSX brace depth and
 * quotes so an expression attribute containing `>` does not end it early.
 * Returns null when the tag never closes (unparseable — caller skips it).
 * (Same technique as scripts/check-op-controls.mjs's readOpeningTag.)
 */
export function readOpeningTag(src: string, start: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

function tagHasAttr(tag: string, attr: string): boolean {
  return new RegExp(`[\\s{]${attr}\\s*=`).test(` ${tag}`);
}

function tagType(tag: string): string | undefined {
  return /\btype\s*=\s*["']([\w-]+)["']/.exec(tag)?.[1];
}

/**
 * The `{...}` expression fed to `attr=`, or undefined if absent, not a
 * `{...}`, or unbalanced. Brace- and quote-balanced — same technique as
 * `readOpeningTag` — so a `}` inside a nested expression does not truncate
 * the capture early. The `[^}]*` regex this replaced did exactly that on
 * `key={`x-${value}`}`: it matched up through the `}` that closes `${value}`,
 * not the one that closes the attribute, silently handing back a truncated
 * (but, for THIS fence's substring checks, still usably-prefixed) string —
 * fresh-context review, T4-F1 batches 3-4.
 */
function attrExpr(tag: string, attr: string): string | undefined {
  const open = new RegExp(`\\b${attr}\\s*=\\s*\\{`).exec(tag);
  if (open === null) return undefined;
  const start = open.index + open[0].length;
  let depth = 1;
  let quote: string | null = null;
  for (let i = start; i < tag.length; i++) {
    const c = tag[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return tag.slice(start, i);
    }
  }
  return undefined; // unbalanced — treat as absent, same as readOpeningTag's null
}

/**
 * Every reason a field in this file is unsafe against the React 19 reset.
 * Empty when the file has no `useActionState` at all, is allowlisted, or
 * every field qualifies as safe on its own (see the module docblock's "WHAT
 * COUNTS AS SAFE"). Checked PER FIELD, not once for the whole file: a file
 * that adopted `useKeptFields` for some fields and left a raw controlled
 * checkbox next to it is exactly the shape batch 1 found in
 * `WelfareReportForm` (a hand-rolled `kept()` that missed its selects) — a
 * file-wide "it imports the hook, so it's fine" skip would have missed that
 * same bug here.
 */
const TAG_OPEN =
  /<(input|select|textarea|LnInput|LnSelect|LnTextarea|LnRadio|LnCheckbox|LnPasswordInput|LnFileInput|OpInput|OpSelect|OpTextarea|OpCheckbox)\b/g;

/**
 * `function Name(` or `const Name = (` — a LOCAL component declaration this
 * file might define its own text-field wrapper as (T4-F1 batch 3:
 * `CrearConsultorioForm`'s `Field` was invisible to the fence this way — its
 * own `<LnInput defaultValue={kept(...)} .../>` was scanned, but every CALL
 * SITE of `<Field defaultValue={kept(...)} />` was not, because `Field` is
 * not a name this fence recognizes).
 */
const LOCAL_DECL =
  /(?:^|\n)[ \t]*(?:export\s+)?(?:function\s+([A-Z]\w*)\s*\(|const\s+([A-Z]\w*)\s*(?::[^=]*)?=\s*\()/g;

/**
 * Local, single-level TEXT-field wrapper components: a component declared in
 * THIS file whose body forwards a bare `name={name}` straight through to one
 * recognized text-ish tag. Deliberately narrow — only a literal passthrough
 * (`name={name}`, the wrapper's OWN parameter) counts, never a transformed
 * value, because a transform is exactly the case this fence cannot see
 * through and must not claim to. Only text-ish wrappers are detected (not
 * select/checkbox/radio wrappers): those need the caller to ALSO control
 * `type=`/`key=` correctly, which a bare-passthrough check cannot confirm,
 * and no known form in this repo wraps a select or checkbox/radio one level
 * deep the way `CrearConsultorioForm.Field` wraps `LnInput`.
 */
interface LocalWrapperInfo {
  names: Set<string>;
  /** Absolute (full-`src`) start positions of the detected wrappers' OWN
   *  passthrough tags — excluded from the main scan so
   *  `<LnInput name={name} defaultValue={defaultValue} />` inside `Field`'s
   *  own body is not evaluated as if `name`/`defaultValue` were literal
   *  values: the wrapper's safety is judged at its CALL SITES (which the
   *  caller adds to the scan via `names`), not inside the passthrough
   *  itself. Deliberately just the ONE matched tag's position, not the
   *  wrapper's whole body range — the search window below is generously
   *  wide (no real brace-matching), and excluding the whole window would
   *  swallow any call site that happens to fall inside it too, when the
   *  wrapper is the LAST declaration in the file (measured: this silently
   *  hid CrearConsultorioForm's own call sites during development). */
  ownTagStarts: Set<number>;
}

function detectLocalTextWrappers(src: string): LocalWrapperInfo {
  // Pass 1: collect every local declaration's name and the position right
  // after its `(` (where its body starts, params included — fine, since
  // pass 2 only looks for a name={name} passthrough inside the window).
  const decls: { name: string; bodyStart: number }[] = [];
  const declOpen = new RegExp(LOCAL_DECL.source, "g");
  let d: RegExpExecArray | null = declOpen.exec(src);
  while (d !== null) {
    const name = d[1] ?? d[2];
    if (name) decls.push({ name, bodyStart: declOpen.lastIndex });
    d = declOpen.exec(src);
  }

  // Pass 2: for each declaration, bound its search window to the START of
  // the NEXT declaration (or a fixed cap) and look for a text-ish tag inside
  // it that forwards `name={name}` verbatim.
  const names = new Set<string>();
  const ownTagStarts = new Set<number>();
  for (let i = 0; i < decls.length; i++) {
    const { name, bodyStart } = decls[i];
    const windowEnd = decls[i + 1]
      ? decls[i + 1].bodyStart
      : Math.min(src.length, bodyStart + 4000);
    const window = src.slice(bodyStart, windowEnd);

    const innerTagOpen = new RegExp(TAG_OPEN.source, "g");
    let inner: RegExpExecArray | null = innerTagOpen.exec(window);
    while (inner !== null) {
      const innerTag = readOpeningTag(window, inner.index);
      const innerIndex = inner.index;
      inner = innerTagOpen.exec(window);
      if (innerTag === null) continue;
      const innerName = /^<(\w+)/.exec(innerTag)?.[1] ?? "";
      if (TEXT_LIKE.has(innerName) && /\bname=\{name\}/.test(innerTag)) {
        names.add(name);
        ownTagStarts.add(bodyStart + innerIndex);
        break;
      }
    }
  }
  return { names, ownTagStarts };
}

/**
 * `key={<expr>}` where `<expr>` is a template literal — the ONLY spelling
 * this fence trusts to actually CHANGE when the value it embeds changes.
 * `tagHasAttr(tag, "key")` alone (the original check) is satisfied by ANY
 * key, including an ordinary React list key like `key={d.value}` — present
 * on essentially every list-rendered element regardless of whether it has
 * anything to do with surviving the reset (AgendaRuleForm.tsx's original
 * `key={d.value}` is exactly that: it never changes for a GIVEN weekday
 * across re-renders, so it protects nothing). Every genuine fix in this repo
 * spells the key as a template literal embedding the tracked value —
 * `` key={`x-${value}`} `` — so requiring a backtick or `${` is not a stretch
 * fitted after the fact; it is the existing convention, made load-bearing
 * (fresh-context review, T4-F1 batches 3-4).
 */
function hasChangingKey(tag: string): boolean {
  const keyExpr = attrExpr(tag, "key");
  return keyExpr !== undefined && /`|\$\{/.test(keyExpr);
}

/**
 * The violation reason for ONE field tag, or undefined when it is out of
 * scope (a file component, unnamed, a safe `type=`, or an unrecognized
 * element) or already safe. Split out of `findKeptFieldsViolations` purely to
 * keep that function's branching under the complexity fence — same logic.
 */
function evaluateTag(tag: string, localTextWrappers: Set<string>): string | undefined {
  const tagName = /^<(\w+)/.exec(tag)?.[1] ?? "";
  if (FILE_COMPONENTS.has(tagName)) return undefined; // out of scope, see module docblock
  if (!tagHasAttr(tag, "name")) return undefined; // not a submitted field

  const type = tagType(tag);
  if (type && SAFE_TYPES.has(type)) return undefined;

  if (SELECT_LIKE.has(tagName)) {
    // `defaultValue=` + a changing `key=` is the whole trick, regardless of
    // where the value comes from (kept() for a FormData echo, or plain React
    // state for a parent-owned value like LegalMetadataFieldset's
    // requirement-tier select and FinalizeAdoptionForm's __appChoice —
    // neither round-trips through an action, so kept() would not apply).
    // `value=` (genuinely controlled) is NEVER safe here even paired with a
    // key — measured directly: react-dom's UPDATE path never writes
    // `defaultSelected`, only its MOUNT path does, and a controlled select
    // never takes the mount path again on a value change (it stays on the
    // same fiber). Requiring `defaultValue=` specifically is what rules that
    // shape out.
    const safe = attrExpr(tag, "defaultValue") !== undefined && hasChangingKey(tag);
    return safe
      ? undefined
      : "<select>/<LnSelect> is never safe from the post-action reset without defaultValue+a changing key (defaultSelected is only written on mount)";
  }

  // A local wrapper component detected ONLY for its text-ish passthrough
  // (`detectLocalTextWrappers` never looks inside for checkbox/radio shapes —
  // see its own docblock) can still be CALLED with `checked=`/`defaultChecked=`
  // if the wrapper happens to forward those too. Checking for those attributes
  // directly, ahead of and independent of `tagName`/`type=`, closes that gap:
  // without it, a call site like `<Wrapper name="x" value="y" checked={z}
  // onChange={...} />` falls through to the TEXT rule below, whose `controlled`
  // check (`value=` + `onChange=`) is satisfied by a checkbox's OWN `value=`
  // (the ticked value it submits, not its ticked STATE) — clearing a
  // genuinely-unsafe controlled checkbox as if it were a safe text field.
  // Latent today (no wrapper in this repo currently has this shape), closed
  // before one does (fresh-context review, T4-F1 batches 3-4).
  const isCheckboxRadio =
    CHECKBOX_RADIO_COMPONENTS.has(tagName) ||
    type === "checkbox" ||
    type === "radio" ||
    tagHasAttr(tag, "checked") ||
    tagHasAttr(tag, "defaultChecked");
  if (isCheckboxRadio) {
    if (tagHasAttr(tag, "checked")) {
      return 'a controlled checkbox/radio ("checked=") falls back to its mount value on reset';
    }
    // T4-F1 batch 4: a checkbox/radio is safe as EITHER of two shapes:
    //   1. `defaultChecked={keptChecked(...)}` — re-seeded from the FormData
    //      the form itself last submitted.
    //   2. `defaultChecked={<any expr>}` PAIRED WITH BOTH a `key=` AND an
    //      `onChange=` — the same "defaultValue+key from plain React state"
    //      idiom the <select> branch above accepts, for a value that does not
    //      round-trip through an action (FinalizeAdoptionForm's __appChoice
    //      radio and useFosterShortcut checkbox: parent-owned state, not
    //      FormData-echo). `onChange=` is the load-bearing half: it is what
    //      proves the `defaultChecked` expression actually tracks something
    //      the user's own click updates, so it evaluates to the LATEST pick
    //      on the settle-triggered re-render (unlike <select>, react-dom's
    //      UPDATE path — not just its mount path — DOES rewrite an
    //      uncontrolled checkbox/radio's `defaultChecked` on every render;
    //      see __tests__/react19-form-reset-contract.test.tsx's docblock,
    //      "`updateInput` skips `defaultChecked` whenever `checked` is
    //      non-null", i.e. it does NOT skip it when uncontrolled). `key=`
    //      ALONE is not enough: AgendaRuleForm.tsx's original
    //      `defaultChecked={defaultDays?.includes(d.value) ?? d.value <= 5}`
    //      carried an ordinary React list `key={d.value}` — present on
    //      essentially every list-rendered checkbox regardless of safety —
    //      but no `onChange=` at all, so the expression was a fixed function
    //      of props/constants that never reflected what the person actually
    //      ticked, the identical bug as ShareLibretaSheet.tsx's original
    //      `defaultChecked={opt.value === "7"}`. Requiring `key=` alone would
    //      have missed it; a first version of this fix did, and did.
    // Anything else (no `defaultChecked` at all, the bare JSX boolean
    // shorthand `defaultChecked`, or `defaultChecked={expr}` missing either
    // `key=` or `onChange=`, with no `keptChecked(` either) is a STATIC value
    // fixed at mount. A native `form.reset()` restores `checked` to that same
    // static value regardless of what the person actually ticked — the
    // identical data-loss bug as the controlled case above.
    const defaultCheckedExpr = attrExpr(tag, "defaultChecked");
    const seededFromKept =
      defaultCheckedExpr !== undefined && /\bkeptChecked\(/.test(defaultCheckedExpr);
    const keyedFromLiveState =
      defaultCheckedExpr !== undefined && hasChangingKey(tag) && tagHasAttr(tag, "onChange");
    return seededFromKept || keyedFromLiveState
      ? undefined
      : "an uncontrolled checkbox/radio without a keptChecked()-seeded (or key+onChange live-state) defaultChecked falls back to its fixed mount value on reset, discarding what was ticked";
  }

  if (!TEXT_LIKE.has(tagName) && !localTextWrappers.has(tagName)) return undefined; // unrecognized element — not this fence's business

  // Text-ish input / textarea: safe when genuinely controlled, or when its
  // defaultValue is re-seeded from kept() rather than a static default.
  const controlled = tagHasAttr(tag, "value") && tagHasAttr(tag, "onChange");
  const defaultValueExpr = attrExpr(tag, "defaultValue");
  const keptDefault = defaultValueExpr !== undefined && /\bkept\(/.test(defaultValueExpr);
  return controlled || keptDefault
    ? undefined
    : "an uncontrolled field (no value+onChange, no kept()-seeded defaultValue) loses what was typed on a rejected submit";
}

export function findKeptFieldsViolations(src: string): string[] {
  // `useActionState<StateType, PayloadType>(` — explicit generic type
  // arguments between the name and the call parens — was invisible to the
  // old `/useActionState\s*\(/` gate, which took the WHOLE FILE off this
  // fence's radar. T4-F1 batch 4: found via ShareLibretaSheet.tsx, which
  // spells it `useActionState<FormState, FormData>(boundSubmit, …)`.
  if (!/useActionState\s*(?:<[^>]*>)?\s*\(/.test(src)) return [];
  if (ALLOWLIST_MARKER.test(src)) return [];

  const { names: localTextWrappers, ownTagStarts } = detectLocalTextWrappers(src);
  const reasons = new Set<string>();
  // CALL SITES of a detected local wrapper need to be scanned too — extend
  // the tag regex with the wrapper names for THIS file only (they are not
  // globally recognized names, unlike Ln*/Op*/raw tags).
  const tagOpen =
    localTextWrappers.size === 0
      ? new RegExp(TAG_OPEN.source, "g")
      : new RegExp(`${TAG_OPEN.source}|<(${[...localTextWrappers].join("|")})\\b`, "g");
  let match: RegExpExecArray | null = tagOpen.exec(src);
  while (match !== null) {
    const index = match.index;
    const tag = readOpeningTag(src, index);
    match = tagOpen.exec(src);
    if (tag === null) continue;
    // Skip the wrapper's OWN internal tag (its passthrough already credited
    // it via `localTextWrappers` — evaluating it here would flag
    // `name={name}`/`defaultValue={defaultValue}` as if those were literal,
    // unsafe values instead of the forwarded parameters they are).
    if (ownTagStarts.has(index)) continue;
    const reason = evaluateTag(tag, localTextWrappers);
    if (reason) reasons.add(reason);
  }
  return [...reasons];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runScan(): void {
  const files = globSync(SCAN_GLOB)
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.includes(".test."))
    .sort();

  if (files.length === 0) {
    console.error("✗ check-kept-fields-adoption: no files found under app/, components/.");
    process.exit(1);
  }

  const offenders: { file: string; reasons: string[] }[] = [];
  const allowlisted: string[] = [];

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (ALLOWLIST_MARKER.test(src)) allowlisted.push(file);
    const reasons = findKeptFieldsViolations(src);
    if (reasons.length > 0) offenders.push({ file, reasons });
  }

  const total = offenders.length;
  const allowlistedTotal = allowlisted.length;
  let failed = false;

  if (total > BASELINE) {
    failed = true;
    offenders.forEach(({ file, reasons }) => {
      console.error(`${file}:`);
      for (const reason of reasons) console.error(`  - ${reason}`);
    });
    console.error(
      `\n✗ ${total} useActionState form(s) unsafe against the React 19 post-action reset — baseline allows ${BASELINE}. Wrap the action with useKeptFields (lib/ui/use-kept-fields.ts), keep every field genuinely controlled (value+onChange — never true for <select> or a checked checkbox/radio), or mark a deliberate exception with "// kept-fields-allowlist: <reason>".`,
    );
  } else if (total < BASELINE) {
    console.log(
      `✓ useKeptFields adoption improved: ${total} unsafe form(s) remaining (baseline ${BASELINE}). Lower BASELINE in scripts/check-kept-fields-adoption.ts to ${total} to lock in the gain.`,
    );
  } else {
    console.log(
      `✓ useKeptFields adoption — ${total} unsafe form(s) remaining, none new, across ${files.length} file(s) scanned (baseline ${BASELINE}).`,
    );
  }

  // Second ratchet: the allowlist marker exempts a file from every check
  // above ENTIRELY, so growing it needs its own tracked count — see
  // `ALLOWLISTED_BASELINE`'s docblock for why an untracked marker is a real
  // gap, not a theoretical one.
  if (allowlistedTotal > ALLOWLISTED_BASELINE) {
    failed = true;
    console.error(`\nkept-fields-allowlist marker found in ${allowlistedTotal} file(s):`);
    for (const file of allowlisted) console.error(`  - ${file}`);
    console.error(
      `\n✗ ${allowlistedTotal} file(s) carry a "// kept-fields-allowlist:" marker — ALLOWLISTED_BASELINE allows ${ALLOWLISTED_BASELINE}. The marker exempts a file from this fence ENTIRELY, forever, so a new one needs a deliberate, reviewed bump to ALLOWLISTED_BASELINE in scripts/check-kept-fields-adoption.ts — not just a passing lint:kept-fields run.`,
    );
  } else if (allowlistedTotal < ALLOWLISTED_BASELINE) {
    console.log(
      `✓ kept-fields-allowlist markers reduced: ${allowlistedTotal} file(s) (baseline ${ALLOWLISTED_BASELINE}). Lower ALLOWLISTED_BASELINE to ${allowlistedTotal} to lock in the gain.`,
    );
  } else {
    console.log(
      `✓ kept-fields-allowlist — ${allowlistedTotal} file(s) marked, none new (baseline ${ALLOWLISTED_BASELINE}).`,
    );
  }

  if (failed) process.exit(1);
}

// Guard: only scan when run directly; importing from tests exposes the
// checker without triggering the filesystem scan.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-kept-fields-adoption.ts") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
