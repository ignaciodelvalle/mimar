// The `aviso/{id}` screen (notificaciones-destinos, 2026-10): it replaces itself
// with the server's destination, or stays and explains — never a dead end.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockFetchTarget = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("../api/endpoints", () => ({
  fetchNotificationTarget: (...args: unknown[]) => mockFetchTarget(...args),
  sendNotificationCommand: (...args: unknown[]) => mockSend(...args),
}));
jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import type { NotificationTargetV1 } from "@dim/contract/api";
import { NotificationTargetScreen } from "./NotificationTargetScreen";
import {
  type InboxDetail,
  inboxDetailFromParams,
  targetStep,
  webOnlyUrl,
} from "./notification-target-view-model";
import { notificationDetailRoute } from "./notifications-view-model";

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
  mockSend.mockReset();
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
        reason: "case_titular_only",
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

// ---------------------------------------------------------------------------
// pulido-avisos (2026-10) — opened from an inbox row, it is the DETAIL
// ---------------------------------------------------------------------------

function renderDetail(
  inbox: InboxDetail,
  handlers: {
    onOpenRoute?: (route: string) => void;
    onReplace?: (route: string) => void;
    onOpenExternal?: (url: string) => void;
    onOpenWeb?: (target: NotificationTargetV1) => void;
    onOpenInbox?: () => void;
  } = {},
) {
  return render(
    <NotificationTargetScreen
      notificationId={ID}
      inbox={inbox}
      onOpenRoute={handlers.onOpenRoute ?? (() => undefined)}
      onReplace={handlers.onReplace ?? (() => undefined)}
      onOpenWeb={handlers.onOpenWeb ?? (() => undefined)}
      onOpenExternal={handlers.onOpenExternal ?? (() => undefined)}
      onOpenInbox={handlers.onOpenInbox ?? (() => undefined)}
    />,
  );
}

const PAMPA = { publicToken: "DIM-PAMP-0001", name: "Pampa" };

describe("inboxDetailFromParams", () => {
  it("reads back exactly what the inbox row handed over", () => {
    const route = notificationDetailRoute({
      id: ID,
      notificationType: "pet_sighting",
      title: "Avistaje de Pampa",
      cta: { label: "Ver el avistaje & el mapa", route: null },
      pet: PAMPA,
      petLinkAvailable: true,
    });
    const query = route.split("?")[1] ?? "";
    const params = Object.fromEntries(
      query.split("&").map((pair) => {
        const [key = "", value = ""] = pair.split("=");
        return [key, decodeURIComponent(value)];
      }),
    );
    expect(inboxDetailFromParams(params)).toEqual({
      actionLabel: "Ver el avistaje & el mapa",
      pet: PAMPA,
    });
  });

  it("survives '&', '+', '%' and accents in the label and the pet's name", () => {
    const route = notificationDetailRoute({
      id: ID,
      notificationType: "pet_sighting",
      title: "x",
      cta: { label: "Ver 100% + más & mapa", route: null },
      pet: { publicToken: "DIM-PAMP-0001", name: "Ñata & Co+" },
      petLinkAvailable: true,
    });
    const query = route.split("?")[1] ?? "";
    // Expo Router decodes each value with `decodeURIComponent`, as this does.
    const params = Object.fromEntries(
      query.split("&").map((pair) => {
        const [key = "", value = ""] = pair.split("=");
        return [key, decodeURIComponent(value)];
      }),
    );
    expect(inboxDetailFromParams(params)).toEqual({
      actionLabel: "Ver 100% + más & mapa",
      pet: { publicToken: "DIM-PAMP-0001", name: "Ñata & Co+" },
    });
  });

  it("is null without the inbox origin — a push tap keeps resolving and replacing", () => {
    expect(inboxDetailFromParams({})).toBeNull();
    expect(inboxDetailFromParams({ origen: "push", accion: "Ver" })).toBeNull();
  });

  it("drops a pet link that is missing either half", () => {
    expect(inboxDetailFromParams({ origen: "bandeja", mascota: "DIM-X" })?.pet).toBeNull();
    expect(inboxDetailFromParams({ origen: "bandeja", nombre: "Pampa" })?.pet).toBeNull();
  });
});

