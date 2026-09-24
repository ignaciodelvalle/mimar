// Pure unit tests for the notification ↔ state reconcile rule.
// No DB — exercises the predicate contract directly.

import { describe, expect, it } from "vitest";

import {
  LOST_ACTIVE_NOTIFICATION_TYPES,
  isResolvedLostEpisodeNotification,
  isStaleWelcomeNotification,
} from "@/lib/infra/notification-reconcile";

describe("isResolvedLostEpisodeNotification", () => {
  it("suppresses a sighting alert once the pet is no longer lost (found → active)", () => {
    expect(
      isResolvedLostEpisodeNotification({
        notificationType: "pet_found_report",
        petStatus: "active",
      }),
    ).toBe(true);
  });

  it("suppresses lost-active alerts when the pet is deceased", () => {
    for (const notificationType of LOST_ACTIVE_NOTIFICATION_TYPES) {
      expect(isResolvedLostEpisodeNotification({ notificationType, petStatus: "deceased" })).toBe(
        true,
      );
    }
  });

  it("keeps a lost-active alert while the pet is still lost", () => {
    for (const notificationType of LOST_ACTIVE_NOTIFICATION_TYPES) {
      expect(isResolvedLostEpisodeNotification({ notificationType, petStatus: "lost" })).toBe(
        false,
      );
    }
  });

  it("never reconciles a recovery notice away (good-news must persist)", () => {
    expect(
      isResolvedLostEpisodeNotification({
        notificationType: "lost_episode_resolved_owner",
        petStatus: "active",
      }),
    ).toBe(false);
    expect(
      isResolvedLostEpisodeNotification({
        notificationType: "lost_episode_resolved_broadcast",
        petStatus: "active",
      }),
    ).toBe(false);
  });

  it("keeps a non-lost notification type regardless of pet status", () => {
    expect(
      isResolvedLostEpisodeNotification({
        notificationType: "vaccine_due",
        petStatus: "active",
      }),
    ).toBe(false);
  });

  it("keeps a lost-active row that has no related pet to reconcile against", () => {
    expect(
      isResolvedLostEpisodeNotification({
        notificationType: "pet_found_report",
        petStatus: null,
      }),
    ).toBe(false);
  });
});

// Tester fix #8: the welcome notification's "Registrá tu primera mascota" CTA
// is moot once the user owns a pet — reconciled at read time, no migration.
describe("isStaleWelcomeNotification", () => {
  it("hides the welcome once the user actively owns a pet", () => {
    expect(
      isStaleWelcomeNotification({ notificationType: "welcome", activeOwnedPetCount: 1 }),
    ).toBe(true);
    expect(
      isStaleWelcomeNotification({ notificationType: "welcome", activeOwnedPetCount: 3 }),
    ).toBe(true);
  });

  it("keeps the welcome while the user owns no pet", () => {
    expect(
      isStaleWelcomeNotification({ notificationType: "welcome", activeOwnedPetCount: 0 }),
    ).toBe(false);
  });

  it("never touches other notification types", () => {
    expect(
      isStaleWelcomeNotification({ notificationType: "vaccine_due", activeOwnedPetCount: 5 }),
    ).toBe(false);
  });
});
