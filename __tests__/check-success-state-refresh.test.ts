// Pins scripts/check-success-state-refresh.ts — the fence for client state (a
// success screen, or an effect-based redirect) that a revalidating action's
// re-render takes away by unmounting the component holding it. The fence reads
// real files; these tests pin both what it must flag and what it must leave
// alone, because a fence that flags too much gets allow-listed into silence.

import { describe, expect, it } from "vitest";

import {
  ALLOWED,
  CANARY,
  analyze,
  canaryProblems,
  floorProblems,
  loadRepoCorpus,
} from "@/scripts/check-success-state-refresh";

const ACTION = "app/actions/canary.ts";
const WIZARD = "app/canary/Wizard.tsx";
const PAGE = "app/canary/page.tsx";

function withFile(path: string, source: string, allowed: Record<string, string> = {}) {
  const corpus = new Map(CANARY);
  corpus.set(path, source);
  return analyze(corpus, [ACTION], [WIZARD, PAGE], allowed);
}

/** The BookingFormClient shape: an effect redirect under a page that can 404. */
const EFFECT_REDIRECT_WIZARD = `"use client";
import { useActionState } from "react";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { markCanaryAction } from "@/app/actions/canary";
async function adapter(_p: unknown, _f: FormData) { await markCanaryAction("t"); return { redirectTo: "/x" }; }
export function Wizard() {
  const [state, dispatch] = useActionState(adapter, { redirectTo: null });
  useActionRedirect(state.redirectTo, state);
  return <form action={dispatch} />;
}`;
const PAGE_THAT_404S = `import { notFound } from "next/navigation";
import { Wizard } from "./Wizard";
export default async function Page({ full }: { full: boolean }) {
  if (full) notFound();
  return <Wizard />;
}`;

describe("what it flags", () => {
  it("flags the miniature of the 2026-10-06 bug (host-bound action, helper revalidates)", () => {
    expect(canaryProblems()).toEqual([]);
    const a = analyze(CANARY, [ACTION], [WIZARD, PAGE], {});
    expect(a.violations.map((v) => [v.key, v.kind, v.via, v.actions])).toEqual([
      [`${WIZARD}#Wizard`, "success-state", "setSubmitted", [`markCanaryAction (${ACTION})`]],
    ]);
  });

  it("flags a directly imported action too, not only one a host binds", () => {
    const a = withFile(
      WIZARD,
      `"use client";
import { useState } from "react";
import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { markCanaryAction } from "@/app/actions/canary";
export function Wizard() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  async function go() { await markCanaryAction("t"); setSentTo("a@b.c"); }
  if (sentTo) return <LnSuccessScreen title="Listo" next={[]} />;
  return <button type="button" onClick={go}>Ir</button>;
}`,
    );
    expect(a.violations.map((v) => v.via)).toEqual(["setSentTo"]);
  });

  it("flags an effect redirect rendered by a page that can answer notFound() (the booking 404)", () => {
    const corpus = new Map(CANARY);
    corpus.set(WIZARD, EFFECT_REDIRECT_WIZARD);
    corpus.set(PAGE, PAGE_THAT_404S);
    const a = analyze(corpus, [ACTION], [WIZARD, PAGE], {});
    expect(a.violations.map((v) => [v.key, v.kind])).toEqual([
      [`${WIZARD}#Wizard`, "effect-redirect-404"],
    ]);
  });
});

