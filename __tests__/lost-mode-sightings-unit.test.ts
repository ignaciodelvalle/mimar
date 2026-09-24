// P0c pure unit tests — noteAdded schema with sighting discriminator.
// No DB, no Supabase, no network. Safe to run standalone.

import { describe, expect, it } from "vitest";

import { validateEventPayload } from "@/lib/events/event-schemas";

describe("noteAdded schema — back-compat + new optional fields (P0c)", () => {
  it("accepts legacy {category, text} shape without kind", () => {
    expect(() =>
      validateEventPayload("note_added", {
        category: "otro" as const,
        text: "Toy a dar una vuelta.",
      }),
    ).not.toThrow();
  });

  it("accepts {category, text, kind: 'sighting'}", () => {
    expect(() =>
      validateEventPayload("note_added", {
        category: "otro" as const,
        text: "Vi al perro en la esquina.",
        kind: "sighting" as const,
      }),
    ).not.toThrow();
  });

  it("accepts full sighting payload with optional fields", () => {
    expect(() =>
      validateEventPayload("note_added", {
        category: "otro" as const,
        text: "Vi al perro en la esquina.",
        kind: "sighting" as const,
        finderName: "Juan Pérez",
        finderContact: "11-1234-5678",
        photoStoragePath: null,
      }),
    ).not.toThrow();
  });

  it("accepts kind: 'finder_in_possession'", () => {
    expect(() =>
      validateEventPayload("note_added", {
        category: "otro" as const,
        text: "Tengo al perro en casa.",
        kind: "finder_in_possession" as const,
        finderName: "María García",
        finderContact: null,
        photoStoragePath: "uploads/abc123.jpg",
      }),
    ).not.toThrow();
  });

  it("rejects unknown kind values (strict enum)", () => {
    expect(() =>
      validateEventPayload("note_added", {
        category: "otro" as const,
        text: "texto",
        kind: "unknown_kind" as string as never,
      }),
    ).toThrow();
  });

  it("rejects extra unknown keys (strict schema)", () => {
    expect(() =>
      validateEventPayload("note_added", {
        category: "otro" as const,
        text: "texto",
        unexpected_key: "boom",
      }),
    ).toThrow();
  });

  it("payload_version is injected automatically", () => {
    const result = validateEventPayload("note_added", {
      category: "otro" as const,
      text: "algo",
      kind: "sighting" as const,
    }) as Record<string, unknown>;
    expect(result.payload_version).toBe(1);
  });
});
