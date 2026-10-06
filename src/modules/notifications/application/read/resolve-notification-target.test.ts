// resolveNotificationTarget — one test per outcome, over fake probes.
//
// The DB-backed matrix (`__tests__/notification-target-matrix.test.ts`) proves
// the real access functions agree with these answers; this file pins the RULE:
// the fallback order, which refusal explains itself how, and that no outcome is
// ever a destination the probes refused.

import { describe, expect, it } from "vitest";

import {
  type CaseFacts,
  type NotificationTargetProbes,
  type NotificationTargetRow,
  appRouteForWebPath,
  readStoredCta,
  resolveNotificationTarget,
} from "./resolve-notification-target";

const OWNER = { userId: "u-1", role: "owner" as const };

function row(over: Partial<NotificationTargetRow>): NotificationTargetRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    notificationType: "pet_sighting",
    title: "Avistaje",
    body: "Alguien vio a Pampa.",
    ctaLabel: null,
    ctaUrl: null,
    relatedPetId: null,
    relatedCaseId: null,
    ...over,
  };
}

function caseFacts(over: Partial<CaseFacts> = {}): CaseFacts {
  return {
    publicCode: "CAS-AAAA-BBBB",
    caseKind: "custody_transfer_handshake",
    status: "open",
    closedReason: null,
    jurisdictionLocality: "Rosario",
    petId: "pet-1",
    petName: "Pampa",
    openedByOrganization: { id: "org-sender", displayName: "Refugio Norte" },
    receiverOrganization: { id: "org-receiver", displayName: "Refugio Sur" },
    ...over,
  };
}

type FakeWorld = {
  cases?: CaseFacts[];
  readableCases?: string[];
  pets?: { id: string; publicToken: string; name: string }[];
  heldPets?: string[];
  formerOwnerPets?: string[];
  nonTitularRole?: Record<string, string>;
  orgs?: Record<string, { id: string; displayName: string }>;
  memberOf?: string[];
  leftOrgs?: string[];
  /** "orgId:capability" pairs the viewer holds. */
  capabilities?: string[];
};

function probes(world: FakeWorld): NotificationTargetProbes {
  return {
    async findCase({ caseId, publicCode }) {
      return (
        (world.cases ?? []).find(
          (c) =>
            c.publicCode === publicCode || (caseId !== null && caseId === `id-${c.publicCode}`),
        ) ?? null
      );
    },
    async canReadCase(code) {
      return (world.readableCases ?? []).includes(code);
    },
    async findPet({ petId, publicToken }) {
      return (
        (world.pets ?? []).find((p) => p.publicToken === publicToken || p.id === petId) ?? null
      );
    },
    async holdsPet(token) {
      return (world.heldPets ?? []).includes(token);
    },
    async formerOwnerRead(token) {
      return (world.formerOwnerPets ?? []).includes(token);
    },
    async liveNonTitularRole(petId) {
      return world.nonTitularRole?.[petId] ?? null;
    },
    async findOrgByToken(token) {
      return world.orgs?.[token] ?? null;
    },
    async isActiveOrgMember(orgId) {
      return (world.memberOf ?? []).includes(orgId);
    },
    async hasOrgCapability(orgId, capability) {
      return (world.capabilities ?? []).includes(`${orgId}:${capability}`);
    },
    async hadEndedMembership(orgId) {
      return (world.leftOrgs ?? []).includes(orgId);
    },
  };
}

const PAMPA = { id: "pet-1", publicToken: "DIM-PAMP-0001", name: "Pampa" };

describe("readStoredCta", () => {
  it("reads a case, a pet page, a section and an external link apart", () => {
    expect(readStoredCta("/casos/CAS-AAAA-BBBB")).toEqual({
      kind: "case",
      publicCode: "CAS-AAAA-BBBB",
      path: "/casos/CAS-AAAA-BBBB",
    });
    expect(readStoredCta("/mis-mascotas/DIM-PAMP-0001/devolucion")).toMatchObject({
      kind: "pet",
      publicToken: "DIM-PAMP-0001",
    });
    expect(readStoredCta("/mis-mascotas/postulaciones")).toEqual({
      kind: "section",
      path: "/mis-mascotas/postulaciones",
    });
    expect(readStoredCta("https://www.argentina.gob.ar/x")).toEqual({
      kind: "external",
      url: "https://www.argentina.gob.ar/x",
    });
    expect(readStoredCta(null)).toBe(null);
  });

  it("maps a web path to the app's screen, or null when there is none", () => {
    expect(appRouteForWebPath("/mis-mascotas/DIM-PAMP-0001")).toBe("/mascotas/DIM-PAMP-0001");
    expect(appRouteForWebPath("/casos/CAS-AAAA-BBBB")).toBe("/casos/CAS-AAAA-BBBB");
    expect(appRouteForWebPath("/org/ORG-1/voluntarios/propuestas")).toBe(null);
  });
});

