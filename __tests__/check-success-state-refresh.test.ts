// Pins scripts/check-success-state-refresh.ts — the fence for a success screen
// held in client state behind an action whose revalidation re-renders (and can
// unmount) the component holding it. The fence reads real files; these tests
// pin both what it must flag and what it must leave alone, because a fence
// that flags too much gets allow-listed into silence.

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

function withFile(path: string, source: string) {
  const corpus = new Map(CANARY);
  corpus.set(path, source);
  return analyze(corpus, [ACTION], [WIZARD, PAGE]);
}

describe("what it flags", () => {
  it("flags the miniature of the 2026-10-06 bug (host-bound action, helper revalidates)", () => {
    expect(canaryProblems()).toEqual([]);
    const a = analyze(CANARY, [ACTION], [WIZARD, PAGE]);
    expect(a.violations).toEqual([
      { component: WIZARD, setter: "setSubmitted", actions: [`markCanaryAction (${ACTION})`] },
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
    expect(a.violations.map((v) => v.setter)).toEqual(["setSentTo"]);
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
});

describe("the real corpus", () => {
  const { corpus, actionFiles, componentFiles } = loadRepoCorpus();
  const analysis = analyze(corpus, actionFiles, componentFiles);

  it("is green and clears its non-vacuity floors", () => {
    expect(analysis.violations).toEqual([]);
    expect(floorProblems(analysis)).toEqual([]);
  });

  it("names only files that exist in ALLOWED, each with a reason", () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(corpus.has(file), file).toBe(true);
      expect(reason.length, file).toBeGreaterThan(40);
    }
  });

  it("scans the two components it was written for", () => {
    expect(componentFiles).toContain(
      "app/(app)/mis-mascotas/[publicToken]/perdida/MarkLostWizard.tsx",
    );
    expect(componentFiles).toContain(
      "app/(app)/mis-mascotas/[publicToken]/cuidado/DesignateCaretakerForm.tsx",
    );
    expect(actionFiles).toContain("src/modules/events/actions.ts");
  });
});
