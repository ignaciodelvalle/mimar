// Raw <button> ratchet — CI guard (design-system consolidation).
//
// Enforces that literal `<button` elements do not increase across two
// surfaces, tracked with SEPARATE baselines so burn-down stays legible:
//   - operator/government/org  (app/gob, app/admin, app/org)
//   - citizen                  (components/**, app/(app), app/(public), app/(auth))
// The target is full adoption of the LnButton (components/ui/Button.tsx) and
// OpButton (components/ui/dashboard/OpButton.tsx) primitives instead of raw
// `<button>` tags, so touch targets, focus rings, and disabled/loading
// states stay consistent across the design system.
//
// Rule (per surface):
//   Count literal `<button` occurrences (case-sensitive tag open) in .tsx
//   files under that surface's glob (test files excluded). If the TOTAL
//   count for a surface is greater than its BASELINE, fail. If a PR migrates
//   raw buttons to LnButton/OpButton and lowers a surface's count, update
//   that surface's BASELINE down to the new total in the same change — the
//   ratchet only ever tightens. The two counts are never merged: an operator
//   regression must not be masked by citizen headroom, or vice versa.
//
// Run: node scripts/check-raw-buttons.mjs   (or: pnpm lint:buttons)
// Exits 0 when both surfaces are clean; exits 1 listing each file's count
// (per surface) when either surface's total exceeds its baseline.

import { globSync, readFileSync } from "node:fs";

