// Success-state-vs-refresh fence.
//
// THE DEFECT THIS EXISTS FOR
// ---------------------------------------------------------------------------
// In Next 15.5, ANY revalidatePath()/revalidateTag() inside a Server Action
// makes the action's response carry a fresh render of the CURRENT route, and
// the client applies it. The path argument does not narrow that: the framework
// sets `pathWasRevalidated = true` unconditionally (next/dist/server/web/
// spec-extension/revalidate.js, under "TODO: only revalidate if the path
// matches"). So a page that branches on the state the action just changed
// re-renders into its OTHER branch while the calling component is still
// waiting on the result — and a component the new tree does not contain is
// unmounted.
//
// A client component that keeps its success screen in local state
// (`setSubmitted(true)` → `<LnSuccessScreen>`) loses it there. Found
// 2026-10-06 twice in one sweep:
//
//   - MarkLostWizard: `/perdida` swaps to UpdateLastSeenForm once the pet is
//     lost; the profile's sheet swaps to a not-applicable notice. The owner of
//     a lost pet never saw "Activamos la búsqueda" nor the WhatsApp and poster
//     buttons — the two things that matter most in the first hour.
//   - DesignateCaretakerForm: `/cuidado` swaps the form for the withdraw
//     controls once an invitation is pending. "Invitación enviada" never showed.
//
// Both now end on a success ROUTE that renders from the database, and navigate
// there imperatively from the submit handler (useActionNavigate), which runs
// after the await whether or not the component is still mounted.
//
// WHAT THIS FLAGS — DELIBERATELY NARROW
// ---------------------------------------------------------------------------
// A "use client" component under app/ or components/ that
//   1. owns a success flag: `const [x, setX] = useState(…)` with setX named
//      set{Submitted,Success,Succeeded,Done,Sent…,Completed,Finished,Confirmed}
//      and called at least once with something other than false/null/undefined;
//   2. renders a success screen itself (<LnSuccessScreen> / <SuccessScreen>);
//   3. reaches a server action that revalidates — imported directly, or bound
//      by a host that renders it (`fooAction.bind(null, …)` passed as a prop).
// "Revalidates" means: the action's body calls revalidatePath/revalidateTag,
// or calls a same-file helper that does (to a fixed point), or calls an
// imported function whose module calls them (one hop, file-level).
//
// It does NOT try to prove the host branches on the changed state: that needs
// data flow no fence here has. A component that matches 1–3 and survives the
// refresh anyway (its host renders it unconditionally) goes in ALLOWED with the
// reason — that is a claim a reviewer can check against one page file.
//
// SECOND SHAPE — the effect redirect a 404 swallows. A component that
// navigates from an effect on its action state (`useActionRedirect`), reaches
// a revalidating action, and is rendered by a PAGE that can call notFound().
// BookingFormClient was this: booking a capacity-1 slot fills it, the reservar
// page re-renders as a 404, the form and its effect are gone, and the owner saw
// "not found" for a booking that went through. The 404 is the one unmount a
// fence can see without data flow; a host that merely swaps branches (the
// mark-found sheet) is not detected, and neither is a useActionState
// `state.ok` view.
//
// Run:  pnpm lint:success-refresh
// Exits 1 naming each component, the action that revalidates, and the fix.

import { existsSync, globSync, readFileSync } from "node:fs";
import { posix } from "node:path";

import ts from "typescript";

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/** Server-action modules: same filename conventions as check-action-redirect. */
export const ACTION_GLOBS = [
  "app/actions/**/*.ts",
  "src/modules/**/actions.ts",
  "src/modules/**/actions-*.ts",
  "app/**/actions.ts",
  "app/**/action.ts",
];

/** Where client components (and the pages that host them) live. */
export const COMPONENT_GLOBS = ["app/**/*.tsx", "components/**/*.tsx"];

