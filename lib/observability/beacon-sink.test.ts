/**
 * El transporte de los errores del cliente.
 *
 * LO QUE JUSTIFICA CADA CASO: este código corre ADENTRO de un error boundary de
 * React. Un reporter que lanza mientras reporta convierte una pantalla de error
 * recuperable en una irrecuperable — el contrato de `ErrorSink` dice que `send`
 * no puede lanzar, y acá se verifica en vez de confiar.
 *
 * Y el otro eje: `sendBeacon` no está por elegancia. El momento en que dispara
 * un error boundary es muy seguido el momento en que la página se va — la
 * persona recarga o se escapa de la pantalla rota. Un `fetch` común ahí se
 * CANCELA con el unload y el reporte se pierde: justamente los de los errores
 * lo bastante graves como para que alguien abandonara la página.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLIENT_ERROR_ENDPOINT, beaconSink, encodeReport } from "@/lib/observability/beacon-sink";
import type { RedactedErrorReport } from "@/lib/observability/sink";

const REPORT: RedactedErrorReport = {
  message: "Cannot read properties of undefined",
  name: "TypeError",
  stack: "TypeError: boom\n    at Foo (app.js:1:1)",
  context: { source: "error-boundary" },
  ts: "2026-09-17T00:00:00.000Z",
};

let sendBeacon: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sendBeacon = vi.fn(() => true);
  fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("navigator", { sendBeacon });
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("beaconSink", () => {
  it("usa sendBeacon y NO fetch cuando el navegador lo acepta", () => {
    beaconSink.send(REPORT);

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendBeacon.mock.calls[0][0]).toBe(CLIENT_ERROR_ENDPOINT);
  });

  it("manda el cuerpo como Blob con content-type JSON", () => {
    // `sendBeacon` con un string manda `text/plain`: el Blob es la forma
    // soportada de fijar el tipo, y sin él la ruta no parsearía.
    beaconSink.send(REPORT);

    const blob = sendBeacon.mock.calls[0][1] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/json");
  });

  it("cae a fetch con keepalive cuando el navegador SE NIEGA a encolar", () => {
    // `false` no es un error, es una negativa — y sin este camino el reporte se
    // perdería en silencio.
    sendBeacon.mockReturnValue(false);

    beaconSink.send(REPORT);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CLIENT_ERROR_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body as string)).toMatchObject({ message: REPORT.message });
  });

  it("cae a fetch cuando sendBeacon LANZA, que algunos agentes hacen", () => {
    sendBeacon.mockImplementation(() => {
      throw new Error("blocked by extension");
    });

    expect(() => beaconSink.send(REPORT)).not.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("cae a fetch cuando sendBeacon no existe", () => {
    vi.stubGlobal("navigator", {});

    beaconSink.send(REPORT);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("NO LANZA cuando el fetch de respaldo rechaza", async () => {
    sendBeacon.mockReturnValue(false);
    fetchSpy.mockRejectedValue(new Error("offline"));

    expect(() => beaconSink.send(REPORT)).not.toThrow();
    // Y el rechazo queda tragado en el transporte, no aguas arriba donde sería
    // indistinguible del error que se estaba reportando.
    await Promise.resolve();
  });

  it("NO LANZA cuando fetch mismo no existe", () => {
    sendBeacon.mockReturnValue(false);
    vi.stubGlobal("fetch", undefined);

    expect(() => beaconSink.send(REPORT)).not.toThrow();
  });

  it("un reporte inserializable queda en la consola en vez de perderse", () => {
    const circular = { ...REPORT } as RedactedErrorReport & { self?: unknown };
    circular.self = circular;

    expect(() => beaconSink.send(circular)).not.toThrow();
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it("se llama beacon y no vercel", () => {
    // Lo que el endpoint haga con el reporte es asunto del endpoint. Nombrar el
    // transporte según el destino de hoy sería una afirmación más que mantener.
    expect(beaconSink.name).toBe("beacon");
  });
});

describe("encodeReport", () => {
  it("devuelve null ante lo inserializable en vez de lanzar", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(encodeReport(circular as unknown as RedactedErrorReport)).toBeNull();
  });

  it("serializa un reporte normal entero", () => {
    expect(JSON.parse(encodeReport(REPORT) as string)).toEqual(REPORT);
  });
});