describe("resolveNotificationTarget — outcomes", () => {
  it("case: opens the case when the viewer can read it", async () => {
    const target = await resolveNotificationTarget(
      row({
        notificationType: "cross_org_transfer_proposed_receiver",
        ctaUrl: "/casos/CAS-AAAA-BBBB",
      }),
      OWNER,
      probes({
        cases: [caseFacts()],
        readableCases: ["CAS-AAAA-BBBB"],
        memberOf: ["org-receiver"],
      }),
    );
    expect(target).toMatchObject({
      outcome: "case",
      webHref: "/casos/CAS-AAAA-BBBB",
      appRoute: "/casos/CAS-AAAA-BBBB",
      webOnly: false,
      reason: "destination",
    });
    expect(target.actorCopy).toBe("Te toca a vos: aceptá o rechazá el traspaso.");
  });

  it("case: names the counterparty org while the sender waits", async () => {
    const target = await resolveNotificationTarget(
      row({
        notificationType: "cross_org_transfer_proposed_sender",
        ctaUrl: "/casos/CAS-AAAA-BBBB",
      }),
      OWNER,
      probes({ cases: [caseFacts()], readableCases: ["CAS-AAAA-BBBB"], memberOf: ["org-sender"] }),
    );
    expect(target.actorCopy).toBe(
      "Falta que Refugio Sur acepte el traspaso. No tenés que hacer nada por ahora.",
    );
  });

  it("case: a closed case says it is resolved instead of who must act", async () => {
    const target = await resolveNotificationTarget(
      row({
        notificationType: "cross_org_transfer_proposed_receiver",
        ctaUrl: "/casos/CAS-AAAA-BBBB",
      }),
      OWNER,
      probes({
        cases: [caseFacts({ status: "closed", closedReason: "resolved" })],
        readableCases: ["CAS-AAAA-BBBB"],
      }),
    );
    expect(target.outcome).toBe("case");
    expect(target.actorCopy).toBe("Esto ya se resolvió: el caso está resuelto.");
  });

  it("pet: opens the writer's own pet page for a holder", async () => {
    const target = await resolveNotificationTarget(
      row({
        notificationType: "chip_match_notification_owner",
        ctaUrl: "/mis-mascotas/DIM-PAMP-0001/devolucion",
      }),
      OWNER,
      probes({ pets: [PAMPA], heldPets: ["DIM-PAMP-0001"] }),
    );
    expect(target).toMatchObject({
      outcome: "pet",
      webHref: "/mis-mascotas/DIM-PAMP-0001/devolucion",
      appRoute: "/mascotas/DIM-PAMP-0001/devolucion",
    });
  });

  it("pet: with no stored link, the registry's pet face opens", async () => {
    const target = await resolveNotificationTarget(
      row({ notificationType: "ppp_registration_reminder", relatedPetId: "pet-1" }),
      OWNER,
      probes({ pets: [PAMPA], heldPets: ["DIM-PAMP-0001"] }),
    );
    expect(target.webHref).toBe("/mis-mascotas/DIM-PAMP-0001/eventos/atestar-raza-peligrosa");
    expect(target.appRoute).toBe(
      "/mascotas/DIM-PAMP-0001/asentar?kind=dangerous_breed_attestation",
    );
  });

  it("pet: a former owner during an open custody episode lands on the read-only view", async () => {
    const target = await resolveNotificationTarget(
      row({
        notificationType: "decomiso_owner_lost_custody",
        ctaUrl: "/mis-mascotas/DIM-PAMP-0001",
      }),
      OWNER,
      probes({ pets: [PAMPA], formerOwnerPets: ["DIM-PAMP-0001"] }),
    );
    expect(target).toMatchObject({ outcome: "pet", webHref: "/mis-mascotas/DIM-PAMP-0001" });
    expect(target.actorCopy).toMatch(/^Lo decide la autoridad de/);
  });

  it("case → pet: an unreadable case falls back to the pet the viewer holds", async () => {
    const target = await resolveNotificationTarget(
      row({
        notificationType: "decomiso_handoff_accepted_receiver",
        ctaUrl: "/casos/CAS-AAAA-BBBB",
      }),
      OWNER,
      probes({
        cases: [caseFacts({ caseKind: "custody_episode" })],
        pets: [PAMPA],
        heldPets: ["DIM-PAMP-0001"],
      }),
    );
    expect(target.outcome).toBe("pet");
  });

  it("section: opens an org page for an active member", async () => {
    const target = await resolveNotificationTarget(
      row({
        notificationType: "foster_proposal_accepted_org",
        ctaUrl: "/org/ORG-1/voluntarios/propuestas",
      }),
      OWNER,
      probes({ orgs: { "ORG-1": { id: "org-1", displayName: "Refugio" } }, memberOf: ["org-1"] }),
    );
    expect(target).toMatchObject({
      outcome: "section",
      webHref: "/org/ORG-1/voluntarios/propuestas",
      webOnly: true,
      reason: "web_only",
      appRoute: "/aviso/11111111-1111-4111-8111-111111111111",
    });
  });

  it("section: the app's own screen when there is one", async () => {
    const target = await resolveNotificationTarget(
      row({ notificationType: "foster_proposal_expired", ctaUrl: "/cuenta/transitos/propuestas" }),
      OWNER,
      probes({}),
    );
    expect(target).toMatchObject({
      outcome: "section",
      appRoute: "/cuenta/transito",
      webOnly: false,
    });
  });
});