/**
 * Components that match a shape but SURVIVE the refresh, keyed `file#Component`
 * (one component, not the whole file), each with the page fact that makes it
 * true — checkable against one host file. An entry that stops matching fails
 * the run: an exemption for nothing would quietly cover the next real match.
 * Measured 2026-10-06: these four matched; the three that did not survive
 * (MarkLostWizard, DesignateCaretakerForm, BookingFormClient) were converted.
 */
export const ALLOWED: Record<string, string> = {
  "app/gob/decomisos/nuevo/_components/DecomisoForm.tsx#DecomisoForm":
    "app/gob/decomisos/nuevo/page.tsx branches only on the operator's jurisdiction, never on the decomiso the action creates — the form stays mounted.",
  "app/org/[orgToken]/adopciones/[appEventId]/ReviewButtons.tsx#ReviewButtons":
    "page.tsx renders ReviewButtons ALWAYS, in the same slot, and passes the resolved view in as a prop — written that way so the receipt survives this exact refresh.",
  "app/org/[orgToken]/mascotas/[publicToken]/transfer/TransferCustodyForm.tsx#TransferCustodyForm":
    "transfer/page.tsx answers notFound() only when the org no longer holds the pet, and transferCustodyAction opens a receiver-consent handshake — the pet stays under the source org until the receiver accepts, so the re-render keeps the form.",
  "app/org/[orgToken]/transferencias/nueva/ProposeTransferForm.tsx#ProposeTransferForm":
    "Proposing leaves shelter_custody with the sender until the receiver accepts, so nueva/page.tsx (gated on active custody) re-renders the same form.",
};

/**
 * Non-vacuity floors, measured 2026-10-06: 103 server-action modules, 185
 * revalidating functions in them, 465 "use client" components scanned. A
 * parser or glob regression reads 0 and would print a green verdict over
 * nothing; the floors sit well below the measurement and far above zero.
 */
export const MIN_ACTION_MODULES = 60;
export const MIN_REVALIDATING_ACTIONS = 90;
export const MIN_CLIENT_COMPONENTS = 300;

const SUCCESS_SETTER =
  /^set(?:Submitted|Success|Succeeded|Done|Sent|Sent[A-Z]\w*|Completed|Finished|Confirmed)$/;
const SUCCESS_SCREENS = new Set(["LnSuccessScreen", "SuccessScreen"]);
const REVALIDATORS = new Set(["revalidatePath", "revalidateTag"]);

/** A virtual file tree: path (forward slashes, repo-relative) → source. */
export type Corpus = Map<string, string>;

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function parse(file: string, source: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

function hasDirective(sf: ts.SourceFile, directive: string): boolean {
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) return false;
    if (stmt.expression.text === directive) return true;
  }
  return false;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  const go = (n: ts.Node) => {
    visit(n);
    ts.forEachChild(n, go);
  };
  ts.forEachChild(node, go);
}

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function calledNames(node: ts.Node): Set<string> {
  const out = new Set<string>();
  walk(node, (n) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name) out.add(name);
    }
  });
  return out;
}

/** Top-level functions: declarations and `const x = (async) (…) => …`. */
function topLevelFunctions(sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      out.set(stmt.name.text, stmt);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        if (
          ts.isIdentifier(decl.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          out.set(decl.name.text, init);
        }
      }
    }
  }
  return out;
}

/** local name → module specifier, for every named/default import. */
function importsOf(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const spec = stmt.moduleSpecifier.text;
    if (clause.name) out.set(clause.name.text, spec);
    const nb = clause.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (!el.isTypeOnly) out.set(el.name.text, spec);
      }
    }
  }
  return out;
}

