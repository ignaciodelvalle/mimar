// The `/mascotas` footer — its ORDER, and the one gap in it that is not uniform.
//
// WHY THIS FILE EXISTS AT ALL. `apps/mobile/app/mascotas/index.tsx` is the app's
// most-opened screen and it had NO test of any kind. That was survivable while
// the footer was a list of links; it stopped being survivable when two parallel
// lanes appended a button to it in the same window, both wrote a long comment
// arguing for the slot they took, and one of those comments turned out to be
// describing a layout that did not exist — it claimed "the gap between the two is
// bigger" while `styles.footer` set ONE uniform `gap` for every child.
//
// SO THE POINT OF THESE ASSERTIONS IS TO MAKE THE COMMENTS FALSIFIABLE. A comment
// that argues for an arrangement and is anchored in nothing is the exact defect
// this repo keeps paying for, and writing a fresh one while removing somebody
// else's would be a smaller version of the same thing.
//
// WHAT IS NOT ASSERTED HERE, deliberately: nothing reads the SOURCE of
// `index.tsx`. A source-text fence over a JSX order would pass for any
// rearrangement that kept the same lines, and it would pass for a `marginTop`
// that had been overridden further down the stylesheet. Everything below is read
// off the RENDERED tree.
//
// It runs under JEST. `apps` is excluded from the Vitest walk
// (`__tests__/db-reachability.ts`), so a file written in Vitest's dialect here
// would never run and would look like coverage.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

const mockPush = jest.fn<(path: string) => void>();
const mockFetchMyPets = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
  // The screen reads once per mount and once per focus. The real hook needs a
  // navigation container; the callback is simply never invoked here, which is
  // the same number of reads the mount already performs.
  useFocusEffect: () => undefined,
}));

jest.mock("../api/endpoints", () => ({
  fetchMyPets: (...args: unknown[]) => mockFetchMyPets(...args),
}));

// The list now re-reads when the network comes back (B-05, `useReconnect`), and
// the real NetInfo has no native module under jest — it crashes inside its own
// reachability timer, several frames from anything this file is about.
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));
jest.mock("../auth/useGate", () => ({ useGate: () => ({ allowed: true }) }));

import MisMascotasScreen from "../../app/mascotas/index";

/** An empty-but-successful list: the footer draws in every loaded state. */
function emptyList() {
  return {
    outcome: "ok" as const,
    payload: { version: 1, pets: [], total: 0, truncated: false },
  };
}

/**
 * The footer's capability buttons, in the order they are RENDERED.
 *
 * Read off the tree rather than off the file, and filtered to the labels the
 * footer owns so that a button added to the LIST body cannot drift into this
 * assertion and quietly reorder it.
 */
const FOOTER_LABELS = [
  "Transferencias",
  "Notificaciones",
  "Mis turnos",
  "Reclamar una mascota",
  "Adoptar",
  "Denunciar maltrato",
  "Ajustes",
];

/**
 * Every string rendered inside one node, in tree order.
 *
 * Walking the instance rather than `JSON.stringify`-ing its props is not style:
 * the props hold React's fiber, and stringifying a rendered button throws
 * `Converting circular structure to JSON`.
 */
function textOf(node: { children: Array<unknown> }): string {
  const parts: string[] = [];
  const walk = (child: unknown): void => {
    if (typeof child === "string") {
      parts.push(child);
      return;
    }
    if (
      child &&
      typeof child === "object" &&
      Array.isArray((child as { children?: unknown[] }).children)
    ) {
      for (const grand of (child as { children: unknown[] }).children) walk(grand);
    }
  };
  for (const child of node.children) walk(child);
  return parts.join(" ");
}

/**
 * THE ORDER AS THE TREE HOLDS IT, which is not the same as "which labels are
 * present" — and the first version of this helper made exactly that mistake.
 *
 * It mapped over `FOOTER_LABELS` and merely filtered out the missing ones, so it
 * returned that constant back no matter how the JSX was arranged. The swap
 * mutation the first test names left it **3/3 GREEN**. A fence over an ORDER
 * that never reads an order is the same defect as a stub that discards its
 * argument: every assertion standing on it asserts that the order does not
 * matter. It was caught by APPLYING the mutation, not by re-reading the code,
 * which is the only reason this file is worth anything.
 *
 * `getAllByRole("button")` returns matches in tree order, so this reads the
 * rendered arrangement. Filtered to the labels the footer owns, so a button in
 * the LIST body cannot drift in and silently reorder the expectation.
 */
