// The `aviso/{id}` screen (notificaciones-destinos, 2026-10): it replaces itself
// with the server's destination, or stays and explains — never a dead end.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockFetchTarget = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("../api/endpoints", () => ({
  fetchNotificationTarget: (...args: unknown[]) => mockFetchTarget(...args),
}));
jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import type { NotificationTargetV1 } from "@dim/contract/api";
import { NotificationTargetScreen } from "./NotificationTargetScreen";
import { targetStep, webOnlyUrl } from "./notification-target-view-model";

const ID = "55555555-5555-4555-8555-555555555555";

function aTarget(over: Partial<NotificationTargetV1> = {}): NotificationTargetV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-10-06T00:00:00.000Z",
    staleAfter: "2026-10-06T00:00:15.000Z",
    notificationId: ID,
    notificationType: "cross_org_transfer_proposed_receiver",
    outcome: "case",
    primaryDestination: "case",
    webHref: "/casos/CAS-AAAA-BBBB",
    appRoute: "/casos/CAS-AAAA-BBBB",
    webOnly: false,
    reason: "destination",
    reasonCopy: null,
    actorCopy: "Te toca a vos: aceptá o rechazá el traspaso.",
    pendingActor: "recipient",
    externalUrl: null,
    externalLabel: null,
    title: "Propuesta de traspaso",
    body: "Refugio Norte propone traspasar a Bruno.",
    ...over,
  };
}

function renderScreen(handlers: {
  onReplace?: (route: string) => void;
  onOpenWeb?: (target: NotificationTargetV1) => void;
  onOpenExternal?: (url: string) => void;
  onOpenInbox?: () => void;
}) {
  return render(
    <NotificationTargetScreen
      notificationId={ID}
      onReplace={handlers.onReplace ?? (() => undefined)}
      onOpenWeb={handlers.onOpenWeb ?? (() => undefined)}
      onOpenExternal={handlers.onOpenExternal ?? (() => undefined)}
      onOpenInbox={handlers.onOpenInbox ?? (() => undefined)}
    />,
  );
}

beforeEach(() => {
  mockFetchTarget.mockReset();
});

describe("targetStep", () => {
  it("goes to the resolved screen, and stays for explain or web-only", () => {
    expect(targetStep(aTarget())).toEqual({ kind: "go", route: "/casos/CAS-AAAA-BBBB" });
    expect(targetStep(aTarget({ outcome: "explain" })).kind).toBe("explain");
    expect(targetStep(aTarget({ outcome: "section", webOnly: true })).kind).toBe("explain");
  });

  it("builds the browser url from the app's origin and the web path", () => {
    expect(webOnlyUrl("https://www.mimar.com.ar/", aTarget({ webHref: "/org/X/mensajes" }))).toBe(
      "https://www.mimar.com.ar/org/X/mensajes",
    );
  });
});