describe("NotificationTargetScreen — the inbox's detail", () => {
  it("shows the whole notification and never replaces itself", async () => {
    mockFetchTarget.mockResolvedValue({ outcome: "ok", payload: aTarget() });
    const replaced: string[] = [];
    renderDetail(
      { actionLabel: "Revisar el traspaso", pet: null },
      {
        onReplace: (r) => replaced.push(r),
      },
    );
    expect(await screen.findByText("Refugio Norte propone traspasar a Bruno.")).toBeTruthy();
    expect(screen.getByText("Propuesta de traspaso")).toBeTruthy();
    expect(replaced).toEqual([]);
  });

  it("carries the row's CTA as its ONE primary action, pushed on top of the detail", async () => {
    mockFetchTarget.mockResolvedValue({ outcome: "ok", payload: aTarget() });
    const pushed: string[] = [];
    renderDetail(
      { actionLabel: "Revisar el traspaso", pet: PAMPA },
      { onOpenRoute: (r) => pushed.push(r) },
    );
    fireEvent.press(await screen.findByText("Revisar el traspaso"));
    expect(pushed).toEqual(["/casos/CAS-AAAA-BBBB"]);
  });

  it("offers the pet link the server allowed, as a row", async () => {
    mockFetchTarget.mockResolvedValue({ outcome: "ok", payload: aTarget() });
    const pushed: string[] = [];
    renderDetail({ actionLabel: null, pet: PAMPA }, { onOpenRoute: (r) => pushed.push(r) });
    fireEvent.press(await screen.findByText("Ver Pampa"));
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain("DIM-PAMP-0001");
  });

  it("does not open an outside link on its own — the person taps it", async () => {
    const url = "https://www.argentina.gob.ar/salud/glosario/rabia";
    mockFetchTarget.mockResolvedValue({
      outcome: "ok",
      payload: aTarget({
        outcome: "external",
        externalUrl: url,
        externalLabel: "Información oficial",
        reasonCopy: "Se abre fuera de miMAR.",
      }),
    });
    const opened: string[] = [];
    renderDetail(
      { actionLabel: "Ver detalle", pet: null },
      { onOpenExternal: (u) => opened.push(u) },
    );
    const button = await screen.findByText("Información oficial");
    expect(opened).toEqual([]);
    fireEvent.press(button);
    expect(opened).toEqual([url]);
  });

  it("keeps Archivar reachable, and archives only after the confirmation", async () => {
    mockFetchTarget.mockResolvedValue({ outcome: "ok", payload: aTarget() });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "archive", changed: true, unreadCount: 0 },
    });
    const toInbox = jest.fn();
    renderDetail({ actionLabel: null, pet: null }, { onOpenInbox: toInbox });

    fireEvent.press(await screen.findByText("Archivar"));
    // Nothing undoes an archive: the first tap only asks.
    expect(mockSend).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText("Archivar notificación"));

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend.mock.calls[0]?.[1]).toEqual({ command: "archive", notificationId: ID });
    await waitFor(() => expect(toInbox).toHaveBeenCalled());
  });

  it("keeps Archivar and the pet link reachable when the destination cannot be read", async () => {
    mockFetchTarget.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "archive", changed: true, unreadCount: 0 },
    });
    const toInbox = jest.fn();
    renderDetail({ actionLabel: "Ver detalle", pet: PAMPA }, { onOpenInbox: toInbox });
    expect(await screen.findByText("Ver Pampa")).toBeTruthy();
    fireEvent.press(screen.getByText("Archivar"));
    fireEvent.press(screen.getByText("Archivar notificación"));
    await waitFor(() => expect(toInbox).toHaveBeenCalled());
  });

  it("offers no inbox rows on a failed push tap", async () => {
    mockFetchTarget.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    renderScreen({});
    await screen.findByText("Ir a notificaciones");
    expect(screen.queryByText("Archivar")).toBeNull();
  });

  it("backs out of the archive confirmation without writing", async () => {
    mockFetchTarget.mockResolvedValue({ outcome: "ok", payload: aTarget() });
    renderDetail({ actionLabel: null, pet: null });
    fireEvent.press(await screen.findByText("Archivar"));
    fireEvent.press(screen.getByText("Volver"));
    expect(mockSend).not.toHaveBeenCalled();
    expect(screen.getByText("Archivar")).toBeTruthy();
  });

  it("says so when the archive is refused, and stays", async () => {
    mockFetchTarget.mockResolvedValue({ outcome: "ok", payload: aTarget() });
    mockSend.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    const toInbox = jest.fn();
    renderDetail({ actionLabel: null, pet: null }, { onOpenInbox: toInbox });
    fireEvent.press(await screen.findByText("Archivar"));
    fireEvent.press(screen.getByText("Archivar notificación"));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(toInbox).not.toHaveBeenCalled();
  });
});
