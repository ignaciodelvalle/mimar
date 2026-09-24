// `ContactRow` — the phone-or-email contact row. `contact-link.test.ts` pins
// the pure decision; this pins what actually reaches the screen reader and
// the dialer/mail client, which is the part a fossilized "PhoneRow" name and
// a hardcoded `tel:` used to get wrong for an email value.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

// Resolved by default: the component chains `.catch()` off the return value,
// and an unmocked `jest.fn()` resolves that call against `undefined`, not a
// promise.
const mockOpenURL = jest.fn<(url: string) => Promise<unknown>>().mockResolvedValue(undefined);

jest.mock("expo-linking", () => ({ openURL: (url: string) => mockOpenURL(url) }));

import { Alert, ContactRow, ErrorNotice, StaleNotice } from "./components";

// The mock is module-scoped, so without this every `toHaveBeenCalledWith`
// assertion below is satisfied by ANY earlier test's press. That is not
// hypothetical bookkeeping: the two-contact block presses a tel: row and a
// mailto: row in separate tests, so a row that stopped opening anything at all
// would still pass on a call another test made.
beforeEach(() => {
  mockOpenURL.mockClear();
});

describe("email value", () => {
  it("renders a link labeled 'Escribir a …', not 'Llamar al …'", () => {
    render(<ContactRow label="Contacto" value="juan@example.com" />);
    const link = screen.getByRole("link", { name: /^escribir a juan@example\.com$/i });
    expect(link).toBeOnTheScreen();
  });

  it("opens mailto: on press, not tel: — the failure mode this row used to have", () => {
    render(<ContactRow label="Contacto" value="juan@example.com" />);
    fireEvent.press(screen.getByRole("link", { name: /^escribir a juan@example\.com$/i }));
    expect(mockOpenURL).toHaveBeenCalledWith("mailto:juan@example.com");
  });
});

describe("phone value", () => {
  it("renders a link labeled 'Llamar al …'", () => {
    render(<ContactRow label="Contacto" value="+54 294 412-3456" />);
    const link = screen.getByRole("link", { name: /^llamar al \+54 294 412-3456$/i });
    expect(link).toBeOnTheScreen();
  });

  it("opens tel: on press, sanitized to digits and a leading +", () => {
    render(<ContactRow label="Contacto" value="+54 294 412-3456" />);
    fireEvent.press(screen.getByRole("link", { name: /^llamar al \+54 294 412-3456$/i }));
    expect(mockOpenURL).toHaveBeenCalledWith("tel:+542944123456");
  });
});

describe("phone AND email in one value", () => {
  // The shape `app/(public)/p/[publicToken]/encontre/action.ts` writes into the
  // single finderContact column when a finder leaves both, joined by
  // CONTACT_SEPARATOR. One row per contact, each opening its own
  // scheme — before the split, the whole string went into a single mailto:.
  const BOTH = "11 4123-4567 / ana@example.com";

  it("renders one link per contact, each with its own accessible name", () => {
    render(<ContactRow label="Contacto" value={BOTH} />);
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.getByRole("link", { name: /^llamar al 11 4123-4567$/i })).toBeOnTheScreen();
    expect(screen.getByRole("link", { name: /^escribir a ana@example\.com$/i })).toBeOnTheScreen();
  });

  it("shows each contact on its own row, never the joined string", () => {
    render(<ContactRow label="Contacto" value={BOTH} />);
    expect(screen.getByText("11 4123-4567")).toBeOnTheScreen();
    expect(screen.getByText("ana@example.com")).toBeOnTheScreen();
    expect(screen.queryByText(BOTH)).toBeNull();
  });

  it("opens tel: from the phone row", () => {
    render(<ContactRow label="Contacto" value={BOTH} />);
    fireEvent.press(screen.getByRole("link", { name: /^llamar al 11 4123-4567$/i }));
    expect(mockOpenURL).toHaveBeenCalledWith("tel:1141234567");
  });

  it("opens mailto: from the email row — with no phone number inside the address", () => {
    render(<ContactRow label="Contacto" value={BOTH} />);
    fireEvent.press(screen.getByRole("link", { name: /^escribir a ana@example\.com$/i }));
    expect(mockOpenURL).toHaveBeenCalledWith("mailto:ana@example.com");
  });

  it("still SHOWS a half that cannot become a link, next to the half that can", () => {
    // Rendering per part rather than per link is what keeps this text on the
    // screen. Dropping it would hide a contact in the one flow whose whole
    // point is reaching the person holding the animal.
    render(<ContactRow label="Contacto" value="abc / ana@example.com" />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText("abc")).toBeOnTheScreen();
  });
});