describe("resolveNotificationTarget — the explanation state", () => {
  it("explains a pet the viewer no longer holds, with what happened", async () => {
    const target = await resolveNotificationTarget(
      row({
        notificationType: "pet_transfer_accepted",
        ctaUrl: "/mis-mascotas",
        relatedPetId: "pet-1",
        body: "Juan aceptó la transferencia de Pampa.",
      }),
      OWNER,
      probes({ pets: [PAMPA] }),
    );
    expect(target).toMatchObject({
      outcome: "explain",
      reason: "pet_no_longer_held",
      webHref: "/notificaciones/11111111-1111-4111-8111-111111111111",
      appRoute: "/aviso/11111111-1111-4111-8111-111111111111",
    });
    expect(target.reasonCopy).toBe(
      "Ya no tenés a Pampa a cargo, por eso no podemos mostrarte su ficha. Esto fue lo que pasó: Juan aceptó la transferencia de Pampa.",
    );
  });

  // PO 2026-10-06: the org that filed a welfare denuncia reads it (canReadCase
  // admits its coordinators). Once readable, it is an ordinary case outcome
  // with the authority as the pending actor.
  it("opens the welfare denuncia to the org that filed it", async () => {
    const target = await resolveNotificationTarget(
      row({
        notificationType: "welfare_org_side_confirmed_reporter",
        ctaUrl: "/casos/CAS-AAAA-BBBB",
      }),
      OWNER,
      probes({
        cases: [caseFacts({ caseKind: "welfare_denuncia", receiverOrganization: null })],
        readableCases: ["CAS-AAAA-BBBB"],
        memberOf: ["org-sender"],
      }),
    );
    expect(target).toMatchObject({ outcome: "case", webHref: "/casos/CAS-AAAA-BBBB" });
    expect(target.actorCopy).toBe(
      "Lo decide la autoridad de Rosario. Te avisamos cuando haya novedades.",
    );
  });

  it("refuses it to anyone else as an ordinary refusal, never as 'reserved'", async () => {
    const target = await resolveNotificationTarget(
      row({
        notificationType: "welfare_org_side_confirmed_reporter",
        ctaUrl: "/casos/CAS-AAAA-BBBB",
      }),
      OWNER,
      probes({
        cases: [caseFacts({ caseKind: "welfare_denuncia", receiverOrganization: null })],
        memberOf: ["org-sender"],
      }),
    );
    expect(target).toMatchObject({
      outcome: "explain",
      reason: "case_not_available",
      actorCopy: null,
    });
  });

  it("explains a titular-only case to a co-owner instead of falling to the pet", async () => {
    const target = await resolveNotificationTarget(
      row({
        notificationType: "custody_dispute_raised_against_you",
        ctaUrl: "/casos/CAS-AAAA-BBBB",
      }),
      OWNER,
      probes({
        cases: [caseFacts({ caseKind: "custody_dispute" })],
        pets: [PAMPA],
        heldPets: ["DIM-PAMP-0001"],
        nonTitularRole: { "pet-1": "co_owner" },
      }),
    );
    expect(target).toMatchObject({ outcome: "explain", reason: "case_titular_only" });
  });

  it("explains an ended membership", async () => {
    const target = await resolveNotificationTarget(
      row({
        notificationType: "cross_org_transfer_cancelled_receiver",
        ctaUrl: "/org/ORG-1/transferencias/recibidas",
      }),
      OWNER,
      probes({
        orgs: { "ORG-1": { id: "org-1", displayName: "Refugio Sur" } },
        leftOrgs: ["org-1"],
      }),
    );
    expect(target).toMatchObject({ outcome: "explain", reason: "membership_ended" });
    expect(target.reasonCopy).toBe(
      "Ya no formás parte de Refugio Sur, por eso no podemos mostrarte esto.",
    );
  });

  it("explains a case nobody grants the viewer", async () => {
    const target = await resolveNotificationTarget(
      row({
        notificationType: "decomiso_handoff_proposed_receiver",
        ctaUrl: "/casos/CAS-AAAA-BBBB",
      }),
      OWNER,
      probes({ cases: [caseFacts({ caseKind: "custody_episode" })] }),
    );
    expect(target).toMatchObject({ outcome: "explain", reason: "case_not_available" });
  });

  it("an informational kind explains itself and opens nothing", async () => {
    const target = await resolveNotificationTarget(
      row({ notificationType: "pet_transfer_cancelled", relatedPetId: "pet-1" }),
      OWNER,
      probes({ pets: [PAMPA], heldPets: ["DIM-PAMP-0001"] }),
    );
    expect(target).toMatchObject({ outcome: "explain", reason: "informational" });
    expect(target.reasonCopy).toMatch(/canceló la transferencia/);
  });

  it("an unknown stored type with no link still lands on the explanation", async () => {
    const target = await resolveNotificationTarget(
      row({ notificationType: "retired_kind_from_2025", ctaUrl: null }),
      OWNER,
      probes({}),
    );
    expect(target).toMatchObject({ outcome: "explain", reason: "informational" });
  });

  it("refuses /admin and /gob sections to an owner", async () => {
    const target = await resolveNotificationTarget(
      row({ notificationType: "outbreak_signal_detected", ctaUrl: "/gob/cola" }),
      OWNER,
      probes({}),
    );
    expect(target.outcome).toBe("explain");
    const govt = await resolveNotificationTarget(
      row({ notificationType: "outbreak_signal_detected", ctaUrl: "/gob/cola" }),
      { userId: "g-1", role: "govt" },
      probes({}),
    );
    expect(govt).toMatchObject({ outcome: "section", webHref: "/gob/cola", webOnly: true });
  });
});