const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** Resolve `@/x` and relative specifiers against the corpus. Null when external. */
export function resolveSpecifier(fromFile: string, spec: string, corpus: Corpus): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  else return null;
  for (const suffix of RESOLVE_SUFFIXES) {
    if (corpus.has(base + suffix)) return base + suffix;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export type ActionIndex = {
  /** server-action module path → exported action name → revalidates? */
  modules: Map<string, Map<string, boolean>>;
};

function fileCallsRevalidate(source: string): boolean {
  return /\brevalidate(?:Path|Tag)\s*\(/.test(source);
}

/** Calls revalidate*() itself, or calls an imported function whose module does (one hop). */
function revalidatesDirectly(
  file: string,
  called: Set<string>,
  imports: Map<string, string>,
  corpus: Corpus,
): boolean {
  if ([...called].some((n) => REVALIDATORS.has(n))) return true;
  return [...called].some((n) => {
    const spec = imports.get(n);
    const target = spec ? resolveSpecifier(file, spec, corpus) : null;
    return target !== null && fileCallsRevalidate(corpus.get(target) ?? "");
  });
}

/** Same-file helpers, to a fixed point (setPetLostAction → revalidateLostStatePages). */
function propagateWithinFile(calls: Map<string, Set<string>>, revalidates: Map<string, boolean>) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, called] of calls) {
      if (revalidates.get(name) || ![...called].some((n) => revalidates.get(n))) continue;
      revalidates.set(name, true);
      changed = true;
    }
  }
}

function moduleRevalidation(file: string, sf: ts.SourceFile, corpus: Corpus): Map<string, boolean> {
  const imports = importsOf(sf);
  const calls = new Map<string, Set<string>>();
  for (const [name, node] of topLevelFunctions(sf)) calls.set(name, calledNames(node));
  const revalidates = new Map<string, boolean>();
  for (const [name, called] of calls) {
    revalidates.set(name, revalidatesDirectly(file, called, imports, corpus));
  }
  propagateWithinFile(calls, revalidates);
  return revalidates;
}

export function indexServerActions(corpus: Corpus, actionFiles: string[]): ActionIndex {
  const modules = new Map<string, Map<string, boolean>>();
  for (const file of actionFiles) {
    const source = corpus.get(file);
    if (source === undefined) continue;
    const sf = parse(file, source);
    if (hasDirective(sf, "use server")) modules.set(file, moduleRevalidation(file, sf, corpus));
  }
  return { modules };
}

export type ViolationKind = "success-state" | "effect-redirect-404";

export type Violation = {
  /** `file#Component` — the unit ALLOWED is keyed on. */
  key: string;
  component: string;
  file: string;
  kind: ViolationKind;
  /** The setter that raises the success flag, or "useActionRedirect". */
  via: string;
  actions: string[];
};

type ComponentNode = { name: string; node: ts.Node };

/** Top-level capitalised functions of a file — the components it declares. */
function componentsOf(sf: ts.SourceFile): ComponentNode[] {
  return [...topLevelFunctions(sf)]
    .filter(([name]) => /^[A-Z]/.test(name))
    .map(([name, node]) => ({ name, node }));
}

function successSetters(node: ts.Node): Set<string> {
  const setters = new Set<string>();
  walk(node, (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isArrayBindingPattern(n.name) &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      calleeName(n.initializer) === "useState"
    ) {
      const second = n.name.elements[1];
      if (second && ts.isBindingElement(second) && ts.isIdentifier(second.name)) {
        if (SUCCESS_SETTER.test(second.name.text)) setters.add(second.name.text);
      }
    }
  });
  return setters;
}

function isFalsyLiteral(arg: ts.Expression): boolean {
  return (
    arg.kind === ts.SyntaxKind.FalseKeyword ||
    arg.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(arg) && arg.text === "undefined")
  );
}

/**
 * Shape 1: the component keeps a success flag AND draws a success screen
 * itself. Returns the setter that raises the flag, or null.
 */
function successStateSetter(node: ts.Node): string | null {
  const setters = successSetters(node);
  if (setters.size === 0) return null;
  let raised: string | null = null;
  let screen = false;
  walk(node, (n) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      const arg = n.arguments[0];
      if (name && setters.has(name) && arg && !isFalsyLiteral(arg)) raised = name;
    }
    if (
      (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
      ts.isIdentifier(n.tagName) &&
      SUCCESS_SCREENS.has(n.tagName.text)
    ) {
      screen = true;
    }
  });
  return raised && screen ? raised : null;
}