describe("what it leaves alone", () => {
  it("an action that does not revalidate", () => {
    const a = withFile(
      ACTION,
      `"use server";
export async function markCanaryAction(token: string) { return { ok: token.length > 0 }; }`,
    );
    expect(a.violations).toEqual([]);
  });

  it("a component that navigates instead of drawing the success screen in place", () => {
    const a = withFile(
      WIZARD,
      `"use client";
import { useActionNavigate } from "@/lib/ui/use-action-redirect";
export function Wizard({ action }: { action: () => Promise<{ ok: boolean }> }) {
  const [navigate] = useActionNavigate();
  async function go() { const r = await action(); if (r.ok) navigate("/x/t/listo"); }
  return <button type="button" onClick={go}>Ir</button>;
}`,
    );
    expect(a.violations).toEqual([]);
  });

  it("a success flag that is only ever lowered", () => {
    const a = withFile(
      WIZARD,
      `"use client";
import { useState } from "react";
import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
export function Wizard({ action }: { action: () => Promise<{ ok: boolean }> }) {
  const [done, setDone] = useState(false);
  async function go() { await action(); setDone(false); }
  if (done) return <LnSuccessScreen title="Listo" next={[]} />;
  return <button type="button" onClick={go}>Ir</button>;
}`,
    );
    expect(a.violations).toEqual([]);
  });

  it("a server component (no 'use client')", () => {
    const source = (CANARY.get(WIZARD) ?? "").replace(`"use client";\n`, "");
    expect(withFile(WIZARD, source).violations).toEqual([]);
  });

  it("an effect redirect whose host page never 404s", () => {
    expect(withFile(WIZARD, EFFECT_REDIRECT_WIZARD).violations).toEqual([]);
  });
});

describe("ALLOWED is per component and cannot go stale", () => {
  it("an exemption covers its component only, not a sibling in the same file", () => {
    const source = `"use client";
import { useState } from "react";
import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { markCanaryAction } from "@/app/actions/canary";
export function Wizard() {
  const [done, setDone] = useState(false);
  async function go() { await markCanaryAction("t"); setDone(true); }
  if (done) return <LnSuccessScreen title="A" next={[]} />;
  return <button type="button" onClick={go}>A</button>;
}
export function Sibling() {
  const [sent, setSent] = useState(false);
  async function go() { await markCanaryAction("t"); setSent(true); }
  if (sent) return <LnSuccessScreen title="B" next={[]} />;
  return <button type="button" onClick={go}>B</button>;
}`;
    const a = withFile(WIZARD, source, { [`${WIZARD}#Wizard`]: "test" });
    expect(a.violations.map((v) => v.key)).toEqual([`${WIZARD}#Sibling`]);
    expect(a.staleAllowed).toEqual([]);
  });

  it("reports an exemption that no longer matches anything", () => {
    const a = analyze(CANARY, [ACTION], [WIZARD, PAGE], {
      [`${WIZARD}#Wizard`]: "still matches",
      [`${WIZARD}#Gone`]: "matches nothing",
    });
    expect(a.violations).toEqual([]);
    expect(a.staleAllowed).toEqual([`${WIZARD}#Gone`]);
  });
});

describe("the real corpus", () => {
  const { corpus, actionFiles, componentFiles } = loadRepoCorpus();
  const analysis = analyze(corpus, actionFiles, componentFiles);

  it("is green, has no stale exemption, and clears its non-vacuity floors", () => {
    expect(analysis.violations).toEqual([]);
    expect(analysis.staleAllowed).toEqual([]);
    expect(floorProblems(analysis)).toEqual([]);
  });

  it("without ALLOWED, flags exactly the exempted components — no more, no fewer", () => {
    const bare = analyze(corpus, actionFiles, componentFiles, {});
    expect(bare.raw.map((v) => v.key)).toEqual(Object.keys(ALLOWED).sort());
  });

  it("gives every exemption a reason", () => {
    for (const [key, reason] of Object.entries(ALLOWED)) {
      expect(key, key).toMatch(/\.tsx#[A-Z]\w*$/);
      expect(reason.length, key).toBeGreaterThan(40);
    }
  });

  it("scans the components it was written for, and the newest action module", () => {
    for (const file of [
      "app/(app)/mis-mascotas/[publicToken]/perdida/MarkLostWizard.tsx",
      "app/(app)/mis-mascotas/[publicToken]/cuidado/DesignateCaretakerForm.tsx",
      "app/(app)/turnos/buscar/[offeringToken]/reservar/[slotId]/BookingFormClient.tsx",
    ]) {
      expect(componentFiles).toContain(file);
    }
    expect(actionFiles).toContain("src/modules/events/actions.ts");
    expect(actionFiles).toContain("app/actions/resolve-place.ts");
  });
});
