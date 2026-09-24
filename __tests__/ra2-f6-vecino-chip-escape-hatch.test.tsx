// @vitest-environment jsdom
//
// RA-2 F6 — the finder of a lost animal must be able to finish registering it.
//
// The loop that was closed:
//   1. A neighbour finds a stray, registers it as found_stray with the chip.
//   2. createPetAction cross-checks the chip, finds a LOST pet, and sends them
//      to /mis-mascotas/nueva/match/[token].
//   3. They answer "No es la misma" — the card's own copy promises "podés
//      continuar con el registro de tu mascota".
//   4. The card pushed "/mis-mascotas/nueva?chipMismatched=true"… and
//      nueva/page.tsx took NO PROPS AT ALL, so nothing read that flag.
//   5. Re-entering the chip hit the same cross-check, and the `lost` branch —
//      unlike `active` three lines below it — had no forceToken bypass.
//   => back to step 2, forever. The product's central use case could not be
//      completed by anyone.
//
// WHY THIS TEST WALKS THE WHOLE PATH instead of handing createPetAction a
// forceToken: a bypass that only a test can reach is not a bypass. The
// duplicate-signature guard stayed dead code for an entire review wave exactly
// because its test constructed the flag itself. So every value here is taken
// from the previous step's real output:
//
//   card's router.push(url)  →  page's searchParams  →  the form's rendered
//   hidden input  →  the FormData the browser would post  →  createPetAction
//
// Nothing is hand-assembled in between, and the force token is signed and
// verified by the real HMAC helper (no mock), so a break anywhere in that chain
// fails this test.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalitySearchResult } from "@/lib/infra/ar-localidades";

// ---------------------------------------------------------------------------
// Module mocks — top-level, before the imports that use them.
// ---------------------------------------------------------------------------

const searchMock = vi.fn();
const pushMock = vi.fn();
const confirmChipMatchMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => "/mis-mascotas/nueva",
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("@/app/actions/chip-match", () => ({
  confirmChipMatchAction: (input: unknown) => confirmChipMatchMock(input),
}));

// LocationFields transitively imports "use server" modules that pull in @/db.
vi.mock("@/app/actions/localities", () => ({
  searchLocalitiesAction: (input: { provinceCode?: string; query: string }) => searchMock(input),
  searchLocalitiesPublicAction: (input: { provinceCode?: string; query: string }) =>
    searchMock(input),
}));

vi.mock("@/app/actions/geocoding", () => ({
  geocodeAddressAction: vi.fn(),
  geocodeAddressPublicAction: vi.fn(),
  reverseGeocodeAction: vi.fn(),
  reverseGeocodePublicAction: vi.fn(),
}));

// --- server-side deps for NewPetPage + createPetAction ---------------------

const registerPetMock = vi.fn();

vi.mock("@/db", () => {
  // NewPetPage runs a single COUNT; createPetAction only inserts notifications.
  const selectChain = {
    from: () => ({ where: () => Promise.resolve([{ petCount: 1 }]) }),
  };
  return {
    db: {
      select: () => selectChain,
      insert: () => ({ values: () => Promise.resolve(undefined) }),
      transaction: async (cb: (tx: unknown) => Promise<void>) => cb({}),
    },
    ownerships: {},
    notifications: { $inferInsert: {} },
  };
});

// requireLiveUser (T1.2) resolves the acting profile from the DATABASE, so this
// suite now transitively loads lib/infra/request-cache — whose module-level SQL
// (notification-reconcile) cannot be built from this file's deliberately partial
// @/db mock. Stubbing the cache keeps the mock surface honest: the profile read
// is not what any assertion below is about.
vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: vi.fn(async (id: string) => ({
    id,
    role: "owner",
    displayName: "Fixture",
    accountType: "personal",
    deactivatedAt: null,
    deletedAt: null,
  })),
  getJurisdictionsCached: vi.fn(async () => []),
  getOrgMembershipCached: vi.fn(async () => null),
  getOrgMembershipsCached: vi.fn(async () => []),
  getUnreadCountCached: vi.fn(async () => 0),
  getOwnedPetsCountCached: vi.fn(async () => 0),
  getOrgQueueCountsCached: vi.fn(async () => ({})),
  orgQueueCacheKey: (keys: readonly string[]) => [...keys].sort().join(","),
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: vi.fn().mockResolvedValue({ user: { id: "vecino-1" } }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "vecino-1" } } }) },
    storage: { from: () => ({ remove: vi.fn() }) },
  }),
}));

