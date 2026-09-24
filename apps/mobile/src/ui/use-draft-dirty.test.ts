// `sameDraft` — the predicate that decides whether a discard guard may
// interrupt somebody (A2-alta-asentar-08).
//
// WHY IT HAS ITS OWN FILE. It is the reason eight writer screens went without a
// guard for a week: the obvious predicate (`draft !== emptyDraft()`) is object
// identity between two different objects and is therefore TRUE THE INSTANT THE
// SCREEN MOUNTS. A guard on that predicate asks "¿Salir sin guardar?" of
// everybody who opened a form and read the first field, which teaches them to
// dismiss it — and then it is not there on the day they had filled in ten.

import { describe, expect, it } from "@jest/globals";

import { sameDraft } from "./use-draft-dirty";

describe("sameDraft", () => {
  it("calls two DIFFERENT objects with the same values the same", () => {
    // THE WHOLE POINT. `emptyDraft()` builds a new object every call, so
    // reference equality answers "changed" for a form nobody has touched.
    expect(sameDraft({ name: "", kg: "" }, { name: "", kg: "" })).toBe(true);
  });

  it("sees a single edited field", () => {
    expect(sameDraft({ name: "", kg: "" }, { name: "", kg: "12,5" })).toBe(false);
  });

  it("does not care about key order", () => {
    expect(sameDraft({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
  });

  it("treats a MISSING key as a difference", () => {
    // Not the same shape, so not the same draft. Answering `true` here would be
    // a guard that goes quiet when a form gains a field.
    expect(sameDraft({ a: "1", b: "2" }, { a: "1" })).toBe(false);
    expect(sameDraft({ a: "1" }, { a: "1", b: "2" })).toBe(false);
  });

  it("distinguishes an empty string from null and from undefined", () => {
    // Three different facts on these forms: "typed nothing", "the server has
    // nothing" and "this key is not part of the draft". `Object.is` keeps them
    // apart where `==` would fold two of them together.
    expect(sameDraft({ a: "" }, { a: null })).toBe(false);
    expect(sameDraft({ a: null }, { a: undefined })).toBe(false);
  });

  it("compares booleans and numbers by value", () => {
    expect(sameDraft({ on: true, n: 1 }, { on: true, n: 1 })).toBe(true);
    expect(sameDraft({ on: true, n: 1 }, { on: false, n: 1 })).toBe(false);
  });

  it("says nothing changed when a character was typed and deleted again", () => {
    // Not a hole: the form IS what it was, and not asking is the right answer.
    const before = { note: "hola" };
    expect(sameDraft(before, { note: "hola" })).toBe(true);
  });
});