describe("NotificationTargetScreen", () => {
  it("replaces itself with the case the server resolved", async () => {
    const replaced: string[] = [];
    mockFetchTarget.mockResolvedValue({ outcome: "ok", payload: aTarget() });
    renderScreen({ onReplace: (route) => replaced.push(route) });
    await waitFor(() => expect(replaced).toEqual(["/casos/CAS-AAAA-BBBB"]));
    expect(mockFetchTarget).toHaveBeenCalledWith({}, ID);
  });

  it("explains a pet the reader no longer holds, without a dead end", async () => {
    mockFetchTarget.mockResolvedValue({
      outcome: "ok",
      payload: aTarget({
        outcome: "explain",
        reason: "pet_no_longer_held",
        webHref: `/notificaciones/${ID}`,
        appRoute: `/aviso/${ID}`,
        reasonCopy: "Ya no tenés a Kira a cargo, por eso no podemos mostrarte su ficha.",
        actorCopy: null,
      }),
    });
    const toInbox = jest.fn();
    renderScreen({ onOpenInbox: toInbox });
    expect(
      await screen.findByText("Ya no tenés a Kira a cargo, por eso no podemos mostrarte su ficha."),
    ).toBeTruthy();
    expect(screen.queryByText("Abrir en el navegador")).toBeNull();
    fireEvent.press(screen.getByText("Ir a notificaciones"));
    expect(toInbox).toHaveBeenCalled();
  });

  it("says who must act when something is pending", async () => {
    mockFetchTarget.mockResolvedValue({
      outcome: "ok",
      payload: aTarget({
        outcome: "explain",
        reason: "case_reserved_to_investigators",
        reasonCopy: "La denuncia quedó registrada.",
        actorCopy: "Lo decide la autoridad de Rosario. Te avisamos cuando haya novedades.",
      }),
    });
    renderScreen({});
    expect(
      await screen.findByText(
        "Lo decide la autoridad de Rosario. Te avisamos cuando haya novedades.",
      ),
    ).toBeTruthy();
  });

  it("offers the browser for a destination that exists only on the web", async () => {
    const target = aTarget({
      outcome: "section",
      webOnly: true,
      reason: "web_only",
      webHref: "/org/ORG-1/mensajes",
      appRoute: `/aviso/${ID}`,
      reasonCopy: "Esto se gestiona desde la web. Abrilo en el navegador con tu misma cuenta.",
    });
    mockFetchTarget.mockResolvedValue({ outcome: "ok", payload: target });
    const opened: NotificationTargetV1[] = [];
    const replaced: string[] = [];
    renderScreen({ onOpenWeb: (t) => opened.push(t), onReplace: (r) => replaced.push(r) });
    fireEvent.press(await screen.findByText("Abrir en el navegador"));
    expect(opened).toEqual([target]);
    // It never replaces itself with itself.
    expect(replaced).toEqual([]);
  });

  it("names a row that is not this person's instead of a bare error", async () => {
    mockFetchTarget.mockResolvedValue({
      outcome: "api-error",
      code: "not_found",
      retryAfterSeconds: null,
    });
    renderScreen({});
    expect(
      await screen.findByText(
        "No encontramos esta notificación en tu cuenta. Puede que se haya borrado o que sea de otra cuenta.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Ir a notificaciones")).toBeTruthy();
    // R6: retrying cannot make somebody else's notification theirs.
    expect(screen.queryByText("Volver a intentar")).toBeNull();
  });
});

// Review fixes R5 (external links) and R10 (one read per notification).
describe("NotificationTargetScreen — review fixes", () => {
  it("opens an outside link with the system and keeps the explanation", async () => {
    const url = "https://www.argentina.gob.ar/salud/glosario/rabia";
    mockFetchTarget.mockResolvedValue({
      outcome: "ok",
      payload: aTarget({
        outcome: "external",
        reason: "external",
        externalUrl: url,
        externalLabel: "Información oficial — Min. Salud",
        webHref: `/notificaciones/${ID}`,
        appRoute: `/aviso/${ID}`,
        reasonCopy:
          "Este aviso enlaza un sitio externo (Información oficial — Min. Salud). Se abre fuera de miMAR.",
        actorCopy: null,
      }),
    });
    const opened: string[] = [];
    const replaced: string[] = [];
    renderScreen({ onOpenExternal: (u) => opened.push(u), onReplace: (r) => replaced.push(r) });
    await waitFor(() => expect(opened).toEqual([url]));
    fireEvent.press(await screen.findByText("Información oficial — Min. Salud"));
    expect(opened).toEqual([url, url]);
    expect(replaced).toEqual([]);
  });

  it("refuses an outside link that is not a well-formed http(s) address", async () => {
    mockFetchTarget.mockResolvedValue({
      outcome: "ok",
      payload: aTarget({
        outcome: "external",
        externalUrl: "javascript:alert(1)",
        reasonCopy: "x",
      }),
    });
    const opened: string[] = [];
    renderScreen({ onOpenExternal: (u) => opened.push(u) });
    await screen.findByText("Ir a notificaciones");
    expect(opened).toEqual([]);
  });

  it("does not fetch or replace again when the parent re-renders with new callbacks", async () => {
    mockFetchTarget.mockResolvedValue({ outcome: "ok", payload: aTarget() });
    const replaced: string[] = [];
    const view = renderScreen({ onReplace: (r) => replaced.push(r) });
    await waitFor(() => expect(replaced).toHaveLength(1));
    view.rerender(
      <NotificationTargetScreen
        notificationId={ID}
        onReplace={(r) => replaced.push(r)}
        onOpenWeb={() => undefined}
        onOpenExternal={() => undefined}
        onOpenInbox={() => undefined}
      />,
    );
    await waitFor(() => expect(mockFetchTarget).toHaveBeenCalledTimes(1));
    expect(replaced).toHaveLength(1);
  });
});
