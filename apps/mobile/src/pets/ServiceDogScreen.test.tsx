// `ServiceDogScreen` — the Ley 26.858 designation from the app (D3).
//
// WHAT THESE HAVE TO PROVE
//   1. THE GATE IS THE SERVER'S. `canManageServiceDog: false` renders the web's
//      own "solo bajo dueño legal permanente" notice and no form at all.
//   2. THE ACTS OFFERED ARE `ServiceDogForm`'s, per state: verification while
//      in training or pending, the banner only when vigente and in service,
//      retire while in service, nothing editable once revoked.
//   3. WHAT IS POSTED IS WHAT THE WEB FORM POSTS: DD/MM/AAAA becomes the wire's
//      YYYY-MM-DD, blanks become null, and no `publicVisibility` rides along.
//   4. AFTER EVERY ACT THE SCREEN RE-READS instead of trusting what it sent.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("../api/endpoints", () => ({
  fetchPetProfileEdit: (...args: unknown[]) => mockFetch(...args),
  sendPetProfileCommand: (...args: unknown[]) => mockSend(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import type { PetProfileEditV1, ServiceDogDesignationV1 } from "@dim/contract/api";

import { ServiceDogScreen } from "./ServiceDogScreen";

const TOKEN = "DIM-PAMP-0001";

function designation(over: Partial<ServiceDogDesignationV1> = {}): ServiceDogDesignationV1 {
  return {
    serviceType: "guia",
    credentialStatus: "pendiente_verificacion",
    inService: true,
    publicVisibility: "private_only",
    trainingCenter: "Bocalan Argentina",
    trainingCertDate: "2025-03-10",
    rupgaCredential: null,
    credentialIssueDate: null,
    credentialExpiryDate: null,
    notes: null,
    revocationReason: null,
    ...over,
  };
}

function payload(over: Partial<PetProfileEditV1> = {}): PetProfileEditV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-09-25T10:00:00.000Z",
    staleAfter: "2026-09-25T10:01:00.000Z",
    publicToken: TOKEN,
    species: "dog",
    identity: { name: "Pampa", breed: null, color: null },
    emergencyContacts: null,
    emergencyAccountDefault: null,
    physicalTagInterest: { interested: false, requestedAt: null },
    serviceDog: { designation: null },
    capabilities: {
      canEditIdentity: true,
      canEditEmergencyContacts: true,
      canCorrectSpecies: true,
      canTogglePhysicalTagInterest: true,
      canManageServiceDog: true,
    },
    ...over,
  } as PetProfileEditV1;
}

beforeEach(() => {
  mockFetch.mockReset();
  mockSend.mockReset();
  mockFetch.mockResolvedValue({ outcome: "ok", payload: payload() });
  mockSend.mockResolvedValue({ outcome: "ok", payload: { command: "save_service_dog" } });
});

describe("ServiceDogScreen — who sees what", () => {
  it("shows the legal-owner notice and no form when the server says no", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        serviceDog: null,
        capabilities: {
          canEditIdentity: true,
          canEditEmergencyContacts: false,
          canCorrectSpecies: true,
          canTogglePhysicalTagInterest: true,
          canManageServiceDog: false,
        },
      }),
    });
    render(<ServiceDogScreen publicToken={TOKEN} />);
    expect(
      await screen.findByText(
        "La credencial de asistencia se registra solo bajo dueño legal permanente.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText("Guardar datos")).toBeNull();
  });

  it("tells a non-dog's owner the law does not apply, with no form", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: payload({ species: "cat" }) });
    render(<ServiceDogScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/solo para perros/)).toBeOnTheScreen();
    expect(screen.queryByText("Guardar datos")).toBeNull();
  });

  it("offers only the registration form when nothing was ever saved", async () => {
    render(<ServiceDogScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Registrar como perro de asistencia")).toBeOnTheScreen();
    expect(screen.queryByText("Solicitar verificación")).toBeNull();
    expect(screen.queryByText("Retirar del servicio")).toBeNull();
    expect(screen.queryByText("Activar banner público")).toBeNull();
  });
});