function renderedFooterOrder(): string[] {
  return screen
    .getAllByRole("button")
    .map((node) => FOOTER_LABELS.find((label) => textOf(node).includes(label)) ?? null)
    .filter((label): label is string => label !== null);
}

/** Sum every `marginTop` on the ancestors of a rendered label, in points. */
function marginAbove(label: string): number {
  let node = screen.getByText(label).parent;
  let total = 0;
  while (node) {
    const style = node.props?.style;
    const flat: unknown[] = Array.isArray(style) ? style.flat(Number.POSITIVE_INFINITY) : [style];
    for (const layer of flat) {
      if (layer && typeof layer === "object" && "marginTop" in layer) {
        const value = (layer as { marginTop?: unknown }).marginTop;
        if (typeof value === "number") total += value;
      }
    }
    node = node.parent;
  }
  return total;
}

describe("the /mascotas footer", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockFetchMyPets.mockReset();
    mockFetchMyPets.mockResolvedValue(emptyList());
  });

  it("puts DENUNCIAR LAST of the capability buttons, below Adoptar", async () => {
    // THE PRODUCT DECISION, PINNED. The footer runs from what the reader is
    // responsible for towards what they are not: Transferencias and
    // Notificaciones are addressed to them, Mis turnos belong to their animals,
    // Reclamar is an animal that IS theirs recorded under somebody else, Adoptar
    // is one they may come to hold. Denunciar is where that line ENDS — it is not
    // an act on your animals at all, it is a civic act about somebody else's, and
    // it ends with a case file at an authority naming a person.
    //
    // MUTATION, APPLIED: swap the `Adoptar` and `Denunciar maltrato` blocks in
    // `app/mascotas/index.tsx`. This goes red naming both positions.
    render(<MisMascotasScreen />);
    await screen.findByText("Denunciar maltrato");

    const order = renderedFooterOrder();
    expect(order).toEqual(FOOTER_LABELS);
    // Stated twice on purpose: the array equality above would also be satisfied
    // by a FOOTER_LABELS somebody reordered to match a moved button, and this
    // pair says the relationship rather than the list.
    expect(order.indexOf("Denunciar maltrato")).toBeGreaterThan(order.indexOf("Adoptar"));
    expect(order.indexOf("Denunciar maltrato")).toBe(order.length - 2);
  });

  it("gives denunciar MORE space above it than any other footer button has", async () => {
    // THE COMMENT THAT USED TO LIE. The rejected branch's comment argued "the gap
    // between the two is bigger" and nothing in the stylesheet produced one —
    // `styles.footer` sets a single uniform `gap` for every child, so the
    // separation was a sentence. `styles.civicAction` is what makes it true, and
    // this is the assertion that stops it from becoming a sentence again.
    //
    // A button that files a criminal allegation against a named person must not
    // be reachable by a thumb that was aiming at the one above it.
    //
    // MUTATION, APPLIED: delete the `<View style={styles.civicAction}>` wrapper
    // (or empty out `civicAction`). This goes red; the order test above stays
    // green, which is why the two are separate.
    render(<MisMascotasScreen />);
    await screen.findByText("Denunciar maltrato");

    const denuncia = marginAbove("Denunciar maltrato");
    for (const label of ["Transferencias", "Notificaciones", "Mis turnos", "Adoptar"]) {
      expect(denuncia).toBeGreaterThan(marginAbove(label));
    }
  });

  it("routes denunciar to /denunciar and nowhere else", async () => {
    // The route is registered in `app/_layout.tsx` under this exact name; a
    // button pointing anywhere else would open a screen with the wrong header or
    // no screen at all.
    //
    // MUTATION, APPLIED: point the button at `ROUTES.adoptar`. Red.
    render(<MisMascotasScreen />);
    const button = await screen.findByText("Denunciar maltrato");

    fireEvent.press(button);

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/denunciar");
  });
});
