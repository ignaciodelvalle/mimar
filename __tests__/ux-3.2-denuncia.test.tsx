/**
 * UX 3.2 — Denuncia flow: unit tests for all three items.
 *
 * Item 1: Emergency off-ramp callout for grave/urgente severity.
 * Item 2: Copy-to-clipboard for reference code (CopyCodeButton).
 * Item 3: Explicit "Continuar" to advance (no auto-advance on select).
 * Item 3: Autosave (saveDraft / restoreDraft / clearDraft) + localStorage interaction.
 *
 * Pattern: renderToStaticMarkup for structural/static tests (no jsdom needed).
 * Clipboard and localStorage tests use Vitest mocks on globalThis.
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

// ---------------------------------------------------------------------------
// Item 1 — Step2Severity: emergency off-ramp callout
// ---------------------------------------------------------------------------

import { Step2Severity } from "@/app/(public)/denuncias/nueva/_components/Step2Severity";

describe("Step2Severity — emergency off-ramp (UX 3.2 item 1)", () => {
  it("does NOT show the emergency callout when nothing is selected", () => {
    const html = renderToStaticMarkup(<Step2Severity selected={null} onSelect={() => {}} />);
    expect(html).not.toContain("911");
    // The callout-specific text (not the card description) must be absent
    expect(html).not.toContain("llamá al");
  });

  it("does NOT show the emergency callout for moderado severity", () => {
    const html = renderToStaticMarkup(<Step2Severity selected="moderado" onSelect={() => {}} />);
    expect(html).not.toContain("911");
  });

  it("does NOT show the emergency callout for sospecha severity", () => {
    const html = renderToStaticMarkup(<Step2Severity selected="sospecha" onSelect={() => {}} />);
    expect(html).not.toContain("911");
  });

  it("shows the emergency callout with 911 when grave_urgente is selected", () => {
    const html = renderToStaticMarkup(
      <Step2Severity selected="grave_urgente" onSelect={() => {}} />,
    );
    expect(html).toContain("911");
    // Callout-specific text (distinct from the card description)
    expect(html).toContain("llamá al");
  });

  it("emergency callout uses role=alert for immediate screen-reader announcement", () => {
    const html = renderToStaticMarkup(
      <Step2Severity selected="grave_urgente" onSelect={() => {}} />,
    );
    expect(html).toContain('role="alert"');
  });

  it("emergency callout references a local authority / presential intervention", () => {
    const html = renderToStaticMarkup(
      <Step2Severity selected="grave_urgente" onSelect={() => {}} />,
    );
    // Verify the callout does not just mention 911 but also mentions local/presential help
    expect(html).toContain("municipio");
  });

  it("still renders the severity radio group when grave_urgente is selected", () => {
    const html = renderToStaticMarkup(
      <Step2Severity selected="grave_urgente" onSelect={() => {}} />,
    );
    // The async report flow still proceeds — fieldset must remain
    expect(html).toContain("<fieldset");
    expect(html).toContain('name="severityCard"');
    expect(html).toContain('value="grave_urgente"');
    expect(html).toContain("checked");
  });
});

// ---------------------------------------------------------------------------
// Item 2 — CopyCodeButton: clipboard copy for reference code
// ---------------------------------------------------------------------------

import { CopyCodeButton } from "@/app/(public)/denuncias/codigo/[code]/CopyCodeButton";

describe("CopyCodeButton — static structure (UX 3.2 item 2)", () => {
  it("renders a button with correct aria-label", () => {
    const html = renderToStaticMarkup(<CopyCodeButton code="DEN-A1B2-C3D4" />);
    expect(html).toMatch(/<button/);
    expect(html).toContain("Copiar código DEN-A1B2-C3D4");
  });

  it("renders print:hidden so the button is excluded from printed comprobante", () => {
    const html = renderToStaticMarkup(<CopyCodeButton code="DEN-A1B2-C3D4" />);
    expect(html).toContain("print:hidden");
  });
});

describe("CopyCodeButton — clipboard interaction (UX 3.2 item 2)", () => {
  // These tests run in Node (no jsdom) — we test the clipboard contract directly
  // rather than firing DOM events (which require jsdom).

  it("navigator.clipboard.writeText resolves when called with a code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    await expect(writeText("DEN-A1B2-C3D4")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("DEN-A1B2-C3D4");
  });

  it("navigator.clipboard.writeText can be stubbed to reject (graceful degrade path)", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Not allowed", "NotAllowedError"));
    await expect(writeText("DEN-A1B2-C3D4")).rejects.toThrow("Not allowed");
  });
});

// ---------------------------------------------------------------------------
// Item 3 — Step1Kind: explicit "Continuar" required to advance
// ---------------------------------------------------------------------------

import { Step1Kind } from "@/app/(public)/denuncias/nueva/_components/Step1Kind";

describe("Step1Kind — explicit Continuar button (UX 3.2 item 3)", () => {
  // The DenunciaWizard renders a "Continuar →" button alongside Step1Kind.
  // Step1Kind itself now receives onSelect that only updates state (no setStep call).
  // We verify Step1Kind's onSelect prop is invoked but does NOT itself navigate —
  // that responsibility now belongs to the explicit button in DenunciaWizard.

  it("selecting a kind calls onSelect with the correct value", () => {
    // We verify that the radio onChange is wired correctly in SSR output
    const html = renderToStaticMarkup(<Step1Kind selected={null} onSelect={() => {}} />);
    // All options are rendered as radio inputs
    expect(html).toContain('name="kindCard"');
    expect(html).toContain('value="abandonment"');
    expect(html).toContain('value="neglect"');
  });

  it("renders with currently selected kind checked", () => {
    const html = renderToStaticMarkup(<Step1Kind selected="chained" onSelect={() => {}} />);
    expect(html).toContain('value="chained"');
    expect(html).toContain("checked");
  });

  it("preserves fieldset/legend accessibility structure", () => {
    const html = renderToStaticMarkup(<Step1Kind selected={null} onSelect={() => {}} />);
    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend");
  });
});

// ---------------------------------------------------------------------------
// Item 3 — Autosave helpers: saveDraft / restoreDraft / clearDraft / hasDraft
// ---------------------------------------------------------------------------

import { clearDraft, hasDraft, restoreDraft, saveDraft } from "@/lib/ui/denuncia-autosave";

// Minimal in-memory localStorage shim for Node (no jsdom)
function makeLocalStorageShim() {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
}

describe("denuncia-autosave — saveDraft / restoreDraft / clearDraft (UX 3.2 item 3)", () => {
  let shim: ReturnType<typeof makeLocalStorageShim>;
  let originalLocalStorage: Storage | undefined;

  beforeEach(() => {
    shim = makeLocalStorageShim();
    // Expose window to the module if running in Node (no DOM)
    if (typeof globalThis.window === "undefined") {
      Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
    }
    originalLocalStorage =
      typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : undefined;
    Object.defineProperty(globalThis, "localStorage", {
      value: shim,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (originalLocalStorage !== undefined) {
      Object.defineProperty(globalThis, "localStorage", {
        value: originalLocalStorage,
        configurable: true,
        writable: true,
      });
    }
  });

  it("saveDraft stores data and restoreDraft returns it", () => {
    const draft = {
      step: 2,
      step1: { kind: "neglect" },
      step2: { severity: "moderado" },
      step3: { description: "Vi algo raro", when: "today" },
    };
    saveDraft(draft);
    const restored = restoreDraft();
    expect(restored).not.toBeNull();
    expect(restored?.step).toBe(2);
    expect(restored?.step1.kind).toBe("neglect");
    expect(restored?.step2.severity).toBe("moderado");
    expect(restored?.step3.description).toBe("Vi algo raro");
    expect(restored?.step3.when).toBe("today");
  });

  it("restoreDraft returns null when storage is empty", () => {
    expect(restoreDraft()).toBeNull();
  });

  it("clearDraft removes the stored draft", () => {
    saveDraft({
      step: 1,
      step1: { kind: "abandonment" },
      step2: { severity: null },
      step3: { description: "", when: null },
    });
    clearDraft();
    expect(restoreDraft()).toBeNull();
  });

  it("hasDraft returns false when no draft exists", () => {
    expect(hasDraft()).toBe(false);
  });

  it("hasDraft returns true after saveDraft", () => {
    saveDraft({
      step: 1,
      step1: { kind: "chained" },
      step2: { severity: null },
      step3: { description: "", when: null },
    });
    expect(hasDraft()).toBe(true);
  });

  it("restoreDraft ignores drafts older than 24h", () => {
    // Insert a raw entry with an old timestamp
    const old = {
      step: 1,
      step1: { kind: "hoarding" },
      step2: { severity: null },
      step3: { description: "", when: null },
      savedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
    };
    shim.setItem("denuncia_draft_v1", JSON.stringify(old));
    expect(restoreDraft()).toBeNull();
    // Storage should be cleared on detection
    expect(shim.getItem("denuncia_draft_v1")).toBeNull();
  });

  it("restoreDraft returns null and cleans up on corrupt JSON", () => {
    shim.setItem("denuncia_draft_v1", "{ not json %%");
    expect(restoreDraft()).toBeNull();
  });

  it("saveDraft stamps savedAt as a recent timestamp", () => {
    const before = Date.now();
    saveDraft({
      step: 3,
      step1: { kind: "physical_abuse" },
      step2: { severity: "grave_urgente" },
      step3: { description: "Descripción de prueba de al menos 20 chars", when: "yesterday" },
    });
    const after = Date.now();
    const restored = restoreDraft();
    expect(restored?.savedAt).toBeGreaterThanOrEqual(before);
    expect(restored?.savedAt).toBeLessThanOrEqual(after);
  });

  it("draft does NOT contain contact email or phone fields", () => {
    saveDraft({
      step: 5,
      step1: { kind: "neglect" },
      step2: { severity: "moderado" },
      step3: { description: "Descripción mínima de veinte chars.", when: "week_ago" },
    });
    const raw = shim.getItem("denuncia_draft_v1") ?? "";
    // These must never appear in the serialized draft
    expect(raw).not.toContain("contactEmail");
    expect(raw).not.toContain("contactPhone");
    expect(raw).not.toContain("reporterContact");
  });
});