describe("ServiceDogScreen — the acts, per state", () => {
  it("offers verification and retire for a pending, in-service designation, not the banner", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ serviceDog: { designation: designation() } }),
    });
    render(<ServiceDogScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Pendiente de verificación")).toBeOnTheScreen();
    expect(screen.getByText("Solicitar verificación")).toBeOnTheScreen();
    expect(screen.getByText("Retirar del servicio")).toBeOnTheScreen();
    expect(screen.queryByText("Activar banner público")).toBeNull();
  });

  it("offers the banner only when vigente and in service, and posts the visibility alone", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        serviceDog: { designation: designation({ credentialStatus: "vigente" }) },
      }),
    });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "set_service_dog_visibility" },
    });
    render(<ServiceDogScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Activar banner público"));
    await waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith({}, TOKEN, {
        command: "set_service_dog_visibility",
        publicVisibility: "full_banner",
      }),
    );
    expect(screen.queryByText("Solicitar verificación")).toBeNull();
    // Re-read after the act: the initial load and the one after the ack.
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it("locks the form once revoked and shows the reason", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        serviceDog: {
          designation: designation({
            credentialStatus: "revocada",
            inService: false,
            revocationReason: "Credencial presentada con datos inconsistentes.",
          }),
        },
      }),
    });
    render(<ServiceDogScreen publicToken={TOKEN} />);
    expect(
      await screen.findByText(
        "Motivo de revocación: Credencial presentada con datos inconsistentes.",
      ),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByText("Guardar datos"));
    expect(mockSend).not.toHaveBeenCalled();
    expect(screen.queryByText("Retirar del servicio")).toBeNull();
  });

  it("asks before retiring, and only the confirmation posts", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ serviceDog: { designation: designation() } }),
    });
    mockSend.mockResolvedValue({ outcome: "ok", payload: { command: "retire_service_dog" } });
    render(<ServiceDogScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Retirar del servicio"));
    expect(mockSend).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText("Confirmar retiro"));
    await waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith({}, TOKEN, { command: "retire_service_dog" }),
    );
    expect(
      await screen.findByText("Listo. El perro quedó retirado del servicio."),
    ).toBeOnTheScreen();
  });
});

describe("ServiceDogScreen — saving", () => {
  it("posts the web form's fields, dates on the wire format and blanks as null", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ serviceDog: { designation: designation() } }),
    });
    render(<ServiceDogScreen publicToken={TOKEN} />);
    // Pre-filled from the row, the date in the format a person reads.
    expect(await screen.findByDisplayValue("10/03/2025")).toBeOnTheScreen();
    fireEvent.changeText(screen.getByDisplayValue("Bocalan Argentina"), "Centro Nuevo");
    fireEvent.press(screen.getByText("Guardar datos"));
    await waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith({}, TOKEN, {
        command: "save_service_dog",
        serviceType: "guia",
        trainingCenter: "Centro Nuevo",
        trainingCertDate: "2025-03-10",
        rupgaCredential: null,
        credentialIssueDate: null,
        credentialExpiryDate: null,
        notes: null,
      }),
    );
    expect(await screen.findByText("Datos guardados.")).toBeOnTheScreen();
  });

  it("refuses locally, with the field's sentence, when the training centre is empty", async () => {
    render(<ServiceDogScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Guardar datos"));
    expect(await screen.findByText("Indicá el centro de entrenamiento.")).toBeOnTheScreen();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("shows the service_dog_refused copy on a refusal", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ serviceDog: { designation: designation() } }),
    });
    mockSend.mockResolvedValue({
      outcome: "api-error",
      code: "service_dog_refused",
      retryAfterSeconds: null,
    });
    render(<ServiceDogScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Solicitar verificación"));
    expect(await screen.findByText(/Puede que ya haya una solicitud pendiente/)).toBeOnTheScreen();
  });
});