/** Shape 2's client half: the component navigates from an effect on its action state. */
function usesEffectRedirect(node: ts.Node): boolean {
  return calledNames(node).has("useActionRedirect");
}

/** Identifiers a component node references — to scope file-level imports to it. */
function referencedNames(node: ts.Node): Set<string> {
  const out = new Set<string>();
  walk(node, (n) => {
    if (ts.isIdentifier(n)) out.add(n.text);
  });
  return out;
}

/** Revalidating actions the component reaches through its own file's imports. */
function revalidatingActionsUsed(
  file: string,
  sf: ts.SourceFile,
  component: ComponentNode,
  corpus: Corpus,
  index: ActionIndex,
): string[] {
  // A module-level adapter (BookingFormClient's makeFormAction) calls the action
  // on the component's behalf, so names referenced by top-level helpers the
  // component references count as its own.
  const helpers = topLevelFunctions(sf);
  const names = referencedNames(component.node);
  for (const ref of [...names]) {
    const helper = helpers.get(ref);
    if (helper && !/^[A-Z]/.test(ref)) {
      for (const n of referencedNames(helper)) names.add(n);
    }
  }
  const out: string[] = [];
  for (const [local, spec] of importsOf(sf)) {
    if (!names.has(local)) continue;
    const target = resolveSpecifier(file, spec, corpus);
    if (target && index.modules.get(target)?.get(local)) out.push(`${local} (${target})`);
  }
  return out;
}

/** Server actions a HOST binds and hands down: `fooAction.bind(null, …)`. */
function boundActionsIn(
  hostFile: string,
  hostSf: ts.SourceFile,
  corpus: Corpus,
  index: ActionIndex,
): string[] {
  const imports = importsOf(hostSf);
  const out: string[] = [];
  walk(hostSf, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "bind" &&
      ts.isIdentifier(n.expression.expression)
    ) {
      const local = n.expression.expression.text;
      const spec = imports.get(local);
      const target = spec ? resolveSpecifier(hostFile, spec, corpus) : null;
      if (target && index.modules.get(target)?.get(local)) out.push(`${local} (${target})`);
    }
  });
  return out;
}

/** Files that import this component from this file. */
function hostsOf(
  file: string,
  component: string,
  parsed: Map<string, ts.SourceFile>,
  corpus: Corpus,
): Array<[string, ts.SourceFile]> {
  const out: Array<[string, ts.SourceFile]> = [];
  for (const [hostFile, hostSf] of parsed) {
    if (hostFile === file) continue;
    const spec = importsOf(hostSf).get(component);
    if (spec !== undefined && resolveSpecifier(hostFile, spec, corpus) === file) {
      out.push([hostFile, hostSf]);
    }
  }
  return out;
}

/** A host PAGE that can answer notFound() — the render that replaces the whole tree. */
function hostCanNotFound(hostFile: string, hostSf: ts.SourceFile): boolean {
  return /\/page\.tsx$/.test(hostFile) && calledNames(hostSf).has("notFound");
}

export type Analysis = {
  /** Every match, exemptions included — what ALLOWED is checked against. */
  raw: Violation[];
  /** Matches not covered by ALLOWED. */
  violations: Violation[];
  /** ALLOWED keys that no longer match anything: an exemption for nothing. */
  staleAllowed: string[];
  actionModules: number;
  revalidatingActions: number;
  clientComponents: number;
};

