// @vitest-environment jsdom
//
// LegalMetadataFieldset is mounted by ~11 rule forms (govt_business_rules
// legal provenance columns) and owns NO action of its own — it is a shared
// fieldset inside whichever form renders it. React 19 resets the HOST form
// when ITS action settles, including on error, and every field here was
// uncontrolled (`defaultValue={initial?.x ?? ""}`): a rejected submit put
// back the row's ORIGINAL value on an edit, silently discarding the
// correction the operator just typed (forms/react19-reset-data-loss-
// inventory).
//
// Because this component does not own an action, `useKeptFields` (which
// wraps one) does not apply directly — the fix lifts the text-ish fields to
// local React state, which the hook's own docblock documents as sufficient:
// "a field is safe when its value is bound to React state AND is a text-ish
// input or textarea." The requirement-level select stays parent-controlled
// but gets the `key` remount trick.
//
// This test hosts the fieldset inside a minimal real `useActionState` form —
// same mechanism any of the 11 real screens provide — and submits for real
// via `form.requestSubmit()` (see __tests__/react19-form-reset-contract.test
// .tsx for why a dispatched event does not exercise React 19's reset).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useActionState, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RequirementLevel } from "@/db";
import { LegalMetadataFieldset, type LegalMetadataInitial } from "./LegalMetadataFieldset";

type State = { error: string | null };

/** Stand-in for one of the 11 real rule-edit screens. */
function HostForm({
  action,
  initial,
}: {
  action: (prev: State, formData: FormData) => Promise<State>;
  initial: LegalMetadataInitial;
}) {
  const [state, formAction] = useActionState(action, { error: null });
  const [tier, setTier] = useState<RequirementLevel | "">(initial.requirementLevel ?? "");

  return (
    <form action={formAction}>
      <LegalMetadataFieldset
        initial={initial}
        requirementLevel={{ value: tier, onChange: setTier, allowUnset: true }}
      />
      {state.error && <p role="alert">{state.error}</p>}
      {/* A raw button element here would trip the raw-button ui-invariant
          fence, which counts every app/gob file, tests included. The test
          drives submission via `form.requestSubmit()` regardless. */}
      <input type="submit" hidden />
    </form>
  );
}

afterEach(cleanup);

const EDIT_INITIAL: LegalMetadataInitial = {
  requirementLevel: "recommended",
  legalBasis: "Ordenanza 123/2020",
  authority: "Municipalidad",
  sourceUrl: "https://example.gov.ar/123",
  effectiveFrom: "2020-01-01",
  effectiveUntil: "",
};

describe("<LegalMetadataFieldset> — survives the host form's React 19 post-error reset", () => {
  it("keeps the CORRECTED values, not the row's original ones, after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo guardar la regla." }));
    const { container } = render(<HostForm action={action} initial={EDIT_INITIAL} />);

    const tier = container.querySelector('select[name="requirement_level"]') as HTMLSelectElement;
    const legalBasis = container.querySelector('input[name="legal_basis"]') as HTMLInputElement;
    const authority = container.querySelector('input[name="authority"]') as HTMLInputElement;
    const sourceUrl = container.querySelector('input[name="source_url"]') as HTMLInputElement;
    const effectiveFrom = container.querySelector(
      'input[name="effective_from"]',
    ) as HTMLInputElement;
    const effectiveUntil = container.querySelector(
      'input[name="effective_until"]',
    ) as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    // The row shipped "recommended" — this is the CORRECTION being typed.
    expect(tier.value).toBe("recommended");
    fireEvent.change(tier, { target: { value: "mandatory" } });
    fireEvent.change(legalBasis, { target: { value: "Ordenanza 456/2026 (corregida)" } });
    fireEvent.change(authority, { target: { value: "Ministerio de Ambiente" } });
    fireEvent.change(sourceUrl, { target: { value: "https://example.gov.ar/456" } });
    fireEvent.change(effectiveFrom, { target: { value: "2026-01-01" } });
    fireEvent.change(effectiveUntil, { target: { value: "2030-12-31" } });

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo guardar la regla.");

    // Re-queried: the select `key` change remounts it, so the earlier node is
    // detached — that remount is the fix, not an artifact to work around.
    expect(
      (container.querySelector('select[name="requirement_level"]') as HTMLSelectElement).value,
    ).toBe("mandatory");
    expect((container.querySelector('input[name="legal_basis"]') as HTMLInputElement).value).toBe(
      "Ordenanza 456/2026 (corregida)",
    );
    expect((container.querySelector('input[name="authority"]') as HTMLInputElement).value).toBe(
      "Ministerio de Ambiente",
    );
    expect((container.querySelector('input[name="source_url"]') as HTMLInputElement).value).toBe(
      "https://example.gov.ar/456",
    );
    expect(
      (container.querySelector('input[name="effective_from"]') as HTMLInputElement).value,
    ).toBe("2026-01-01");
    expect(
      (container.querySelector('input[name="effective_until"]') as HTMLInputElement).value,
    ).toBe("2030-12-31");
  });
});
