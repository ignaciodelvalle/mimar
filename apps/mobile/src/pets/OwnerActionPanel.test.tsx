// The app's panel draws the catalogue's gates and the catalogue's words, and
// nothing of its own (owner-pet-actions, plan step 4 — the jest half).
//
// WHY THIS FILE EXISTS. The plan asked for two things of BOTH panels: "a test
// that neither panel inlines catalogue labels; the same gate matrix runs under
// jest and vitest". The contract's matrix runs under vitest
// (`packages/contract/src/reference/__tests__/pet-actions.test.ts`), and the
// vitest scan in `__tests__/pet-action-labels-single-source.test.ts` reads this
// app's SOURCE for typed copies of the catalogue's strings. Neither runs the
// app's own code path. This file does, under the app's own runner:
//
//   1. THE MATRIX — every viewer role × pet status × species × PPP fact the
//      catalogue reads, through `ownerPanelView`, the function the screen
//      calls. Every row the app draws must be the row the catalogue derived:
//      same id, same order, same words, grey exactly where the catalogue says —
//      plus the ONE place the app adds grey, the foster's "Buscar hogar", which
//      has no screen in this build and says "Se hace desde la web".
//   2. THE REASONS, EXHAUSTIVELY — every `PetActionInertReason` the contract
//      declares is classified below, at compile time: drawn on this platform
//      (and then the matrix must actually reach it, with the contract's
//      caption), or a word only the OTHER platform uses. A reason added to the
//      catalogue fails the app's typecheck here until somebody decides which.
//   3. THE RENDER — the panel component, mounted, shows only strings the
//      catalogue owns. A label typed into `OwnerActionPanel.tsx` would be the
//      fourth copy of a list that already drifted with three.

import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";

import {
  OWNER_PET_DETAIL_VIEWER_ROLES,
  type OwnerPetIdentitySection,
  type OwnerPetStatusSection,
  type PublicPetStatus,
} from "@dim/contract/api";
import {
  type DerivedPetAction,
  FOSTER_FIND_HOME_COPY,
  PET_ACTION_COPY,
  PET_ACTION_GROUPS,
  PET_ACTION_INERT_CAPTIONS,
  PET_ACTION_INERT_REASONS,
  type PetActionContext,
  type PetActionInertReason,
  derivePetActions,
} from "@dim/contract/reference";

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

import { OwnerActionPanel } from "./OwnerActionPanel";
import {
  type OwnerPanelRow,
  type OwnerPanelSource,
  type OwnerPanelView,
  SECTION_UNAVAILABLE_MESSAGE,
  ownerPanelView,
} from "./owner-face-view-model";

const TOKEN = "DIM-PAMP-0001";
const UNREAD = { state: "unavailable", message: SECTION_UNAVAILABLE_MESSAGE } as const;

/** The face's sections as the catalogue's context describes them; `null` = not read. */
function sourceFor(ctx: PetActionContext): OwnerPanelSource {
  return {
    publicToken: TOKEN,
    viewerRole: ctx.viewerRole,
    isTitular: ctx.isTitular,
    status:
      ctx.petStatus === null
        ? UNREAD
        : { state: "ok", data: { petStatus: ctx.petStatus } as OwnerPetStatusSection },
    identity:
      ctx.species === null
        ? UNREAD
        : {
            state: "ok",
            data: { name: "Pampa", species: ctx.species } as OwnerPetIdentitySection,
          },
    pppRegistries:
      ctx.pppDoor === null
        ? UNREAD
        : {
            state: "ok",
            data: ctx.pppDoor
              ? [{ id: "caba_ley_4078", label: "CABA · Ley 4078", required: true }]
              : null,
          },
  } as OwnerPanelSource;
}

const STATUSES: readonly (PublicPetStatus | null)[] = ["active", "lost", "deceased", null];
const SPECIES: readonly (string | null)[] = ["dog", "cat", null];
const PPP: readonly (boolean | null)[] = [true, false, null];

/** Every context the catalogue can be asked about, the titular being the owner role. */
const MATRIX: PetActionContext[] = OWNER_PET_DETAIL_VIEWER_ROLES.flatMap((viewerRole) =>
  STATUSES.flatMap((petStatus) =>
    SPECIES.flatMap((species) =>
      PPP.map((pppDoor) => ({
        viewerRole,
        isTitular: viewerRole === "owner",
        petStatus,
        species,
        pppDoor,
      })),
    ),
  ),
);

const name = (ctx: PetActionContext) =>
  `${ctx.viewerRole}/${ctx.petStatus ?? "unread"}/${ctx.species ?? "unread"}/ppp:${ctx.pppDoor ?? "unread"}`;