function classify(
  file: string,
  sf: ts.SourceFile,
  component: ComponentNode,
  parsed: Map<string, ts.SourceFile>,
  corpus: Corpus,
  index: ActionIndex,
): Violation | null {
  const setter = successStateSetter(component.node);
  const effectRedirect = usesEffectRedirect(component.node);
  if (!setter && !effectRedirect) return null;

  const hosts = hostsOf(file, component.name, parsed, corpus);
  const actions = new Set(revalidatingActionsUsed(file, sf, component, corpus, index));
  for (const [hostFile, hostSf] of hosts) {
    for (const a of boundActionsIn(hostFile, hostSf, corpus, index)) actions.add(a);
  }
  if (actions.size === 0) return null;

  const key = `${file}#${component.name}`;
  const base = { key, component: component.name, file, actions: [...actions].sort() };
  if (setter) return { ...base, kind: "success-state", via: setter };
  // Shape 2: an effect-based redirect is only lost when the re-render removes
  // the component; the certain case a fence can see is a host page that 404s.
  if (hosts.some(([hostFile, hostSf]) => hostCanNotFound(hostFile, hostSf))) {
    return { ...base, kind: "effect-redirect-404", via: "useActionRedirect" };
  }
  return null;
}

export function analyze(
  corpus: Corpus,
  actionFiles: string[],
  componentFiles: string[],
  allowed: Record<string, string> = ALLOWED,
): Analysis {
  const index = indexServerActions(corpus, actionFiles);
  const parsed = new Map<string, ts.SourceFile>();
  for (const file of componentFiles) {
    const source = corpus.get(file);
    if (source !== undefined) parsed.set(file, parse(file, source));
  }

  let clientComponents = 0;
  const raw: Violation[] = [];
  for (const [file, sf] of parsed) {
    if (!hasDirective(sf, "use client")) continue;
    clientComponents++;
    for (const component of componentsOf(sf)) {
      const v = classify(file, sf, component, parsed, corpus, index);
      if (v) raw.push(v);
    }
  }
  raw.sort((a, b) => a.key.localeCompare(b.key));
  const rawKeys = new Set(raw.map((v) => v.key));

  const revalidatingActions = [...index.modules.values()]
    .flatMap((names) => [...names.values()])
    .filter(Boolean).length;
  return {
    raw,
    violations: raw.filter((v) => !allowed[v.key]),
    staleAllowed: Object.keys(allowed)
      .filter((k) => !rawKeys.has(k))
      .sort(),
    actionModules: index.modules.size,
    revalidatingActions,
    clientComponents,
  };
}

// ---------------------------------------------------------------------------
// The canary — the fence's teeth, checked in the lane that gates a push
// ---------------------------------------------------------------------------

/**
 * The bug as it was, in miniature: a host binds a revalidating action and hands
 * it to a wizard that flips `submitted` and draws the success screen in place.
 * The real-corpus run is refused unless the analyzer flags this — a parser or
 * matcher regression must turn the fence red, never quietly green.
 */
export const CANARY: Corpus = new Map([
  [
    "app/actions/canary.ts",
    `"use server";
import { revalidatePath } from "next/cache";
async function refreshPages(token: string) { revalidatePath(\`/x/\${token}\`); }
export async function markCanaryAction(token: string) { await refreshPages(token); return { ok: true }; }`,
  ],
  [
    "app/canary/Wizard.tsx",
    `"use client";
import { useState } from "react";
import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
export function Wizard({ action }: { action: () => Promise<{ ok: boolean }> }) {
  const [submitted, setSubmitted] = useState(false);
  async function go() { const r = await action(); if (r.ok) setSubmitted(true); }
  if (submitted) return <LnSuccessScreen title="Listo" next={[]} />;
  return <button type="button" onClick={go}>Ir</button>;
}`,
  ],
  [
    "app/canary/page.tsx",
    `import { markCanaryAction } from "@/app/actions/canary";
import { Wizard } from "./Wizard";
export default function Page() { return <Wizard action={markCanaryAction.bind(null, "t")} />; }`,
  ],
]);

export function canaryProblems(): string[] {
  const a = analyze(
    CANARY,
    ["app/actions/canary.ts"],
    ["app/canary/Wizard.tsx", "app/canary/page.tsx"],
  );
  if (a.violations.length === 1 && a.violations[0].key === "app/canary/Wizard.tsx#Wizard")
    return [];
  return [
    `✗ canary: the analyzer did not flag the miniature of the 2026-10-06 bug (got ${a.violations.length} violation(s)). The fence has lost its teeth; fix the analyzer before trusting a green run.`,
  ];
}