vi.mock("@/lib/infra/uploads", () => ({
  uploadAttachmentIfPresent: vi
    .fn()
    .mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null }),
}));

vi.mock("@/lib/domain/location-normalize", () => ({
  JurisdictionValidationError: class JurisdictionValidationError extends Error {},
  normalizeLocationForWrite: vi
    .fn()
    .mockResolvedValue({ province: "CABA", locality: "Belgrano", localityId: "loc-1" }),
}));

vi.mock("@/lib/infra/owner-pet-dedupe", () => ({
  findSameOwnerDuplicatePet: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/infra/pet-identifiers", () => ({
  fetchActiveIdentifications: vi.fn().mockResolvedValue({ microchip: null, tattoo: null }),
}));

vi.mock("@/lib/infra/ppp-classification", () => ({
  resolvePppClassificationForJurisdiction: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/infra/pet-access", () => ({ requirePetAccess: vi.fn() }));

vi.mock("@/src/modules/pets/application/register-pet", () => ({
  registerPet: (...args: unknown[]) => registerPetMock(...args),
}));

vi.mock("@/src/modules/pets/application/update-pet", () => ({ updatePet: vi.fn() }));
vi.mock("@/src/modules/pets/application/movement/record-movement", () => ({
  recordMovementWriter: vi.fn(),
}));
vi.mock("@/src/modules/pets/infrastructure/pets-repository", () => ({
  PetsRepository: { generatePublicToken: vi.fn(), insertPetRegistered: vi.fn() },
}));

// Redeeming a receipt appends a dispute note to the matched ACTIVE record.
// Its own DB access is out of scope here (this file walks the LOST path); the
// note itself is covered in __tests__/chip-match.test.ts.
vi.mock("@/src/modules/pets/application/chip-match/record-chip-dispute", () => ({
  recordChipDisputeAgainstActivePet: vi.fn().mockResolvedValue(undefined),
}));

// The chip cross-check is the thing under test — it stays REAL except for the
// DB lookup, which decides what the chip "matches".
const lookupByChipMock = vi.fn();
vi.mock("@/lib/infra/chip-lookup", () => ({
  lookupByChip: (code: string) => lookupByChipMock(code),
}));

// microchip-force-token is deliberately NOT mocked: the token minted in step 1
// must survive real HMAC verification in step 4, or the walk proves nothing.

import { MinimalNewPetForm } from "@/app/(app)/mis-mascotas/nueva/MinimalNewPetForm";
import { MatchConfirmationCardVecino } from "@/app/(app)/mis-mascotas/nueva/match/[matchedPetToken]/MatchConfirmationCardVecino";
import NewPetPage from "@/app/(app)/mis-mascotas/nueva/page";
import { generateForceToken } from "@/lib/infra/microchip-force-token";
import { createPetAction } from "@/src/modules/pets/actions";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHIP = "724123456789012";
const LOST_PET_TOKEN = "DIM-LOST-0001";

function makeLocality(): LocalitySearchResult {
  return {
    id: "id-02000020",
    indecId: "02000020",
    provinceCode: "AR-C" as LocalitySearchResult["provinceCode"],
    departmentName: null,
    departmentCode: null,
    localityName: "Belgrano",
    localitySlug: "belgrano",
    category: "localidad",
    provinceName: "CABA",
    matchKind: "exact",
  };
}

/** Drive paso 1 exactly as a user does — nombre, especie, provincia, localidad. */
async function completeStep1() {
  fireEvent.change(screen.getByLabelText(/^nombre/i), { target: { value: "Encontrado" } });
  fireEvent.click(screen.getByRole("button", { name: /^perro$/i }));
  fireEvent.change(screen.getByLabelText(/Provincia/), { target: { value: "AR-C" } });
  fireEvent.change(screen.getByLabelText(/Localidad o barrio/), { target: { value: "Bel" } });
  fireEvent.mouseDown(await screen.findByText("Belgrano"));
}

beforeEach(() => {
  vi.clearAllMocks();
  searchMock.mockResolvedValue({ results: [makeLocality()] });
  registerPetMock.mockResolvedValue({
    ok: true,
    value: { petId: "new-pet-id", eventId: "new-event-id", publicToken: "DIM-NEW-0001" },
    notifications: [],
  });
  if (typeof URL.createObjectURL !== "function") {
    URL.createObjectURL = () => "blob:vitest-mock";
    URL.revokeObjectURL = () => undefined;
  }
});

afterEach(cleanup);

// ---------------------------------------------------------------------------

describe("RA-2 F6 — vecino chip-match escape hatch, walked end to end", () => {
  it("closes the loop: match card → alta URL → page → form → createPetAction registers the pet", async () => {
    // ---- STEP 0. The chip the vecino typed belongs to a LOST pet. -----------
    lookupByChipMock.mockResolvedValue({
      pet: { status: "lost", publicToken: LOST_PET_TOKEN },
    });

    // ---- STEP 1. The match card. "No es la misma" → where does it send us? --
    // The writer mints the receipt; here the action boundary is mocked, but the
    // token itself is produced by the real signer, exactly as the writer does.
    //
    // The response carries the token ONLY. It used to carry the matched pet's
    // canonical chip too, which is what turned the writer into a chip oracle —
    // the card now re-uses the code this browser typed. Tests for the server
    // side of that live in __tests__/chip-match.test.ts against the real
    // writer; this file mocks the action and therefore cannot see it.
    confirmChipMatchMock.mockResolvedValue({
      ok: true,
      chipConflict: { forceToken: generateForceToken(CHIP) },
    });

    render(
      <MatchConfirmationCardVecino
        matchedPetToken={LOST_PET_TOKEN}
        attemptedMicrochipId={CHIP}
        petName="Rocco"
        petSpecies="dog"
        petBreed={null}
        petColor={null}
        petSex={null}
        petPhotoUrl={null}
        ownerFirstName="Ana"
        lastLocationText={null}
        lastLocationDate={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /no es la misma/i }));
    await waitFor(() => expect(pushMock).toHaveBeenCalled());

    // The card must present the typed code to the action: it is the vecino
    // mode's actor↔pet binding, the counterpart of the refugio claim.
    expect(confirmChipMatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ actorMode: "vecino", attemptedMicrochipId: CHIP }),
    );

    const pushedUrl: string = pushMock.mock.calls[0][0];
    // The old destination — a flag nobody read — must be gone for good.
    expect(pushedUrl).not.toContain("chipMismatched");
    expect(pushedUrl).toContain("/mis-mascotas/nueva?");
    cleanup();

    // ---- STEP 2. The page. Does it READ what the card sent? -----------------
    const query = new URLSearchParams(pushedUrl.split("?")[1]);
    const element = (await NewPetPage({
      searchParams: Promise.resolve(Object.fromEntries(query.entries())),
    })) as React.ReactElement<{
      chipConflict?: { microchipId: string; forceToken: string };
    }>;

    const chipConflict = element.props.chipConflict;
    expect(chipConflict, "nueva/page.tsx must read the card's searchParams").toBeDefined();
    expect(chipConflict?.microchipId).toBe(CHIP);

    // ---- STEP 3. The form. Does it POST the receipt the page gave it? -------
    let posted: FormData | null = null;
    render(
      <MinimalNewPetForm
        action={async (_prev, formData) => {
          posted = formData;
          return { error: null };
        }}
        chipConflict={chipConflict}
      />,
    );

    await completeStep1();
    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));
    fireEvent.click(screen.getByRole("button", { name: /^registrar mascota$/i }));

    await waitFor(() => expect(posted).not.toBeNull());
    const submitted = posted as unknown as FormData;
    expect(submitted.get("forceToken")).toBe(chipConflict?.forceToken);
    expect(submitted.get("microchipId")).toBe(CHIP);

    // ---- STEP 4. The action. Does the LOST branch honour the receipt? -------
    // Same bytes the browser just posted — nothing re-assembled by the test.
    submitted.set("acquisitionMethod", "found_stray");
    const state = await createPetAction({ error: null }, submitted);

    // The whole defect in one assertion: this must NOT be the match page again.
    expect(state.redirectTo).not.toContain("/nueva/match/");
    expect(state.error).toBeNull();
    expect(registerPetMock, "the found animal must actually get registered").toHaveBeenCalled();

    // And it is registered WITHOUT the disputed code — pet_identifications
    // chip_unique (migration 0056) is a partial UNIQUE on an active chip code,
    // so re-inserting it would have died on that index.
    const registerArgs = registerPetMock.mock.calls[0][0] as { parsed: { microchipId: unknown } };
    expect(registerArgs.parsed.microchipId).toBeNull();
  });

  it("without the receipt, the same form data still bounces to the match page", async () => {
    // The guard rail for the assertion above: prove the redirect is real and
    // that it is the TOKEN, not some unrelated change, that unblocks it.
    lookupByChipMock.mockResolvedValue({
      pet: { status: "lost", publicToken: LOST_PET_TOKEN },
    });

    let posted: FormData | null = null;
    render(
      <MinimalNewPetForm
        action={async (_prev, formData) => {
          posted = formData;
          return { error: null };
        }}
      />,
    );

    await completeStep1();
    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));
    fireEvent.change(screen.getByLabelText(/número de microchip/i), { target: { value: CHIP } });
    fireEvent.click(screen.getByRole("button", { name: /^registrar mascota$/i }));

    await waitFor(() => expect(posted).not.toBeNull());
    const submitted = posted as unknown as FormData;
    expect(submitted.get("forceToken")).toBeNull();

    submitted.set("acquisitionMethod", "found_stray");
    const state = await createPetAction({ error: null }, submitted);

    // The chip rides along because the match page and its confirm action both
    // demand proof the caller knows the colliding code (chip-oracle fix).
    expect(state.redirectTo).toBe(`/mis-mascotas/nueva/match/${LOST_PET_TOKEN}?chip=${CHIP}`);
    expect(registerPetMock).not.toHaveBeenCalled();
  });

  it("a token signed for a DIFFERENT chip does not unlock the lost branch", async () => {
    // The receipt is HMAC-bound to the code it adjudicated; a stolen token from
    // another conflict must not register a pet holding someone else's chip.
    lookupByChipMock.mockResolvedValue({
      pet: { status: "lost", publicToken: LOST_PET_TOKEN },
    });

    const fd = new FormData();
    fd.set("name", "Encontrado");
    fd.set("species", "dog");
    fd.set("sex", "unknown");
    fd.set("localityName", "Belgrano");
    fd.set("provinceCode", "AR-C");
    fd.set("acquisitionMethod", "found_stray");
    fd.set("microchipId", CHIP);
    fd.set("forceToken", generateForceToken("724999999999999"));

    const state = await createPetAction({ error: null }, fd);

    expect(state.redirectTo).toBe(`/mis-mascotas/nueva/match/${LOST_PET_TOKEN}?chip=${CHIP}`);
    expect(registerPetMock).not.toHaveBeenCalled();
  });
});