function rowsOf(panel: OwnerPanelView): OwnerPanelRow[] {
  return [...panel.primary, ...panel.groups.flatMap((group) => group.rows)];
}

function derivedRowsOf(ctx: PetActionContext): DerivedPetAction[] {
  const derived = derivePetActions(ctx);
  return [...derived.primary, ...derived.groups.flatMap((group) => group.actions)];
}

/** The one row this build has no screen for: the foster's own rehoming ask. */
const hasNoScreenHere = (ctx: PetActionContext, action: DerivedPetAction) =>
  action.id === "find_home" && ctx.viewerRole === "foster";

/** What the app must draw for one derived row, in the shape a test can compare. */
function expectedRow(ctx: PetActionContext, action: DerivedPetAction) {
  const base = { id: action.id, label: action.label, hint: action.hint, tone: action.tone };
  if (action.state.kind === "inert") return { ...base, caption: action.caption, grey: true };
  if (hasNoScreenHere(ctx, action)) {
    return { ...base, caption: PET_ACTION_INERT_CAPTIONS.web_only, grey: true };
  }
  return { ...base, caption: action.caption, grey: false };
}

function drawnRow(row: OwnerPanelRow) {
  return {
    id: row.id,
    label: row.label,
    hint: row.hint,
    tone: row.tone,
    caption: row.caption,
    grey: row.target === null,
  };
}

describe("ownerPanelView — the catalogue's gate matrix, under the app's runner", () => {
  it("covers every role, status, species and PPP fact the catalogue reads", () => {
    // Five roles × four statuses (one unread) × three species × three PPP facts.
    expect(OWNER_PET_DETAIL_VIEWER_ROLES.length).toBeGreaterThanOrEqual(5);
    expect(MATRIX).toHaveLength(OWNER_PET_DETAIL_VIEWER_ROLES.length * 4 * 3 * 3);
  });

  it("draws, in every cell, exactly the catalogue's rows in its order and with its words", () => {
    const offences: string[] = [];
    for (const ctx of MATRIX) {
      const drawn = rowsOf(ownerPanelView(sourceFor(ctx))).map(drawnRow);
      const expected = derivedRowsOf(ctx).map((action) => expectedRow(ctx, action));
      if (JSON.stringify(drawn) !== JSON.stringify(expected)) offences.push(name(ctx));
    }
    expect(offences).toEqual([]);
  });

  it("keeps the catalogue's groups and headings, and its attestation door", () => {
    const offences: string[] = [];
    for (const ctx of MATRIX) {
      const panel = ownerPanelView(sourceFor(ctx));
      const derived = derivePetActions(ctx);
      const drawn = panel.groups.map((group) => [group.id, group.heading]);
      const expected = derived.groups.map((group) => [group.id, group.heading]);
      if (JSON.stringify(drawn) !== JSON.stringify(expected)) offences.push(`${name(ctx)} groups`);
      if (panel.attestationDoor !== derived.attestationDoor) offences.push(`${name(ctx)} door`);
    }
    expect(offences).toEqual([]);
  });

  it("opens the photo frame exactly where the catalogue has a Foto row, on the photo screen", () => {
    let framed = 0;
    for (const ctx of MATRIX) {
      const panel = ownerPanelView(sourceFor(ctx));
      const photo = derivedRowsOf(ctx).find((action) => action.id === "photo") ?? null;
      expect([name(ctx), panel.photoTarget]).toEqual([
        name(ctx),
        photo === null ? null : `/mascotas/${TOKEN}/foto`,
      ]);
      if (panel.photoTarget !== null) framed += 1;
    }
    // Non-vacuity: every person-path cell has the door, the org path none.
    expect(framed).toBe(MATRIX.filter((ctx) => ctx.viewerRole !== "org_member").length);
  });
});

/**
 * EVERY reason the contract declares, classified for THIS platform. A
 * `Record`, so a reason added to `PET_ACTION_INERT_REASONS` fails the app's
 * typecheck here until somebody says whether the app draws it.
 *
 *   · `drawn` — the panel shows it, with the contract's caption.
 *   · `other_platform` — the word the OTHER platform uses for a door only this
 *     one has: `app_only` is the web's "Se hace desde la app", and the app, by
 *     definition, has that door.
 */
const NATIVE_REASON_CLASS: Readonly<Record<PetActionInertReason, "drawn" | "other_platform">> = {
  titular_only: "drawn",
  not_active: "drawn",
  caretaker: "drawn",
  web_only: "drawn",
  app_only: "other_platform",
};

