import { expect, test } from "@playwright/test";

import { ensureCapacityOneSlot, removeCapacityOneSlot } from "./_booking-fixture";
import { isLocalDatabase } from "./demo/_db-cleanup";
import { ACCOUNTS, loginAs } from "./demo/_helpers";

/**
 * Booking the LAST seat of a slot lands on the appointment, not on a 404.
 *
 * bookSlotAction revalidates, so its response re-renders the reservar page, and
 * that page calls notFound() once bookingsCount >= capacity. Capacity defaults
 * to 1, so for an ordinary slot the booking itself is what fills it: until
 * 2026-10-06 the form was unmounted by that 404 render, its effect-based
 * redirect never ran, and the owner was shown "not found" for a booking that
 * had gone through. The navigation now fires inside the action.
 *
 * The URL is the outcome here (the e2e README's exception for a confirmation
 * that IS a route): the appointment page reads the booking from the database,
 * and its h1 is the offering's name — the 404 boundary has neither.
 *
 * The fixture (an approved offering with one capacity-1 slot) is written into a
 * LOCAL Postgres and removed afterwards; on any other target there is no way to
 * make one without an authority approval, so the test skips on that
 * ENVIRONMENT.
 */
test("booking a capacity-1 slot lands on the appointment, not on the full slot's 404", async ({
  page,
}) => {
  test.skip(
    !isLocalDatabase(),
    "NO COVERAGE (non-local database): the capacity-1 slot is written by e2e/_booking-fixture.ts into a local Postgres; a shared one only gets offerings through an authority approval.",
  );
  test.setTimeout(60_000);

  const fixture = await ensureCapacityOneSlot();
  expect(fixture, "the capacity-1 slot fixture").not.toBeNull();
  const { offeringToken, slotId } = fixture as NonNullable<typeof fixture>;

  try {
    await loginAs(page, ACCOUNTS.owner);
    await page.goto(`/turnos/buscar/${offeringToken}/reservar/${slotId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByRole("heading", { level: 1, name: "Confirmar reserva" })).toBeVisible({
      timeout: 20_000,
    });

    const petSelect = page.locator('select[name="petId"]');
    const firstPet = await petSelect
      .locator("option:not([value=''])")
      .first()
      .getAttribute("value");
    expect(firstPet, "owner@dim.test has a pet to book for (seed-test-users.ts)").toBeTruthy();
    await petSelect.selectOption(firstPet as string);

    const confirm = page.getByRole("button", { name: "Confirmar reserva" });
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page).toHaveURL(/\/mis-turnos\/[^/?#]+$/, { timeout: 20_000 });
    await expect(
      page.getByRole("heading", { level: 1, name: "E2E — Turno de cupo 1" }),
    ).toBeVisible();
    await expect(page.getByTestId("branded-not-found")).toHaveCount(0);
  } finally {
    await removeCapacityOneSlot();
  }
});
