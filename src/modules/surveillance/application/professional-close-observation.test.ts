// Unit tests for application/professional-close-observation.ts (spec §D)
// Strict TDD — tests written BEFORE implementation.
//
// CRITICAL parity test: out-of-jurisdiction govt user MUST be rejected.
// This is the cross-org bypass lesson from the welfare module.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PetEvent } from "@/db/schema";
import type { SurveillanceRepository } from "../infrastructure/surveillance-repository";
import {
  type ProfessionalCloseObservationInput,
  professionalCloseObservation,
} from "./professional-close-observation";

type FakeRepo = Partial<Record<keyof SurveillanceRepository, ReturnType<typeof vi.fn>>>;

const FAKE_BITE_ID = "a0000000-0000-4000-8000-000000000005";
const FAKE_STARTED_ID = "a0000000-0000-4000-8000-000000000006";
const FAKE_ENDED_ID = "a0000000-0000-4000-8000-000000000007";

function makeStartedEvent(): PetEvent {
  return {
    id: FAKE_STARTED_ID,
    petId: "pet-3",
    eventType: "rabies_observation_started",
    occurredAt: new Date("2024-08-01"),
    recordedAt: new Date("2024-08-01"),
    recordedByUserId: "user-org",
    authorRole: "vet",
    authorOrganizationId: "org-1",
    authorVerified: true,
    payload: {
      bite_event_id: FAKE_BITE_ID,
      observation_until: new Date("2024-08-11").toISOString(),
      location: "in_situ",
      official_site_organization_id: null,
    },
    caseId: "case-2",
    clientIdempotencyKey: null,
    createdAt: new Date("2024-08-01"),
  } as unknown as PetEvent;
}

function makeRepo(overrides: FakeRepo = {}): SurveillanceRepository {
  return {
    findPetByToken: vi.fn().mockResolvedValue({
      id: "pet-3",
      publicToken: "tok-prof-1",
      name: "Luna",
      species: "cat",
      status: "alive",
      rabiesObservationStatus: "in_progress",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    }),
    findLatestObservationStarted: vi.fn().mockResolvedValue(makeStartedEvent()),
    findOpenBiteCase: vi.fn().mockResolvedValue({ id: "case-2" }),
    insertObservationEnded: vi.fn().mockResolvedValue({ id: FAKE_ENDED_ID }),
    setObservationStatus: vi.fn().mockResolvedValue(undefined),
    // Por defecto GANA la carrera: devuelve true. Los tests que quieren
    // ejercitar al perdedor lo sobreescriben con false.
    closeObservationIfOpen: vi.fn().mockResolvedValue(true),
    findActiveOwnerUserIds: vi.fn().mockResolvedValue([]),
    insertObservationCloseAuditLog: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SurveillanceRepository;
}

function makeDeps(repoOverrides: FakeRepo = {}) {
  const repo = makeRepo(repoOverrides);
  const closeCase = vi.fn().mockResolvedValue(undefined);
  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb("fake-tx");
  });
  return { repo, closeCase, transaction };
}

// Admin actor — universal scope
const ADMIN_ACTOR = {
  profile: { id: "admin-user-1", role: "admin" as const },
  jurisdictions: [] as Array<{ province: string; locality: string }>,
};

// Govt actor IN jurisdiction
const GOVT_IN_JURISDICTION = {
  profile: { id: "govt-user-1", role: "govt" as const },
  jurisdictions: [{ province: "Buenos Aires", locality: "La Plata" }],
};

// Govt actor OUT of jurisdiction — MUST BE REJECTED
const GOVT_OUT_JURISDICTION = {
  profile: { id: "govt-user-2", role: "govt" as const },
  jurisdictions: [{ province: "Córdoba", locality: "Río Cuarto" }],
};

// Veterinario matriculado, con el animal delante (2026-09-17).
//
// `jurisdictions` vacío NO es un descuido: el alcance del veterinario no es
// territorial. Su relación con la mascota la resolvió `resolveAtenderPet` aguas
// arriba — `event.write` sobre esta organización más el código DIM — y la
// matrícula viene de `eventAuthorship`, atada al firmante.
const VET_ACTOR = {
  profile: { id: "vet-user-1", role: "vet" as const },
  jurisdictions: [] as Array<{ province: string; locality: string }>,
  organizationId: "org-vet-1",
  organizationName: "Veterinaria San Roque",
};