// ---------------------------------------------------------------------------
// Real corpus
// ---------------------------------------------------------------------------

function isScannable(rel: string): boolean {
  return !rel.includes("__tests__") && !/\.test\.[jt]sx?$/.test(rel) && !rel.endsWith(".d.ts");
}

function listFiles(globs: string[]): string[] {
  const seen = new Set<string>();
  for (const g of globs) {
    for (const f of globSync(g)) {
      const rel = f.replaceAll("\\", "/");
      if (isScannable(rel)) seen.add(rel);
    }
  }
  return [...seen].sort();
}

/** The corpus from disk, plus every file an import may resolve to one hop away. */
export function loadRepoCorpus(): {
  corpus: Corpus;
  actionFiles: string[];
  componentFiles: string[];
} {
  const actionFiles = listFiles(ACTION_GLOBS);
  const componentFiles = listFiles(COMPONENT_GLOBS);
  const extra = listFiles(["src/**/*.ts", "lib/**/*.ts", "app/**/*.ts"]);
  const corpus: Corpus = new Map();
  for (const f of new Set([...actionFiles, ...componentFiles, ...extra])) {
    if (existsSync(f)) corpus.set(f, readFileSync(f, "utf8"));
  }
  return { corpus, actionFiles, componentFiles };
}

export function floorProblems(a: Analysis): string[] {
  const problems: string[] = [];
  const floor = (label: string, n: number, min: number) => {
    if (n < min) problems.push(`✗ ${label}: ${n}, expected at least ${min}.`);
  };
  floor("server-action modules indexed", a.actionModules, MIN_ACTION_MODULES);
  floor("revalidating actions found", a.revalidatingActions, MIN_REVALIDATING_ACTIONS);
  floor("client components scanned", a.clientComponents, MIN_CLIENT_COMPONENTS);
  return problems;
}

function run(): void {
  const canary = canaryProblems();
  const { corpus, actionFiles, componentFiles } = loadRepoCorpus();
  const analysis = analyze(corpus, actionFiles, componentFiles);
  const vacuity = [...canary, ...floorProblems(analysis)];
  if (vacuity.length > 0) {
    for (const p of vacuity) console.error(p);
    console.error("\n✗ check-success-state-refresh cannot reach a verdict over this corpus.");
    process.exit(1);
  }

  const stale = analysis.staleAllowed;
  if (analysis.violations.length > 0 || stale.length > 0) {
    for (const v of analysis.violations) console.error(describeViolation(v));
    for (const k of stale) {
      console.error(
        `✗ ALLOWED exempts ${k}, which no longer matches anything — the component was fixed, renamed or removed. Delete the entry: an exemption for nothing hides the next real match.`,
      );
    }
    process.exit(1);
  }
  console.log(
    `✓ No success state or effect redirect lost to a revalidating action — ${analysis.clientComponents} client component(s), ${analysis.revalidatingActions} revalidating action(s) across ${analysis.actionModules} module(s), ${analysis.raw.length} exempted.`,
  );
}

function describeViolation(v: Violation): string {
  const why =
    v.kind === "success-state"
      ? `keeps its success screen in state (${v.via})`
      : "navigates from an effect (useActionRedirect) and a page that renders it can answer notFound()";
  return `✗ ${v.key} — ${why}, and reaches a revalidating action: ${v.actions.join(", ")}.
    A revalidating action re-renders the CURRENT route; when that render no longer contains
    this component (another branch, or a 404), its state and its effects die with it.
    Navigate from inside the action/submit handler (useActionNavigate), and end the flow
    on a route that renders from the database — see perdida/activada.`;
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-success-state-refresh.ts") ||
    process.argv[1].endsWith("check-success-state-refresh.js"));

if (isMain) run();