describe("unlinkable value", () => {
  it("renders no link role — the plain Row fallback", () => {
    render(<ContactRow label="Contacto" value="abc" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("abc")).toBeOnTheScreen();
  });

  it("keeps a joined value VERBATIM when neither half links — no cosmetic split", () => {
    render(<ContactRow label="Contacto" value="abc / def" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("abc / def")).toBeOnTheScreen();
  });
});

// The three notices of this file, asserted together ON PURPOSE.
//
// `Alert` shipped without a screen-reader role while `ErrorNotice` and
// `StaleNotice` — its neighbours, whose docblocks each argue their live-region
// choice — had one. Nothing noticed, because nothing asked. What it cost is in
// `Alert`'s docblock: the credential's "Esta mascota está reportada como
// perdida." was silent to the person most likely to need it read aloud.
//
// Testing the three as a SET rather than fixing the one is the point. A test
// that pins only `Alert` leaves the next notice added to this file free to
// repeat the omission; this one states the file's rule — a notice announces
// itself — and any new silent notice added beside them is a visible gap in a
// table somebody is already reading.
describe("the notices announce themselves", () => {
  it("gives Alert an assertive alert role — it is what the credential says is lost", () => {
    render(<Alert>Esta mascota está reportada como perdida.</Alert>);
    const alert = screen.getByRole("alert");
    expect(alert).toBeOnTheScreen();
    expect(alert.props.accessibilityLiveRegion).toBe("assertive");
  });

  // The two siblings are queried by walking the tree, NOT with getByRole.
  //
  // That is not a convenience: `getByRole` cannot see them, and the reason is
  // worth writing down. Both wrap their children in a `View` carrying
  // `accessibilityRole="alert"`, and a React Native `View` is not an
  // accessibility element unless it also carries `accessible` — so the testing
  // library refuses the match. `Alert` above IS found, because a `Text` is
  // accessible by default.
  //
  // Whether that means the siblings' ROLE fails to reach iOS is a question a
  // real device answers and this file must not pretend to. Android's live
  // region works either way. So these two pin the thing that is certainly
  // true and certainly load-bearing — that one interrupts and the other does
  // not — and leave the platform claim to somebody holding a phone.
  const liveRegionOf = (tree: unknown): unknown => {
    const node = tree as { props?: Record<string, unknown>; children?: unknown[] };
    if (node?.props?.accessibilityRole === "alert") return node.props.accessibilityLiveRegion;
    for (const child of node?.children ?? []) {
      const found = liveRegionOf(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  it("keeps ErrorNotice assertive — the read failed and there is nothing under it", () => {
    const tree = render(<ErrorNotice message="No hay conexión." />).toJSON();
    expect(liveRegionOf(tree)).toBe("assertive");
  });

  it("keeps StaleNotice POLITE — nothing was lost, so it must not interrupt", () => {
    const tree = render(<StaleNotice message="No pudimos actualizar." />).toJSON();
    // Not a copy of the line above: the distinction between the two is the whole
    // reason both exist, and a change that made this one assertive would be a
    // regression a same-value assertion could never see.
    expect(liveRegionOf(tree)).toBe("polite");
  });
});
