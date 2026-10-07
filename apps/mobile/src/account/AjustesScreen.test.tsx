// Ajustes, rendered (pulido-kit-listas, 2026-10-07) — the screen's ORDER and
// WEIGHT, which nothing pinned until it was changed:
//
//   · "Servidor" is shown only off the production channel. A tester needs the
//     URL; a person on the store build has one server and no use for it.
//   · The sign-outs close the screen, after the account's own business.
//   · "Cerrar sesión en todos los dispositivos" is a link, not the heaviest red
//     button on the screen — and it still asks before it acts.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

const mockUpdates: { channel: string | null } = { channel: "production" };
const mockSignOutEverywhere = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-updates", () => ({
  get channel() {
    return mockUpdates.channel;
  },
}));
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock("../auth/useGate", () => ({
  useGate: () => ({
    allowed: true,
    user: {
      profilePending: false,
      displayName: "Ana Pérez",
      role: "owner",
      accountType: "personal",
    },
  }),
}));
jest.mock("../auth/session-store", () => ({
  signOut: jest.fn(),
  signOutEverywhere: (...args: unknown[]) => mockSignOutEverywhere(...args),
}));
// The three cards have their own tests; here they are only positions.
jest.mock("./AboutSection", () => {
  const { Text } = require("react-native");
  return { AboutSection: () => <Text>Acerca de miMAR</Text> };
});
jest.mock("./AccountDeletionCard", () => {
  const { Text } = require("react-native");
  return { AccountDeletionCard: () => <Text>Eliminar mi cuenta</Text> };
});
jest.mock("../notifications/PushNotificationsCard", () => ({
  PushNotificationsCard: () => null,
}));

import AjustesScreen from "../../app/ajustes";
import { API_BASE_URL } from "../config/api";

/** Every text node, in render order. */
function textsInOrder(): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) for (const child of node) walk(child);
    else if (typeof node === "object" && node !== null && "children" in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(screen.toJSON());
  return out;
}

beforeEach(() => {
  mockUpdates.channel = "production";
  mockSignOutEverywhere.mockReset();
});

describe("Ajustes — the server is named only where it can be the wrong one", () => {
  it("hides 'Servidor' on the production channel", () => {
    render(<AjustesScreen />);
    expect(screen.queryByText("Servidor")).toBeNull();
    expect(screen.queryByText(API_BASE_URL)).toBeNull();
  });

  it.each([["preview"], [null]])("shows it on channel %p", (channel) => {
    mockUpdates.channel = channel;
    render(<AjustesScreen />);
    expect(screen.getByText("Servidor")).toBeOnTheScreen();
    expect(screen.getByText(API_BASE_URL)).toBeOnTheScreen();
  });
});

describe("Ajustes — the ways out close the screen", () => {
  it("draws the sign-outs after the account deletion card and the about section", () => {
    render(<AjustesScreen />);
    const texts = textsInOrder();
    const signOut = texts.indexOf("Cerrar sesión");
    expect(signOut).toBeGreaterThan(texts.indexOf("Eliminar mi cuenta"));
    expect(signOut).toBeGreaterThan(texts.indexOf("Acerca de miMAR"));
    expect(texts.indexOf("Cerrar sesión en todos los dispositivos")).toBeGreaterThan(signOut);
  });

  it("offers 'todos los dispositivos' as a link, and still asks before acting", () => {
    render(<AjustesScreen />);
    const link = screen.getByRole("link", { name: "Cerrar sesión en todos los dispositivos" });
    expect(
      screen.queryByRole("button", { name: "Cerrar sesión en todos los dispositivos" }),
    ).toBeNull();
    fireEvent.press(link);
    expect(mockSignOutEverywhere).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sí, cerrar todo" })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("button", { name: "Sí, cerrar todo" })).toBeNull();
  });

  it("opens 'Editar mis datos' from a row, like every other destination", () => {
    render(<AjustesScreen />);
    expect(screen.getByRole("button", { name: "Editar mis datos" })).toBeOnTheScreen();
    expect(
      screen.getAllByTestId("list-row-trailing", { includeHiddenElements: true }).length,
    ).toBeGreaterThan(0);
  });
});