import { stripComments } from "./lib/strip-comments.mjs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Total literal `<button` occurrences across app/gob, app/admin, app/org
 *  measured on 2026-07-04 (task #41, design-system consolidation ratchets).
 *  2026-07-05: operator OpButton burn-down migrated 137 raw <button>s to
 *  OpButton across app/gob, app/admin, app/org — baseline lowered 182 → 46.
 *  Remaining 46 are intentional: segmented toggles (aria-pressed), pure
 *  text-links (underline, no chrome), icon-only micro-controls, and buttons
 *  carrying a `ref` for ConfirmDialog focus-restore (OpButton forwards no ref).
 *  2026-07-08: +3 pure text-links (underline, no chrome — OpButton's
 *  primary/ghost/danger/ok variants all carry bg+border chrome, so forcing
 *  these in would change their appearance) — FinalizeAdoptionForm.tsx's two
 *  offline-adoption toggle links (commit 151e217d) and OrgBiteForm.tsx's
 *  "usar mi ubicación" link (commit b5e03ff2). Flagged for PO design sign-off.
 *  Baseline raised 46 → 49.
 *  2026-07-19: +2 vaccine-catalog option-picker rows in the atender console's
 *  AtenderVaccinationGate.tsx (fuzzy-match candidate list) — full-width,
 *  left-aligned selectable rows with a dashed escape-hatch ("no está en el
 *  catálogo"); this is a pick-list option pattern, not a centered action
 *  button, so OpButton (which centers content + carries action chrome) would
 *  degrade scanability and lose the escape-hatch signal. The console's submit
 *  button WAS migrated to OpButton in the same change. Baseline raised 49 → 51.
 *  2026-07-19: a11y batch — ReasignarButton.tsx and DevolverAlDuenoButton.tsx
 *  (app/gob/decomisos/_components) migrated their hand-rolled `<dialog>`
 *  modals onto ConfirmDialog (focus trap + Escape + focus-restore); each
 *  trigger carries a `ref` for ConfirmDialog's focus-restore, which OpButton
 *  cannot forward (+2). Same change converted OrgBiteForm.tsx's victim-type
 *  button trio into native radio inputs (-3). Baseline moved 51 → 52.
 *  (That line used to read "Net: baseline lowered 51 → 52". 51 to 52 is a
 *  RISE, and -3+2 is -1, so neither the direction nor the arithmetic matched
 *  what the constant actually did. Corrected 2026-07-31; the constant itself
 *  was not touched, only the sentence describing it.)
 *  2026-07-21: audit-3-feedback §C2 — IncomingTransferActions.tsx converted
 *  its accept/reject inline mode-switch panel onto ConfirmDialog (matching
 *  friction to the citizen-facing AcceptTransferActions.tsx equivalent for
 *  a custody-changing action); both triggers carry a `ref` for
 *  ConfirmDialog's focus-restore, same OpButton limitation as above (+2).
 *  The surface had also drifted down to 51 (unrelated cleanup) since the
 *  52 baseline was set, so the net change lands at 53, not 54.
 *  Baseline set 52 → 53.
 *  E4 (2026-07-21 facades harvest): CancelTransferAction.tsx adds ONE
 *  ConfirmDialog trigger button for the newly-wired custody-transfer cancel
 *  action (audit-3-feedback §C2 consequence-copy convention) — same OpButton
 *  ref limitation, same sanctioned workaround already used by
 *  IncomingTransferActions.tsx/ReasignarButton.tsx/DevolverAlDuenoButton.tsx/
 *  RemoveMemberButton.tsx. Baseline set 53 → 54.
 *  2026-07-21: adoption-reversal facade harvest — ReverseAdoptionAction.tsx
 *  (app/org/[orgToken]/mascotas/[publicToken]/) adds ONE ConfirmDialog
 *  trigger button for the newly-wired "Revertir adopción" action, same
 *  sanctioned ref-for-focus-restore workaround. Baseline set 54 → 55.
 *  Target: 0, via migration to LnButton (citizen) / OpButton (operator).
 *  Lower this number as files migrate — never raise it without a design
 *  review sign-off (raw <button> reintroduces inconsistent touch targets,
 *  focus rings, and loading/disabled states). */
// 2026-07-31: counting moved onto comment-stripped source. 55 → 54; the one
// that vanished was never shipped chrome, only prose naming a `<button`.
const OPERATOR_BASELINE = 54;
const OPERATOR_SCAN_GLOB = "{app/gob,app/admin,app/org}/**/*.tsx";
const OPERATOR_LABEL = "operator (app/gob, app/admin, app/org)";

/** Total literal `<button` occurrences across the citizen surface —
 *  components/**, app/(app), app/(public), app/(auth) — measured on
 *  2026-07-19 (consistency-fences pass, widened from operator-only scan).
 *  This is a SEPARATE ratchet from the operator baseline above: the two
 *  surfaces migrate independently (LnButton for citizen, OpButton for
 *  operator), so merging the counts would hide a regression in either one
 *  behind headroom in the other.
 *  2026-07-21 (Fase C, saved-views primitive): SavedViewsPopover.tsx's 4 raw
 *  buttons were extracted into the new shared components/ui/dashboard/
 *  SavedViewsControl.tsx (net +4 there, -4 in the now-thin wrapper — no new
 *  raw buttons overall), and the run also picked up an unrelated -2 drift.
 *  Baseline lowered 325 → 323 to lock in the net gain.
 *  2026-07-23 (visual review V3, mobile polish — design-review sign-off):
 *  net +2. (+1) the NEW shared OpIconButton primitive's single internal raw
 *  <button> — the topbar's mobile search trigger/close now consume it instead
 *  of two hand-rolled buttons (same net-positive shape as SavedViewsControl
 *  above). (+1) OpFilterBar's mobile FILTROS summary row: a full-width
 *  disclosure bar that neither LnButton nor OpButton models (ghost's border
 *  would double-frame it inside the card); if a second consumer of that shape
 *  appears, extract an OpDisclosureRow primitive and fold this back.
 *  2026-07-29 (D.1 button-radius canon): the surface had drifted DOWN to 323
 *  on its own since the 325 above was set, and the fence had been reporting
 *  the improvement without anyone locking it in. Lowered 325 → 323 to bank it;
 *  no buttons were migrated in that change, only their radius retargeted.
 *  Target: 0, via migration to LnButton (components/ui/Button.tsx).
 *  Lower this number as files migrate — never raise it without a design
 *  review sign-off (raw <button> reintroduces inconsistent touch targets,
 *  focus rings, and loading/disabled states). */
// 2026-07-31: counting moved onto comment-stripped source. 323 → 309. FOURTEEN
// of the tracked "raw buttons" on this surface were comments. That is not a
// tidy-up: the phantoms were headroom. Until this change, up to 14 genuinely
// new raw <button>s could land on the citizen surface and the ratchet would
// still report clean, because it was holding budget for prose.
// 2026-08-01 (panorama ContextBar): 309 → 310, ONE button, same sanctioned
// shape as the disclosure row above. The bar's segment trigger is a disclosure
// PILL — ref for focus-restore, aria-expanded/aria-controls, a count badge and
// a chevron as children, `rounded-full`, and an open/closed border+bg pair.
// OpButton cannot model it: its `base` hardcodes `rounded-[--radius-op-btn]`,
// which an appended `rounded-full` does not reliably beat (equal specificity,
// stylesheet order decides), and `ghost` hardcodes the border color the open
// state has to repaint. Forcing it through would fork the variant table.
// The bar's other two buttons DID migrate in this change (Copiar vista →
// OpButton ghost, panel close → OpIconButton), so the file adds 1, not 3.
// NOTE for whoever revisits the scoping: components/panorama/* is OPERATOR
// chrome counted against the CITIZEN baseline, because these globs are
// directory-based and everything under components/ lands here. That is a
// measurement artifact, not a claim about the surface.
// If a second disclosure pill appears, extract OpDisclosurePill and fold both.
const CITIZEN_BASELINE = 307;
const CITIZEN_SCAN_GLOB = "{components,app/(app),app/(public),app/(auth)}/**/*.tsx";
const CITIZEN_LABEL = "citizen (components/**, app/(app), app/(public), app/(auth))";

const RAW_BUTTON = /<button\b/g;

// ---------------------------------------------------------------------------
// Button RADIUS rule (X2-S2, PO decision 2026-07-29)
// ---------------------------------------------------------------------------
//
// WHY THIS WAS ADDED: for a long time globals.css declared the pill "canonical
// … for buttons and badges" while LnButton shipped 3px, the landing 8px and the
// operator 6px. Four surfaces, one compliant, and NOTHING in CI to notice —
// because the only statement of the rule was a CSS comment, and comments do not
// fail builds. This fence existed the whole time and guarded a different
// property (raw <button> counts), which is exactly why the radius drifted
// freely: a rule nobody can break is not the same as a rule nobody enforces.
//
// The rule now has two values and two homes, and this counts every violation:
//   citizen  → --radius-pill    (components/ui/Button.tsx)
//   operator → --radius-op-btn  (components/ui/dashboard/OpButton.tsx)
//
// SCOPE — `<button>` ONLY, and that boundary is deliberate. The first draft of
// this rule also scanned `<a>` and `<Link>` and reported 310 violations, almost
// all of them legitimate: in this app an anchor is very often a CARD (the org
// pet cards carry --radius-md) or a nav item, not a button. A fence that flags
// correct code gets an allowlist entry and then gets ignored, which is worse
// than no fence. A `<button>`, in contrast, is unambiguously a button.
//
// Button-styled ANCHORS were still codemodded in the same change (26 of them)
// and belong on LnLinkButton; they are pushed there by the raw-count ratchets
// above rather than by a radius rule that cannot tell a CTA from a card.
//
// RATCHET, not a hard zero: some pre-existing values are numerically identical
// to the tokens (`rounded-full` == pill) or carry a fallback
// (`--radius-op-btn,6px`, which OpButton itself writes). Those are
// harmless-but-untokenized. The count may only go DOWN — which stops NEW drift
// the day it is written, the property that was missing all along.
const RADIUS_TAGS = ["button"];
const RADIUS_UTILITY =
  /\brounded-(?!\[var\(--radius-(?:pill|op-btn)(?:,[a-z0-9]+)?\)\]|full\b)[a-z0-9[\]()\-.%,]+/g;

/**
 * Walk the opening tags of the interactive elements in `src` and return every
 * radius utility that is not one of the two sanctioned tokens.
 *
 * Brace-aware: a tag ends at the first `>` at brace depth 0, so a `>` inside a
 * className expression (a ternary, a template literal) does not truncate the
 * span and hide the rest of the attributes.
 */
/** Index of the `>` that closes the tag opened at `from`, ignoring any `>` that
 *  sits inside a braced expression (a ternary, a template literal). */
function tagEnd(src, from) {
  let depth = 0;
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return j;
  }
  return src.length - 1;
}

/** True when `<tag` at this index is the whole tag name, so `<a` does not match
 *  `<article` / `<aside`. */
function isTagBoundary(ch) {
  return ch === " " || ch === "\n" || ch === "\t" || ch === ">";
}

/** The `[start, end)` spans of every `<tag …>` opening tag in `src`. */
function openingTagSpans(src, tag) {
  const open = `<${tag}`;
  const spans = [];
  let i = 0;
  while (true) {
    const at = src.indexOf(open, i);
    if (at === -1) return spans;
    if (isTagBoundary(src[at + open.length])) {
      const end = tagEnd(src, at + open.length);
      spans.push([at, end + 1]);
      i = end + 1;
    } else {
      i = at + open.length;
    }
  }
}

// Same comment-stripping as countRawButtons, for the same reason: a commented-out
// `<button className="rounded-[6px]">` is not shipped chrome. Stripping preserves
// offsets, so the spans this walks still line up with the original file.
export function findUntokenizedButtonRadii(src) {
  const stripped = stripComments(src);
  const found = [];
  for (const tag of RADIUS_TAGS) {
    for (const [start, end] of openingTagSpans(stripped, tag)) {
      for (const m of stripped.slice(start, end).matchAll(RADIUS_UTILITY)) found.push(m[0]);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// CSS button rules (2026-08-05) — the same two properties, in stylesheets
// ---------------------------------------------------------------------------
//
// WHY: every rule above reads .tsx and matches Tailwind utilities. A button
// styled by a STYLESHEET is invisible to all of it, and the landing is styled by
// a stylesheet. globals.css:811 carries the confession in its own comment: the
// commit that declared the two radius tokens named "the landing 8px" as one of
// the four drifting surfaces, then did not fix it, "because the fence it added
// reads `rounded-*` utilities in JSX and .lp-btn is CSS". The result shipped:
// "Crear cuenta" was a rectangle while /signup, one click away, was all pills.
// Widening this scan found a second one still live — `.lp .lp-lost-btn` at a raw
// 10px — which is fixed in the same change.
//
// The lint:tokens CSS scan (scripts/css-token-scan.ts) does count raw radii and
// below-floor font sizes per FILE, but as one aggregate budget: a new 8px button
// radius lands inside globals.css's existing headroom and nothing goes red. This
// rule is button-CONTEXT and starts at zero, so it cannot hide there.
//
// FLOOR: the font-size floor is --text-xs, read from app/globals.css — the same
// floor css-token-scan uses. Deliberately not a stricter button-specific number:
// that would be a design decision, and this fence's job is to enforce the ones
// already made, not to invent one.
const CSS_SCAN_GLOB = "app/**/*.css";

/**
 * Selectors that style a button: the bare `button` element, any class carrying
 * `btn` as part of its name (`.lp-btn`, `.ln-btn--ghost`, `.btn`), or an
 * attribute selector pinning the input type.
 */
const CSS_BUTTON_SELECTOR =
  /(?:^|[\s,>+~])button\b|\.[\w-]*btn[\w-]*|\[type=["']?(?:button|submit)/i;

/** A radius value that is already one of the two sanctioned tokens, or a shape. */
const CSS_RADIUS_OK = /var\(\s*--radius-(?:pill|op-btn)\b/;

const CSS_TEXT_XS_DECL = /--text-xs:\s*(\d+(?:\.\d+)?)px/;
const DEFAULT_FONT_FLOOR_PX = 10;

/** The --text-xs floor in px, read from a stylesheet source. */
export function cssFontFloorPx(globalsCss) {
  const m = CSS_TEXT_XS_DECL.exec(globalsCss);
  return m === null ? DEFAULT_FONT_FLOOR_PX : Number(m[1]);
}

/** Minimum px expressed by a font-size value (px and rem; em is unknowable). */
function minPxIn(value) {
  const pxs = [
    ...[...value.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])),
    ...[...value.matchAll(/(\d+(?:\.\d+)?)rem/g)].map((m) => Number(m[1]) * 16),
  ];
  return pxs.length === 0 ? null : Math.min(...pxs);
}

/**
 * Button-context violations in one stylesheet.
 *
 * The walker matches innermost `selector { decls }` blocks — `[^{}]*` cannot
 * cross a brace, so a rule nested in an `@media` is found on its own and the
 * captured selector never carries the at-rule prelude.
 *
 * Comments are stripped first (newline-preserving, so reported lines stay true):
 * globals.css documents this very rule in prose that quotes the values it
 * forbids, and a fence that read its own documentation would flag it.
 */
export function findCssButtonViolations(css, floorPx = DEFAULT_FONT_FLOOR_PX) {
  const src = stripComments(css);
  const out = { radius: [], fontBelowFloor: [] };
  const blockRe = /([^{}]*)\{([^{}]*)\}/g;
  let m = blockRe.exec(src);
  while (m !== null) {
    const selector = m[1].trim().replace(/\s+/g, " ");
    const body = m[2];
    if (CSS_BUTTON_SELECTOR.test(selector)) {
      const line = src.slice(0, m.index).split("\n").length;
      for (const d of body.matchAll(/border-radius\s*:\s*([^;]+)/gi)) {
        const value = d[1].trim();
        const isShapeOrZero = /^0(px|%)?$/.test(value) || /^\d+(?:\.\d+)?%$/.test(value);
        if (CSS_RADIUS_OK.test(value) || isShapeOrZero) continue;
        out.radius.push({ line, selector, value });
      }
      for (const d of body.matchAll(/font-size\s*:\s*([^;]+)/gi)) {
        const value = d[1].trim();
        const min = minPxIn(value);
        if (min !== null && min < floorPx) out.fontBelowFloor.push({ line, selector, value });
      }
    }
    m = blockRe.exec(src);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core logic (exported for unit tests)
// ---------------------------------------------------------------------------

// Counted on comment-stripped source. Before that, a comment that merely NAMED
// a raw <button> was tallied as one — so writing an accurate note about the
// hand-rolled button you were replacing pushed the surface over its baseline,
// and the cheapest way out was to reword the comment or re-baseline upward.
// Both make the fence worse. Strings are still counted (see strip-comments).
export function countRawButtons(src) {
  return [...stripComments(src).matchAll(RAW_BUTTON)].length;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Scan one surface against its baseline. Returns true if clean (total <= baseline). */
function scanSurface({ label, glob, baseline, scriptName }) {
  const files = globSync(glob)
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.includes(".test."))
    .sort();

  if (files.length === 0) {
    console.error(`✗ check-raw-buttons: no files found for ${label} surface.`);
    return false;
  }

  const perFile = [];
  let total = 0;

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const count = countRawButtons(src);
    if (count > 0) {
      perFile.push({ file, count });
      total += count;
    }
  }

  if (total > baseline) {
    perFile
      .sort((a, b) => b.count - a.count)
      .forEach(({ file, count }) => {
        console.error(`${file}: ${count} raw <button> occurrence(s)`);
      });
    console.error(
      `\n✗ ${total} raw <button> occurrence(s) across ${label} — baseline allows ${baseline}. Migrate new raw buttons to LnButton (components/ui/Button.tsx) or OpButton (components/ui/dashboard/OpButton.tsx).`,
    );
    return false;
  }

  if (total < baseline) {
    console.log(
      `✓ [${label}] raw <button> count improved: ${total} (baseline ${baseline}). Lower ${scriptName} in scripts/check-raw-buttons.mjs to ${total} to lock in the gain.`,
    );
    return true;
  }

  console.log(
    `✓ [${label}] raw <button> count clean — ${total} occurrence(s) across ${files.length} file(s), at baseline (${baseline}).`,
  );
  return true;
}

/** Untokenized radii on raw `<button>`s, measured 2026-07-29 right after the
 *  codemod that retargeted 119 hand-copied `rounded-[3px]` onto the two tokens.
 *  These survivors carry a CARD or SMALL radius on a button (--radius-md,
 *  --radius-sm, a raw 5px), which is the same drift in a different costume.
 *  Target 0, by migrating the button to LnButton / OpButton — which also clears
 *  it from the raw-count ratchets above, so the two fences pull the same way.
 *  Lower these as files migrate; never raise them. */
const OPERATOR_RADIUS_BASELINE = 18;
// 2026-07-29: citizen lowered 105 → 104 in the same change — LostFiltersBars
// raw "Buscar" (danger red, --radius-sm) migrated to LnButton primary, and its
// "Limpiar" Link to LnButton anchor mode.
// 2026-09-16: stays at 101, and the reason is a correction worth reading.
// A first pass lowered this to 100 crediting the LnToggle a11y refactor. That
// attribution was fabricated and a review caught it: RADIUS_TAGS is ["button"]
// only, so the old layout <div>'s --radius-sm was never counted, and
// RADIUS_UTILITY excludes the word-bounded `full`, so the old track's
// rounded-full was not counted either. The refactor's real delta was ZERO;
// the surface had already drifted to 100 for reasons nobody located, and
// banking it here would have spent an unrelated gain under a false story.
// Meanwhile the refactor DID put a --radius-sm on a real <button> for the first
// time, and the first version hid it inside a hoisted class string where this
// scanner cannot see it. Toggle.tsx now writes it in the opening tag on
// purpose, so the count is honest at 101.
const CITIZEN_RADIUS_BASELINE = 101;

function scanRadii({ label, glob, baseline, scriptName }) {
  const files = globSync(glob, { exclude: (p) => /\.test\.tsx$/.test(p) });
  const perFile = [];
  let total = 0;
  for (const file of files) {
    const hits = findUntokenizedButtonRadii(readFileSync(file, "utf8"));
    if (hits.length > 0) {
      perFile.push({ file, count: hits.length, utils: [...new Set(hits)].join(" ") });
      total += hits.length;
    }
  }

  if (total > baseline) {
    perFile
      .sort((a, b) => b.count - a.count)
      .forEach(({ file, count, utils }) => {
        console.error(`${file}: ${count} untokenized button radius (${utils})`);
      });
    console.error(
      `\n✗ ${total} untokenized button radius on raw <button> across ${label} — baseline allows ${baseline}. A button's radius comes from ONE of two tokens: --radius-pill (citizen, components/ui/Button.tsx) or --radius-op-btn (operator, components/ui/dashboard/OpButton.tsx). Prefer migrating the button to LnButton/OpButton over hand-writing either.`,
    );
    return false;
  }

  if (total < baseline) {
    console.log(
      `✓ [${label}] button-radius drift improved: ${total} (baseline ${baseline}). Lower ${scriptName} in scripts/check-raw-buttons.mjs to ${total} to lock in the gain.`,
    );
    return true;
  }

  console.log(
    `✓ [${label}] button radius clean — ${total} untokenized on raw <button>, at baseline (${baseline}).`,
  );
  return true;
}

/** Button-context violations in stylesheets. Both baselines start at ZERO: the
 *  scan found exactly one hit on its first run (`.lp .lp-lost-btn`'s raw 10px)
 *  and it was fixed in the same change rather than baselined, so the rule
 *  begins its life as an absolute ban. Do not raise these — a button styled in
 *  CSS drifts exactly the way a button styled in JSX does, and this fence exists
 *  because nothing was watching the CSS half for months. */
const CSS_BUTTON_RADIUS_BASELINE = 0;
const CSS_BUTTON_FONT_BASELINE = 0;

function scanCssButtons() {
  const files = globSync(CSS_SCAN_GLOB)
    .map((f) => f.replaceAll("\\", "/"))
    .sort();

  if (files.length === 0) {
    console.error("✗ check-raw-buttons: no stylesheets found for the CSS button scan.");
    return false;
  }

  const globals = files.find((f) => f.endsWith("app/globals.css"));
  const floorPx = cssFontFloorPx(globals === undefined ? "" : readFileSync(globals, "utf8"));

  const radiusHits = [];
  const fontHits = [];
  for (const file of files) {
    const { radius, fontBelowFloor } = findCssButtonViolations(readFileSync(file, "utf8"), floorPx);
    for (const h of radius) radiusHits.push({ file, ...h });
    for (const h of fontBelowFloor) fontHits.push({ file, ...h });
  }

  let ok = true;

  if (radiusHits.length > CSS_BUTTON_RADIUS_BASELINE) {
    for (const h of radiusHits) {
      console.error(`${h.file}:${h.line}: { ${h.selector} } border-radius: ${h.value}`);
    }
    console.error(
      `\n✗ ${radiusHits.length} untokenized button radius in CSS — baseline allows ${CSS_BUTTON_RADIUS_BASELINE}. A button's radius comes from ONE of two tokens: --radius-pill (citizen) or --radius-op-btn (operator). This rule exists because the landing's buttons drifted for months inside a stylesheet no button fence read.`,
    );
    ok = false;
  }

  if (fontHits.length > CSS_BUTTON_FONT_BASELINE) {
    for (const h of fontHits) {
      console.error(`${h.file}:${h.line}: { ${h.selector} } font-size: ${h.value}`);
    }
    console.error(
      `\n✗ ${fontHits.length} button font-size below the --text-xs floor (${floorPx}px) in CSS — baseline allows ${CSS_BUTTON_FONT_BASELINE}. lint:tokens counts these per FILE, where a new one hides inside globals.css's existing budget; in button context it starts at zero.`,
    );
    ok = false;
  }

  if (ok) {
    console.log(
      `✓ [css] button rules clean — ${files.length} stylesheet(s) scanned, 0 untokenized button radii and 0 button font-sizes below the ${floorPx}px floor.`,
    );
  }
  return ok;
}

function runScan() {
  const operatorOk = scanSurface({
    label: OPERATOR_LABEL,
    glob: OPERATOR_SCAN_GLOB,
    baseline: OPERATOR_BASELINE,
    scriptName: "OPERATOR_BASELINE",
  });

  const citizenOk = scanSurface({
    label: CITIZEN_LABEL,
    glob: CITIZEN_SCAN_GLOB,
    baseline: CITIZEN_BASELINE,
    scriptName: "CITIZEN_BASELINE",
  });

  const operatorRadiusOk = scanRadii({
    label: OPERATOR_LABEL,
    glob: OPERATOR_SCAN_GLOB,
    baseline: OPERATOR_RADIUS_BASELINE,
    scriptName: "OPERATOR_RADIUS_BASELINE",
  });

  const citizenRadiusOk = scanRadii({
    label: CITIZEN_LABEL,
    glob: CITIZEN_SCAN_GLOB,
    baseline: CITIZEN_RADIUS_BASELINE,
    scriptName: "CITIZEN_RADIUS_BASELINE",
  });

  const cssOk = scanCssButtons();

  if (!operatorOk || !citizenOk || !operatorRadiusOk || !citizenRadiusOk || !cssOk) {
    process.exit(1);
  }
}

// Guard: only scan when run directly; importing from tests exposes
// countRawButtons without triggering the filesystem scan.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-raw-buttons.mjs") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