const BASE_INPUT: ProfessionalCloseObservationInput = {
  petPublicToken: "tok-prof-1",
  outcome: "negative",
  closureNotes: null,
  actor: ADMIN_ACTOR,
};

// ---------------------------------------------------------------------------
// Admin happy path (universal scope)
// ---------------------------------------------------------------------------

describe("professionalCloseObservation — admin actor", () => {
  it("returns ok=true for admin with any outcome", async () => {
    const deps = makeDeps();
    const result = await professionalCloseObservation(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
  });

  it("inserts rabies_observation_ended with outcome passed", async () => {
    const deps = makeDeps();
    await professionalCloseObservation({ ...BASE_INPUT, outcome: "positive_rabies" }, deps);
    const call = (deps.repo.insertObservationEnded as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { payload: Record<string, unknown> };
    expect(call.payload.outcome).toBe("positive_rabies");
  });

  it("stores authorRole=govt regardless of admin role (column-level parity)", async () => {
    const deps = makeDeps();
    await professionalCloseObservation(BASE_INPUT, deps);
    const call = (deps.repo.insertObservationEnded as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { authorRole: string };
    expect(call.authorRole).toBe("govt");
  });

  it("closes case with reason=resolved for outcome=negative", async () => {
    const deps = makeDeps();
    await professionalCloseObservation({ ...BASE_INPUT, outcome: "negative" }, deps);
    expect(deps.closeCase).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "resolved" }),
      "fake-tx",
    );
  });

  it("closes case with reason=cancelled for outcome=lost_to_followup", async () => {
    const deps = makeDeps();
    await professionalCloseObservation({ ...BASE_INPUT, outcome: "lost_to_followup" }, deps);
    expect(deps.closeCase).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cancelled" }),
      "fake-tx",
    );
  });

  it("includes owner notification with urgent severity for positive_rabies", async () => {
    const deps = makeDeps({
      findActiveOwnerUserIds: vi.fn().mockResolvedValue(["owner-99"]),
    });
    const result = await professionalCloseObservation(
      { ...BASE_INPUT, outcome: "positive_rabies" },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const notif = result.notifications.find(
      (n) => n.notificationType === "rabies_observation_completed_professional_owner",
    );
    expect(notif?.severity).toBe("urgent");
  });

  it("includes owner notification with info severity for negative", async () => {
    const deps = makeDeps({
      findActiveOwnerUserIds: vi.fn().mockResolvedValue(["owner-99"]),
    });
    const result = await professionalCloseObservation({ ...BASE_INPUT, outcome: "negative" }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const notif = result.notifications.find(
      (n) => n.notificationType === "rabies_observation_completed_professional_owner",
    );
    expect(notif?.severity).toBe("info");
  });
});

// ---------------------------------------------------------------------------
// Positive rabies escalation + incomplete payload resilience (QA 2026-07-08)
// ---------------------------------------------------------------------------

describe("professionalCloseObservation — positive rabies escalation", () => {
  it("fans out an urgent authority notification on positive_rabies close", async () => {
    const deps = makeDeps();
    const findAuthoritiesForJurisdiction = vi.fn().mockResolvedValue(["auth-1", "auth-2"]);
    const result = await professionalCloseObservation(
      { ...BASE_INPUT, outcome: "positive_rabies" },
      { ...deps, findAuthoritiesForJurisdiction },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findAuthoritiesForJurisdiction).toHaveBeenCalledWith({
      province: "Buenos Aires",
      locality: "La Plata",
    });
    const authNotifs = result.notifications.filter(
      (n) => n.notificationType === "rabies_observation_positive_authority",
    );
    expect(authNotifs).toHaveLength(2);
    expect(authNotifs.every((n) => n.severity === "urgent")).toBe(true);
  });

  it("a lookup that THROWS falls back to the national admins instead of queuing nothing", async () => {
    const deps = makeDeps();
    const findAuthoritiesForJurisdiction = vi.fn().mockRejectedValue(new Error("pool reset"));
    const findNationalAdminIds = vi.fn().mockResolvedValue(["admin-a", "admin-b"]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await professionalCloseObservation(
      { ...BASE_INPUT, outcome: "positive_rabies" },
      { ...deps, findAuthoritiesForJurisdiction, findNationalAdminIds },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const authNotifs = result.notifications.filter(
      (n) => n.notificationType === "rabies_observation_positive_authority",
    );
    expect(authNotifs.map((n) => n.userId)).toEqual(["admin-a", "admin-b"]);
    expect(authNotifs.every((n) => n.severity === "urgent")).toBe(true);
    expect(authNotifs[0]).toMatchObject({
      title: "RABIA CONFIRMADA — Luna",
      ctaUrl: "/gob/vigilancia",
    });
    // And the failure is not silent.
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("the fallback is not consulted when the lookup answers, even with nobody", async () => {
    // An EMPTY answer is the resolver's own verdict (it already fell back to
    // the admins and recorded the empty fan-out); only a throw is a lost alert.
    const deps = makeDeps();
    const findNationalAdminIds = vi.fn().mockResolvedValue(["admin-a"]);
    await professionalCloseObservation(
      { ...BASE_INPUT, outcome: "positive_rabies" },
      {
        ...deps,
        findAuthoritiesForJurisdiction: vi.fn().mockResolvedValue([]),
        findNationalAdminIds,
      },
    );
    expect(findNationalAdminIds).not.toHaveBeenCalled();
  });

  it("does NOT fan out to authorities for a negative close", async () => {
    const deps = makeDeps();
    const findAuthoritiesForJurisdiction = vi.fn().mockResolvedValue(["auth-1"]);
    const result = await professionalCloseObservation(BASE_INPUT, {
      ...deps,
      findAuthoritiesForJurisdiction,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findAuthoritiesForJurisdiction).not.toHaveBeenCalled();
    expect(
      result.notifications.some(
        (n) => n.notificationType === "rabies_observation_positive_authority",
      ),
    ).toBe(false);
  });
});

describe("professionalCloseObservation — resilient close for incomplete payloads", () => {
  it("closes cleanly when the started event has NO bite_event_id (records null)", async () => {
    const startedNoBite = {
      ...makeStartedEvent(),
      payload: {
        observation_until: new Date("2024-08-11").toISOString(),
        location: "in_situ",
        official_site_organization_id: null,
      },
    } as unknown as PetEvent;
    const deps = makeDeps({
      findLatestObservationStarted: vi.fn().mockResolvedValue(startedNoBite),
    });
    const result = await professionalCloseObservation(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    const call = (deps.repo.insertObservationEnded as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { payload: Record<string, unknown> };
    expect(call.payload.bite_event_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Govt actor — jurisdiction scope enforcement (CRITICAL: cross-org bypass guard)
// ---------------------------------------------------------------------------

describe("professionalCloseObservation — govt jurisdiction scope", () => {
  it("returns ok=true when govt is in jurisdiction", async () => {
    const deps = makeDeps();
    const result = await professionalCloseObservation(
      { ...BASE_INPUT, actor: GOVT_IN_JURISDICTION },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it("REJECTS govt actor whose jurisdiction does NOT match the pet's jurisdiction", async () => {
    const deps = makeDeps();
    const result = await professionalCloseObservation(
      { ...BASE_INPUT, actor: GOVT_OUT_JURISDICTION },
      deps,
    );
    // This is the parity test proving out-of-jurisdiction govt is REJECTED
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no está dentro de tu cobertura asignada/i);
  });

  it("does NOT call insertObservationEnded when govt is out of jurisdiction", async () => {
    const deps = makeDeps();
    await professionalCloseObservation({ ...BASE_INPUT, actor: GOVT_OUT_JURISDICTION }, deps);
    expect(deps.repo.insertObservationEnded).not.toHaveBeenCalled();
  });

  it("does NOT close the case when govt is out of jurisdiction", async () => {
    const deps = makeDeps();
    await professionalCloseObservation({ ...BASE_INPUT, actor: GOVT_OUT_JURISDICTION }, deps);
    expect(deps.closeCase).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error paths (spec §D negatives)
// ---------------------------------------------------------------------------

describe("professionalCloseObservation — error paths", () => {
  it("returns error when pet not found", async () => {
    const deps = makeDeps({
      findPetByToken: vi.fn().mockResolvedValue(null),
    });
    const result = await professionalCloseObservation(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/mascota no encontrada/i);
  });

  it("returns error when pet has no active observation", async () => {
    const deps = makeDeps({
      findPetByToken: vi.fn().mockResolvedValue({
        id: "pet-3",
        publicToken: "tok-prof-1",
        name: "Luna",
        species: "cat",
        status: "alive",
        rabiesObservationStatus: "completed_negative",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
      }),
    });
    const result = await professionalCloseObservation(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no tiene una observación abierta/i);
  });

  it("ACCEPTS a window_expired_unclosed observation — that is the queue it drains", async () => {
    const deps = makeDeps({
      findPetByToken: vi.fn().mockResolvedValue({
        id: "pet-3",
        publicToken: "tok-prof-1",
        name: "Luna",
        species: "cat",
        status: "alive",
        rabiesObservationStatus: "window_expired_unclosed",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
      }),
    });
    const result = await professionalCloseObservation(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    expect(deps.repo.closeObservationIfOpen).toHaveBeenCalledWith(
      "pet-3",
      "completed_negative",
      expect.any(Date),
      "fake-tx",
    );
  });

  it("returns error when no started event found (internal inconsistency)", async () => {
    const deps = makeDeps({
      findLatestObservationStarted: vi.fn().mockResolvedValue(null),
    });
    const result = await professionalCloseObservation(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/inconsistencia/i);
  });
});

// ---------------------------------------------------------------------------
// Audit log — REQUIRED since 2026-08-17
//
// This close is the only path by which a clinical outcome enters the record, so
// the administrative act carries an audit row with before/after state, written
// inside the same transaction as the mutation it describes.
// ---------------------------------------------------------------------------

describe("professionalCloseObservation — audit_log", () => {
  it("writes rabies_observation_closed_professional with before/after state", async () => {
    const deps = makeDeps();
    await professionalCloseObservation({ ...BASE_INPUT, outcome: "positive_rabies" }, deps);
    const spy = deps.repo.insertObservationCloseAuditLog as ReturnType<typeof vi.fn>;
    expect(spy).toHaveBeenCalledTimes(1);
    const [entry, executor] = spy.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(entry.action).toBe("rabies_observation_closed_professional");
    expect(entry.actorUserId).toBe("admin-user-1");
    expect(entry.before).toEqual({ rabies_observation_status: "in_progress" });
    expect(entry.after).toEqual({ rabies_observation_status: "completed_positive_rabies" });
    // Same transaction as the close — a rollback must take the audit row too.
    expect(executor).toBe("fake-tx");
  });

  it("writes NO audit row when the close is refused (out-of-jurisdiction govt)", async () => {
    const deps = makeDeps();
    await professionalCloseObservation({ ...BASE_INPUT, actor: GOVT_OUT_JURISDICTION }, deps);
    expect(deps.repo.insertObservationCloseAuditLog).not.toHaveBeenCalled();
  });

  // CARRERA ENTRE DOS CIERRES (2026-08-18).
  //
  // El chequeo de "sigue abierta" ocurre ANTES de la transacción, así que dos
  // veterinarios —o un veterinario y el cron de expiración— lo pasaban los dos.
  // Y el evento `rabies_observation_ended` se inserta ANTES de tocar el estado,
  // de modo que el perdedor ya había dejado en el espinazo un resultado clínico
  // que contradice al del ganador: uno "negativo" y otro "positive_rabies"
  // sobre el mismo animal, append-only, imposibles de corregir después.
  //
  // `closeObservationIfOpen` devolviendo false ES el perdedor: la fila ya no
  // estaba abierta cuando llegó su UPDATE.
  it("no deja el cierre asentado cuando otro lo ganó por milisegundos", async () => {
    const deps = makeDeps();
    (deps.repo.closeObservationIfOpen as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const result = await professionalCloseObservation(BASE_INPUT, deps);

    // El llamador se entera de que no fue suyo…
    expect(result.ok).toBe(false);
    // …y aborta ANTES de escribir la fila de rendición de cuentas.
    //
    // Lo que este test prueba y lo que no: el doble de `transaction` acá
    // ejecuta el callback sin simular rollback, así que verifica el corte del
    // flujo, no la reversión. Que el evento clínico insertado un paso antes
    // desaparezca es una propiedad de la transacción real de Postgres —
    // garantizada porque ambas escrituras ocurren dentro de la misma— y no algo
    // que este doble pueda demostrar.
    expect(deps.repo.insertObservationCloseAuditLog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Veterinario matriculado (PO, 2026-09-17)
// ---------------------------------------------------------------------------

describe("professionalCloseObservation — veterinario", () => {
  it("cierra, y la mascota NO tiene por qué estar en ninguna jurisdicción suya", async () => {
    // El punto del caso: el veterinario no falla el chequeo territorial porque
    // NO PASA por él. Su alcance es el animal que tiene delante. Si alguien
    // mueve la rama de jurisdicción para que lo alcance, esto se pone rojo.
    const deps = makeDeps();
    const result = await professionalCloseObservation({ ...BASE_INPUT, actor: VET_ACTOR }, deps);

    expect(result.ok).toBe(true);
    expect(deps.repo.closeObservationIfOpen).toHaveBeenCalled();
  });

  it("firma el evento como vet, con su organización y matrícula verificada", async () => {
    // Las tres columnas juntas son lo que vuelve auditable la firma: sin la
    // organización, un evento firmado como profesional verificado no dice de qué
    // clínica salió, que es la mitad de su valor.
    const deps = makeDeps();
    await professionalCloseObservation({ ...BASE_INPUT, actor: VET_ACTOR }, deps);

    const [row] = (deps.repo.insertObservationEnded as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(row.authorRole).toBe("vet");
    expect(row.authorOrganizationId).toBe("org-vet-1");
    expect(row.authorVerified).toBe(true);
    expect(row.recordedByUserId).toBe("vet-user-1");
  });

  it("el Estado sigue firmando como govt, sin organización y sin verificar", async () => {
    // El control del caso anterior. Sin esto, un bug que pusiera authorVerified
    // en true para todos pasaría desapercibido.
    const deps = makeDeps();
    await professionalCloseObservation({ ...BASE_INPUT, actor: ADMIN_ACTOR }, deps);

    const [row] = (deps.repo.insertObservationEnded as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(row.authorRole).toBe("govt");
    expect(row.authorOrganizationId).toBeNull();
    expect(row.authorVerified).toBe(false);
  });

  it("el payload guarda closed_by_role='vet', que es la distinción precisa", async () => {
    // `authorRole` colapsa admin y govt en 'govt' porque el enum de la columna no
    // tiene 'admin'. El payload es donde sobrevive quién cerró de verdad.
    const deps = makeDeps();
    await professionalCloseObservation({ ...BASE_INPUT, actor: VET_ACTOR }, deps);

    const [row] = (deps.repo.insertObservationEnded as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((row.payload as { closed_by_role: string }).closed_by_role).toBe("vet");
  });

  it("FALLA CERRADO sin organización, en vez de firmar como profesional anónimo", async () => {
    // El caso de uso no puede distinguir "el llamador se la olvidó" de "no había
    // ninguna". Firmar igual dejaría en la espina append-only un resultado
    // clínico verificado que no dice de qué clínica salió, imposible de corregir.
    const deps = makeDeps();
    const result = await professionalCloseObservation(
      { ...BASE_INPUT, actor: { ...VET_ACTOR, organizationId: undefined } },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/organización/i);
    // Y no escribió NADA: ni el evento ni el cierre del estado.
    expect(deps.repo.insertObservationEnded).not.toHaveBeenCalled();
    expect(deps.repo.closeObservationIfOpen).not.toHaveBeenCalled();
  });

  it("al dueño se le dice que cerró su VETERINARIO, y DE QUÉ CLÍNICA", async () => {
    // Era un ternario de dos ramas. Con el veterinario adentro habría dicho "una
    // autoridad sanitaria" sobre un cierre hecho por el veterinario. Y en la
    // puerta de walk-in no alcanza con "un veterinario": una clínica sin custodia
    // escribió sobre el animal, y nombrarla es la mitigación que aceptó el PO.
    const deps = makeDeps({
      findActiveOwnerUserIds: vi.fn().mockResolvedValue(["owner-1"]),
    });
    const result = await professionalCloseObservation({ ...BASE_INPUT, actor: VET_ACTOR }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ownerNotice).toEqual({
      notificationType: "rabies_observation_completed_professional_owner",
      severity: "info",
      title: "Observación cerrada profesionalmente — Luna",
      body: "La observación antirrábica de Luna fue cerrada por un veterinario matriculado de Veterinaria San Roque con resultado negativo (animal sano). Si no reconocés esta atención, avisá a la autoridad sanitaria de tu localidad.",
      relatedCaseId: "case-2",
    });
  });

  it("el aviso del veterinario NO viaja como fila a un solo dueño: lo entrega el walk-in a todos", async () => {
    // `findActiveOwnership` devolvía UNA fila `role = 'owner'`. Por esta puerta
    // el aviso vuelve como contenido y la finalización de Atender lo entrega a
    // cada dueño y co-dueño activo. Si alguien lo vuelve a empujar como fila
    // acá, el co-dueño deja de enterarse y esto se pone rojo.
    const deps = makeDeps({
      findActiveOwnerUserIds: vi.fn().mockResolvedValue(["owner-1"]),
    });
    const result = await professionalCloseObservation({ ...BASE_INPUT, actor: VET_ACTOR }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.repo.findActiveOwnerUserIds).not.toHaveBeenCalled();
    expect(
      result.notifications.some(
        (n) => n.notificationType === "rabies_observation_completed_professional_owner",
      ),
    ).toBe(false);
  });

  it("devuelve el evento que asentó y cuándo, que es lo que el walk-in necesita", async () => {
    const deps = makeDeps();
    const result = await professionalCloseObservation({ ...BASE_INPUT, actor: VET_ACTOR }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.endedEventId).toBe(FAKE_ENDED_ID);
    const [row] = (deps.repo.insertObservationEnded as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(result.value.closedAt).toBe(row.occurredAt);
  });

  it("FALLA CERRADO sin el nombre de la organización, que es lo que el dueño lee", async () => {
    const deps = makeDeps();
    const result = await professionalCloseObservation(
      { ...BASE_INPUT, actor: { ...VET_ACTOR, organizationName: undefined } },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/organización/i);
    expect(deps.repo.insertObservationEnded).not.toHaveBeenCalled();
  });

  it("el Estado sigue avisando como antes: fila al dueño, sin contenido aparte", async () => {
    // El control de los tres casos anteriores: la puerta del Estado no cambió.
    for (const actor of [ADMIN_ACTOR, GOVT_IN_JURISDICTION]) {
      const deps = makeDeps({
        findActiveOwnerUserIds: vi.fn().mockResolvedValue(["owner-1"]),
      });
      const result = await professionalCloseObservation({ ...BASE_INPUT, actor }, deps);
      expect(result.ok, actor.profile.role).toBe(true);
      if (!result.ok) continue;
      expect(result.value.ownerNotice, actor.profile.role).toBeNull();
      const aviso = result.notifications.find(
        (n) => n.notificationType === "rabies_observation_completed_professional_owner",
      );
      expect(aviso?.userId, actor.profile.role).toBe("owner-1");
      expect(aviso?.body, actor.profile.role).not.toContain("Si no reconocés");
    }
  });

  it("el Estado avisa a CADA dueño y co-dueño activo, no a una sola fila", async () => {
    // Leía `findActiveOwnership`: una fila `role = 'owner'`, `limit(1)`. El
    // co-dueño nunca se enteraba de que la observación de su animal se cerró.
    for (const actor of [ADMIN_ACTOR, GOVT_IN_JURISDICTION]) {
      const deps = makeDeps({
        findActiveOwnerUserIds: vi.fn().mockResolvedValue(["owner-1", "co-owner-2"]),
      });
      const result = await professionalCloseObservation(
        { ...BASE_INPUT, outcome: "positive_rabies", actor },
        deps,
      );
      expect(result.ok, actor.profile.role).toBe(true);
      if (!result.ok) continue;
      const avisos = result.notifications.filter(
        (n) => n.notificationType === "rabies_observation_completed_professional_owner",
      );
      expect(avisos.map((n) => n.userId).sort(), actor.profile.role).toEqual([
        "co-owner-2",
        "owner-1",
      ]);
      for (const aviso of avisos) expect(aviso.severity).toBe("urgent");
      expect(deps.repo.findActiveOwnerUserIds).toHaveBeenCalledWith("pet-3", "fake-tx");
    }
  });

  it("y a cada actor se lo nombra distinto, que es para lo que existe el mapa", async () => {
    const esperado: Array<[typeof ADMIN_ACTOR | typeof GOVT_IN_JURISDICTION, string]> = [
      [ADMIN_ACTOR, "fue cerrada por un administrador con"],
      [GOVT_IN_JURISDICTION, "fue cerrada por una autoridad sanitaria con"],
    ];

    for (const [actor, frase] of esperado) {
      const deps = makeDeps({
        findActiveOwnerUserIds: vi.fn().mockResolvedValue(["owner-1"]),
      });
      const result = await professionalCloseObservation({ ...BASE_INPUT, actor }, deps);
      expect(result.ok, `${actor.profile.role} no pudo cerrar`).toBe(true);
      if (!result.ok) continue;
      const aviso = result.notifications.find(
        (n) => n.notificationType === "rabies_observation_completed_professional_owner",
      );
      expect(aviso?.body, `${actor.profile.role}`).toContain(frase);
    }

    const deps = makeDeps();
    const result = await professionalCloseObservation({ ...BASE_INPUT, actor: VET_ACTOR }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ownerNotice?.body).toContain(
      "fue cerrada por un veterinario matriculado de Veterinaria San Roque con",
    );
  });

  it("un positivo escala a la autoridad IGUAL que si cerrara el Estado", async () => {
    // Rabia confirmada es un evento de salud pública. Que la haya registrado un
    // veterinario en su clínica no la vuelve menos urgente para la jurisdicción,
    // y este caso existe porque la puerta nueva podría haberse saltado el fan-out.
    const deps = makeDeps({
      findActiveOwnerUserIds: vi.fn().mockResolvedValue(["owner-1"]),
    });
    const result = await professionalCloseObservation(
      { ...BASE_INPUT, outcome: "positive_rabies", actor: VET_ACTOR },
      {
        ...deps,
        findAuthoritiesForJurisdiction: vi.fn().mockResolvedValue(["authority-1", "authority-2"]),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const alertas = result.notifications.filter(
      (n) => n.notificationType === "rabies_observation_positive_authority",
    );
    expect(alertas).toHaveLength(2);
    expect(alertas[0].severity).toBe("urgent");
  });
});

// ---------------------------------------------------------------------------
// The veterinarian waits for the window (PO decision 2026-09-18)
//
// "Tiene que esperar, es un tema de plazos legales." Rabies signs can appear up
// to the last day, so a vet's negative before the deadline is refused — and the
// refusal names the date. Outcomes that report something that already happened
// are not held back, and the State keeps the power to close negative early.
// ---------------------------------------------------------------------------

describe("professionalCloseObservation — the vet's negative waits for the deadline", () => {
  // 12:00 UTC is 09:00 in Argentina (UTC-3, no DST).
  const DEADLINE_ISO = "2026-09-24T12:00:00.000Z";
  const BEFORE_DEADLINE = new Date("2026-09-18T15:00:00.000Z");
  const AFTER_DEADLINE = new Date("2026-09-24T13:00:00.000Z");

  function startedWithDeadline(payloadOverrides: Record<string, unknown> = {}): PetEvent {
    const base = makeStartedEvent();
    return {
      ...base,
      occurredAt: new Date("2026-09-14T12:00:00.000Z"),
      payload: {
        ...(base.payload as Record<string, unknown>),
        observation_until: DEADLINE_ISO,
        ...payloadOverrides,
      },
    } as unknown as PetEvent;
  }

  function depsWithDeadline(started: PetEvent = startedWithDeadline()) {
    return makeDeps({ findLatestObservationStarted: vi.fn().mockResolvedValue(started) });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("REFUSES a vet's negative before the deadline, naming the date, and writes nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BEFORE_DEADLINE);
    const deps = depsWithDeadline();

    const result = await professionalCloseObservation(
      { ...BASE_INPUT, outcome: "negative", actor: VET_ACTOR },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("termina el 24 de septiembre de 2026 a las 09:00");
    expect(deps.repo.insertObservationEnded).not.toHaveBeenCalled();
    expect(deps.repo.closeObservationIfOpen).not.toHaveBeenCalled();
    expect(deps.repo.insertObservationCloseAuditLog).not.toHaveBeenCalled();
    expect(deps.closeCase).not.toHaveBeenCalled();
  });

  it("accepts the vet's negative once the deadline has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AFTER_DEADLINE);
    const deps = depsWithDeadline();

    const result = await professionalCloseObservation(
      { ...BASE_INPUT, outcome: "negative", actor: VET_ACTOR },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(deps.repo.closeObservationIfOpen).toHaveBeenCalledWith(
      "pet-3",
      "completed_negative",
      expect.any(Date),
      "fake-tx",
    );
  });

  it("does NOT hold back a positive: it goes through before the deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BEFORE_DEADLINE);
    const deps = depsWithDeadline();

    const result = await professionalCloseObservation(
      { ...BASE_INPUT, outcome: "positive_rabies", actor: VET_ACTOR },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.repo.insertObservationEnded).toHaveBeenCalledTimes(1);
  });

  // PO D1 (2026-09-18), from the security review of this door: a vet's early
  // `dead` or `lost_to_followup` had the same effect as an early negative —
  // banner gone, bite case closed, no authority told.
  function expectNothingWritten(deps: ReturnType<typeof depsWithDeadline>) {
    expect(deps.repo.insertObservationEnded).not.toHaveBeenCalled();
    expect(deps.repo.closeObservationIfOpen).not.toHaveBeenCalled();
    expect(deps.repo.insertObservationCloseAuditLog).not.toHaveBeenCalled();
    expect(deps.closeCase).not.toHaveBeenCalled();
  }

  it("refuses the vet's 'sin seguimiento' BEFORE the deadline — the animal is at the clinic", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BEFORE_DEADLINE);
    const deps = depsWithDeadline();

    const result = await professionalCloseObservation(
      { ...BASE_INPUT, outcome: "lost_to_followup", actor: VET_ACTOR },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      "Desde la clínica no podés cerrar la observación como “sin seguimiento”: Luna está con vos. Si el dueño deja de traerlo, avisá a la autoridad sanitaria de tu localidad, que es quien cierra una observación sin seguimiento.",
    );
    expectNothingWritten(deps);
  });

  it("refuses the vet's 'sin seguimiento' AFTER the deadline too — at any time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AFTER_DEADLINE);
    const deps = depsWithDeadline();

    const result = await professionalCloseObservation(
      { ...BASE_INPUT, outcome: "lost_to_followup", actor: VET_ACTOR },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("“sin seguimiento”");
    expectNothingWritten(deps);
  });

  it("refuses the vet's death BEFORE the deadline and sends them to the record and the authority", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BEFORE_DEADLINE);
    const deps = depsWithDeadline();

    const result = await professionalCloseObservation(
      { ...BASE_INPUT, outcome: "dead", actor: VET_ACTOR },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      "Si Luna murió durante la observación, usá “Registrar muerte durante la observación”: registra el fallecimiento, cierra la observación y avisa de urgencia a la autoridad sanitaria, que puede necesitar tomar la muestra para el laboratorio. Cerrar como “Fallecido” sin registrar la muerte se habilita recién desde el 24 de septiembre de 2026 a las 09:00.",
    );
    expectNothingWritten(deps);
  });

  it("accepts the vet's death once the deadline has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AFTER_DEADLINE);
    const deps = depsWithDeadline();

    const result = await professionalCloseObservation(
      { ...BASE_INPUT, outcome: "dead", actor: VET_ACTOR },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.repo.closeObservationIfOpen).toHaveBeenCalledWith(
      "pet-3",
      "completed_dead",
      expect.any(Date),
      "fake-tx",
    );
  });

  it("the State keeps death and 'sin seguimiento' at any time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BEFORE_DEADLINE);

    for (const actor of [ADMIN_ACTOR, GOVT_IN_JURISDICTION]) {
      for (const outcome of ["dead", "lost_to_followup"] as const) {
        const deps = depsWithDeadline();
        const result = await professionalCloseObservation({ ...BASE_INPUT, outcome, actor }, deps);
        expect(result.ok, `${actor.profile.role}/${outcome}`).toBe(true);
        expect(deps.repo.insertObservationEnded).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("the State keeps the power to close negative early — admin and govt are not gated", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BEFORE_DEADLINE);

    for (const actor of [ADMIN_ACTOR, GOVT_IN_JURISDICTION]) {
      const deps = depsWithDeadline();
      const result = await professionalCloseObservation(
        { ...BASE_INPUT, outcome: "negative", actor },
        deps,
      );
      expect(result.ok, actor.profile.role).toBe(true);
      expect(deps.repo.insertObservationEnded, actor.profile.role).toHaveBeenCalledTimes(1);
    }
  });

  it("an older payload WITHOUT observation_until still gates, on started + 10 days", async () => {
    // Without the shared fallback the deadline would be absent and the gate would
    // open silently for exactly the observations that predate the field.
    // Started 2026-09-14 12:00 UTC + 10 calendar days = 2026-09-24 12:00 UTC.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BEFORE_DEADLINE);
    const deps = depsWithDeadline(startedWithDeadline({ observation_until: undefined }));

    const result = await professionalCloseObservation(
      { ...BASE_INPUT, outcome: "negative", actor: VET_ACTOR },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("termina el 24 de septiembre de 2026 a las 09:00");
  });
});