// ---------------------------------------------------------------------------
// Review fixes (security S1/S3, code review R4/R5/R9/R11), 2026-10
// ---------------------------------------------------------------------------

describe("resolveNotificationTarget — never off-origin (S1)", () => {
  it.each(["/\t/evil.com", "/\\evil.com", "//evil.com", "/\u0000/evil.com"])(
    "refuses %j as a destination",
    async (cta) => {
      expect(readStoredCta(cta)).toEqual({ kind: "invalid" });
      const target = await resolveNotificationTarget(
        row({ notificationType: "tag_activated", ctaUrl: cta }),
        OWNER,
        probes({}),
      );
      expect(target.outcome).toBe("explain");
      expect(target.webHref).toBe("/notificaciones/11111111-1111-4111-8111-111111111111");
    },
  );

  it("treats https://evil.com as an external link, never as a redirect target", async () => {
    const target = await resolveNotificationTarget(
      row({ notificationType: "tag_activated", ctaUrl: "https://evil.com", ctaLabel: "Ver" }),
      OWNER,
      probes({}),
    );
    expect(target).toMatchObject({
      outcome: "external",
      externalUrl: "https://evil.com",
      webHref: "/notificaciones/11111111-1111-4111-8111-111111111111",
      appRoute: "/aviso/11111111-1111-4111-8111-111111111111",
    });
  });
});

