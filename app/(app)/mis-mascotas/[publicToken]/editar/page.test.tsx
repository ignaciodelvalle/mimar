// `/mis-mascotas/[token]/editar` — the standalone edit page answers who may
// edit the way the sheet and the write do (owner-pet-actions, web = app).
//
// A caretaker is refused by the titular gate and reads NotTitularNotice (the
// caretaker walk in e2e/caretaker-temporal.spec.ts pins that). This file covers
// the two holders that gate lets through and `canEditPetProfile` does not — a
// user-held custody row and the org path — and a titular, as the control that
// the refusal is about the role rather than about the page.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({ access: null as unknown }));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/infra/pet-access", () => ({
  requireTitularAccess: vi.fn(async () => control.access),
}));

vi.mock("@/lib/infra/pet-identifiers", () => ({
  fetchActiveIdentifications: vi.fn(async () => ({ microchip: null, tattoo: null })),
}));

vi.mock("@/lib/infra/business-rules-resolver", () => ({
  resolveBusinessRule: vi.fn(async () => ({ payload: { breeds: [] } })),
}));

import EditPetPage from "./page";

const TOKEN = "DIM-PAMP-0001";

function accessAs(accessPath: "owner" | "org", holderRole: string | null) {
  return {
    ok: true,
    accessPath,
    holderRole,
    pet: { id: "pet-1", publicToken: TOKEN, name: "Pampa", primaryPhotoId: null },
  };
}

function open() {
  return EditPetPage({ params: Promise.resolve({ publicToken: TOKEN }) });
}

beforeEach(() => {
  control.access = null;
});

describe("EditPetPage — the form for exactly the viewers who may save it", () => {
  it.each([
    ["a user-held custody row", "owner", "shelter_custody"],
    ["the org path", "org", null],
  ] as const)(
    "sends %s back to the profile, where the grey row says why",
    async (_who, path, role) => {
      control.access = accessAs(path, role);
      await expect(open()).rejects.toThrow(`REDIRECT:/mis-mascotas/${TOKEN}`);
    },
  );

  it("renders the form for the titular — the refusal is about the role, not the page", async () => {
    control.access = accessAs("owner", "owner");
    const page = await open();
    expect(hasProp(page, "title", "Editar Pampa")).toBe(true);
  });
});

/** Whether some element in the (unrendered) tree carries `key === value`. */
function hasProp(node: unknown, key: string, value: unknown): boolean {
  if (Array.isArray(node)) return node.some((child) => hasProp(child, key, value));
  if (node === null || typeof node !== "object") return false;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (!props) return false;
  if (props[key] === value) return true;
  return hasProp(props.children, key, value);
}