describe("ownerPanelView — every grey reason the contract declares is handled", () => {
  const captionsDrawn = new Set(
    MATRIX.flatMap((ctx) =>
      rowsOf(ownerPanelView(sourceFor(ctx)))
        .filter((row) => row.target === null)
        .map((row) => row.caption),
    ),
  );

  it("classifies every reason, and the classification is the contract's own list", () => {
    expect(Object.keys(NATIVE_REASON_CLASS).sort()).toEqual([...PET_ACTION_INERT_REASONS].sort());
  });

  it("reaches every reason it draws, with the contract's es-AR caption", () => {
    for (const reason of PET_ACTION_INERT_REASONS) {
      if (NATIVE_REASON_CLASS[reason] !== "drawn") continue;
      expect([reason, captionsDrawn.has(PET_ACTION_INERT_CAPTIONS[reason])]).toEqual([
        reason,
        true,
      ]);
    }
  });

  it("never draws the other platform's word, and no grey row goes without a reason", () => {
    expect(captionsDrawn.has(PET_ACTION_INERT_CAPTIONS.app_only)).toBe(false);
    expect(captionsDrawn.has(null)).toBe(false);
    const known = new Set(Object.values(PET_ACTION_INERT_CAPTIONS));
    expect([...captionsDrawn].filter((caption) => !known.has(caption as string))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The render: the component shows the catalogue's words and nothing of its own
// ---------------------------------------------------------------------------

/** Every string the catalogue owns: labels, hints, headings, reasons and standing notes. */
function catalogueStrings(): Set<string> {
  const out = new Set<string>();
  for (const copy of [...Object.values(PET_ACTION_COPY), FOSTER_FIND_HOME_COPY]) {
    out.add(copy.label);
    out.add(copy.hint);
  }
  for (const caption of Object.values(PET_ACTION_INERT_CAPTIONS)) out.add(caption);
  for (const group of PET_ACTION_GROUPS) if (group.heading) out.add(group.heading);
  for (const ctx of MATRIX) {
    for (const action of derivedRowsOf(ctx)) if (action.caption) out.add(action.caption);
  }
  return out;
}

const CATALOGUE = catalogueStrings();

/** Every text node the mounted panel renders. */
function renderedTexts(): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node === "object" && node !== null && "children" in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(screen.toJSON());
  return out;
}

const RENDERED: readonly [string, PetActionContext][] = [
  ["the titular of an active dog", MATRIX[0] as PetActionContext],
  ...(["co_owner", "foster", "caretaker", "org_member"] as const).map(
    (viewerRole) =>
      [
        `a ${viewerRole}`,
        { viewerRole, isTitular: false, petStatus: "active", species: "dog", pppDoor: false },
      ] as [string, PetActionContext],
  ),
  [
    "the titular of a LOST cat",
    { viewerRole: "owner", isTitular: true, petStatus: "lost", species: "cat", pppDoor: null },
  ],
  [
    "the titular of a deceased dog",
    { viewerRole: "owner", isTitular: true, petStatus: "deceased", species: "dog", pppDoor: true },
  ],
];

describe("OwnerActionPanel — every word it shows is the catalogue's", () => {
  it.each(RENDERED)("%s", (_who, ctx) => {
    const panel = ownerPanelView(sourceFor(ctx));
    render(<OwnerActionPanel panel={panel} />);
    const texts = renderedTexts();
    // Non-vacuity: the panel drew something, and every row it was handed.
    expect(texts.length).toBeGreaterThan(0);
    for (const row of rowsOf(panel)) {
      expect(texts).toContain(row.label);
      if (row.caption !== null) expect(texts).toContain(row.caption);
    }
    for (const group of panel.groups) if (group.heading) expect(texts).toContain(group.heading);
    // And nothing else: a string the catalogue does not own is a typed copy.
    expect(texts.filter((text) => !CATALOGUE.has(text))).toEqual([]);
  });

  it("would catch one — the check is not vacuous", () => {
    // The detector, on a panel whose label was retyped by hand.
    const panel = ownerPanelView(sourceFor(MATRIX[0] as PetActionContext));
    const first = panel.primary[0] as OwnerPanelRow;
    render(
      <OwnerActionPanel
        panel={{
          ...panel,
          primary: [{ ...first, label: "Anotar algo" }, ...panel.primary.slice(1)],
        }}
      />,
    );
    expect(renderedTexts().filter((text) => !CATALOGUE.has(text))).toEqual(["Anotar algo"]);
  });

  it("announces a grey row as disabled, its reason on screen", () => {
    const panel = ownerPanelView(
      sourceFor({
        viewerRole: "co_owner",
        isTitular: false,
        petStatus: "active",
        species: "dog",
        pppDoor: false,
      }),
    );
    render(<OwnerActionPanel panel={panel} />);
    const transfer = screen.getByRole("button", { name: /Transferir la titularidad/ });
    expect(transfer.props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getAllByText(PET_ACTION_INERT_CAPTIONS.titular_only).length).toBeGreaterThan(0);
  });
});