describe("resolveNotificationTarget — external links (R5)", () => {
  it("keeps the ministry's information page and its label", async () => {
    const url = "https://www.argentina.gob.ar/salud/glosario/rabia";
    const target = await resolveNotificationTarget(
      row({
        notificationType: "disease_public_alert",
        ctaUrl: url,
        ctaLabel: "Información oficial — Min. Salud",
        relatedPetId: "pet-1",
      }),
      OWNER,
      probes({ pets: [PAMPA], heldPets: ["DIM-PAMP-0001"] }),
    );
    expect(target).toMatchObject({
      outcome: "external",
      externalUrl: url,
      externalLabel: "Información oficial — Min. Salud",
      reason: "external",
    });
  });

  it("keeps the PPP 'Más info' link the registration writes", async () => {
    const url = "https://www.argentina.gob.ar/justicia/derechofacil/leysimple/maltrato-animales";
    const target = await resolveNotificationTarget(
      row({ notificationType: "ppp_registration_reminder", ctaUrl: url, ctaLabel: "Más info" }),
      OWNER,
      probes({}),
    );
    expect(target).toMatchObject({
      outcome: "external",
      externalUrl: url,
      externalLabel: "Más info",
    });
  });
});

describe("resolveNotificationTarget — sections are known or explained (R9)", () => {
  it("reads a trailing slash on a case link as the case", async () => {
    expect(readStoredCta("/casos/CAS-AAAA-BBBB/")).toMatchObject({
      kind: "case",
      publicCode: "CAS-AAAA-BBBB",
    });
  });

  it("explains an /org subpage nobody declared instead of opening it", async () => {
    const target = await resolveNotificationTarget(
      row({ notificationType: "org_contact_message", ctaUrl: "/org/ORG-1/pagina-renombrada" }),
      OWNER,
      probes({ orgs: { "ORG-1": { id: "org-1", displayName: "Refugio" } }, memberOf: ["org-1"] }),
    );
    expect(target.outcome).toBe("explain");
  });

  it("requires the capability a hard-gated org page needs", async () => {
    const world = {
      orgs: { "ORG-1": { id: "org-1", displayName: "Refugio" } },
      memberOf: ["org-1"],
    };
    const cta = "/org/ORG-1/admin/permisos";
    const without = await resolveNotificationTarget(
      row({ notificationType: "capability_request", ctaUrl: cta }),
      OWNER,
      probes(world),
    );
    expect(without.outcome).toBe("explain");
    const withCap = await resolveNotificationTarget(
      row({ notificationType: "capability_request", ctaUrl: cta }),
      OWNER,
      probes({ ...world, capabilities: ["org-1:capability.grant"] }),
    );
    expect(withCap.outcome).toBe("section");
  });
});

describe("resolveNotificationTarget — a refused case lends nothing (S3, R4)", () => {
  it("never prints a refused case's state, and names nobody to act", async () => {
    const target = await resolveNotificationTarget(
      row({
        notificationType: "cross_org_transfer_proposed_receiver",
        ctaUrl: "/casos/CAS-AAAA-BBBB",
      }),
      OWNER,
      probes({ cases: [caseFacts({ status: "closed", closedReason: "resolved" })] }),
    );
    expect(target).toMatchObject({ outcome: "explain", reason: "case_not_available" });
    expect(target.actorCopy).toBeNull();
  });
});

describe("resolveNotificationTarget — an erased row (R11)", () => {
  it("opens nothing and says why", async () => {
    const target = await resolveNotificationTarget(
      row({ title: "[eliminado]", ctaUrl: null, relatedPetId: "pet-1" }),
      OWNER,
      probes({ pets: [PAMPA], heldPets: ["DIM-PAMP-0001"] }),
    );
    expect(target).toMatchObject({ outcome: "explain", reason: "erased", actorCopy: null });
  });
});

describe("readStoredCta — a malformed percent-encoding (final review)", () => {
  it("reads a stray % as invalid instead of throwing, and the row explains", async () => {
    expect(readStoredCta("/casos/50%")).toEqual({ kind: "invalid" });
    expect(readStoredCta("/mis-mascotas/DIM-%ZZ")).toEqual({ kind: "invalid" });
    const target = await resolveNotificationTarget(
      row({ notificationType: "custody_dispute_resolved", ctaUrl: "/casos/50%" }),
      OWNER,
      probes({}),
    );
    expect(target.outcome).toBe("explain");
  });
});
