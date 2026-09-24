// The gate's two arms that are not "send them to sign-in".
//
// WHY THE ELEMENT IS INSPECTED AND NOT RENDERED
// ---------------------------------------------------------------------------
// `useGate` returns the redirect AS A VALUE — that shape is the whole design
// (see the header of useGate.tsx: a hook that redirects as a side effect runs
// after the render that already drew the protected content). A React element is
// a plain object, so the question these tests ask — WHICH href did the gate
// choose — is answered by reading `element.props.href`, with no router, no
// navigation container and no `<Screen>` in the way.
//
// WHAT THEY PROVE
//   1. A4-custodia-03: the destination survives the IDENTITY arm. It has
//      survived the signed-out arm since WU-O, and the signed-in-but-pending arm
//      is the one a first-time user opening a deep link actually hits.
//   2. A6-cuenta-resiliencia-05: `session-unverified` is not "signed out". The
//      offline credential cache exists for exactly that state, and the ordinary
//      gate answered it with a retry screen — so the cache was reachable only
//      when the network that makes it pointless was up.

import type { MeV1User } from "@dim/contract/api";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import type { ReactElement } from "react";

import type { SessionState } from "./session-store";

const mockSession: { state: SessionState } = { state: { phase: "starting" } };
const mockPathname: { value: string } = { value: "/" };

jest.mock("expo-router", () => ({
  // Never actually rendered — the tests read `element.props.href` off the
  // element the gate RETURNS, which is the whole point of returning it.
  Redirect: () => null,
  usePathname: () => mockPathname.value,
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
}));

jest.mock("./useSession", () => ({ useSession: () => mockSession.state }));

jest.mock("./session-store", () => ({
  bootstrapSession: () => Promise.resolve(),
  signOut: () => Promise.resolve(),
}));

import { ROUTES } from "../ui/routes";
import { type DisplayOnlyGate, type Gate, useDisplayOnlyGate, useGate } from "./useGate";

const USER: MeV1User = {
  id: "user-001",
  displayName: "Ana",
  role: "owner",
  accountType: "personal",
  profilePending: false,
};

/** Runs a hook once and hands back what it returned. No screen is drawn. */
function readGate<T>(useHook: () => T): T {
  let seen: T | undefined;
  function Probe() {
    seen = useHook();
    return null;
  }
  render(<Probe />);
  if (seen === undefined) throw new Error("the probe never rendered");
  return seen;
}

/** The `href` a `<Redirect>` arm chose. */
function redirectHref(gate: Gate | DisplayOnlyGate): unknown {
  if (gate.allowed) throw new Error("expected a refusal, got an allowed gate");
  return (gate.element as ReactElement<{ href: unknown }>).props.href;
}

beforeEach(() => {
  mockSession.state = { phase: "starting" };
  mockPathname.value = "/";
});

describe("useGate — the identity arm carries the destination (A4-custodia-03)", () => {
  const INVITATION = "/cuidado/GRT-ABCD-2345";

  it("sends a pending identity to the gate WITH `next`", () => {
    mockSession.state = { phase: "signed-in", user: { ...USER, profilePending: true } };
    mockPathname.value = INVITATION;

    expect(redirectHref(readGate(() => useGate()))).toEqual({
      pathname: ROUTES.identidadPendiente,
      params: { next: INVITATION },
    });
  });

  it("carries nothing from a path that would loop", () => {
    mockSession.state = { phase: "signed-in", user: { ...USER, profilePending: true } };
    mockPathname.value = ROUTES.misMascotas;

    expect(redirectHref(readGate(() => useGate()))).toBe(ROUTES.identidadPendiente);
  });

  it("still lets a complete identity through", () => {
    // The control: the arm must not start refusing everybody.
    mockSession.state = { phase: "signed-in", user: USER };

    expect(readGate(() => useGate())).toEqual({ allowed: true, user: USER });
  });
});

describe("useDisplayOnlyGate — the offline cache is reachable (A6-cuenta-resiliencia-05)", () => {
  it("allows an UNVERIFIED session through, with no user", () => {
    mockSession.state = { phase: "session-unverified", message: "No hay conexión." };

    expect(readGate(() => useDisplayOnlyGate())).toEqual({
      allowed: true,
      user: null,
      unverifiedMessage: "No hay conexión.",
    });
  });

  it("refuses a SIGNED-OUT visitor exactly as the ordinary gate does", () => {
    // The relaxation is scoped to one phase. Tokens on the device is not the
    // same fact as no tokens at all, and only the first may read the cache.
    mockSession.state = { phase: "signed-out", reason: null };
    mockPathname.value = "/mascotas/DIM-ABCD-2345/credencial";

    expect(redirectHref(readGate(() => useDisplayOnlyGate()))).toEqual({
      pathname: ROUTES.ingreso,
      params: { next: "/mascotas/DIM-ABCD-2345/credencial" },
    });
  });

  it("hands a verified session its user, like the ordinary gate", () => {
    mockSession.state = { phase: "signed-in", user: USER };

    expect(readGate(() => useDisplayOnlyGate())).toEqual({
      allowed: true,
      user: USER,
      unverifiedMessage: null,
    });
  });
});
