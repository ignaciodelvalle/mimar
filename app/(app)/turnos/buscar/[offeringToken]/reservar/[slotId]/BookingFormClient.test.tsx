/**
 * <BookingFormClient> — hydration-gate contract (task-#39 dropped-click class).
 *
 * QA repro: the first "Confirmar reserva" click sometimes silently no-ops.
 * `dispatch` here is a CLIENT closure (no progressive-enhancement POST), so a
 * pre-hydration click has nothing to reach. The fix ships the submit DISABLED
 * in the server HTML and enables it from the mount effect — renderToStaticMarkup
 * runs no effects, so its output IS the pre-hydration HTML the browser paints.
 *
 * Pattern: react-dom/server renderToStaticMarkup (repo convention — no jsdom).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/turnos/buscar/OFF-1/reservar/slot-1",
}));

import { BookingFormClient } from "./BookingFormClient";

const userPets = [{ id: "pet-1", name: "Firulais", species: "dog" }];

describe("<BookingFormClient> — pre-hydration submit affordance", () => {
  it("SSR HTML ships the submit button DISABLED (a pre-hydration click cannot silently no-op)", () => {
    const html = renderToStaticMarkup(<BookingFormClient slotId="slot-1" userPets={userPets} />);
    const button = html.match(/<button\b[^>]*>/)?.[0];
    expect(button).toBeDefined();
    expect(button).toContain("disabled");
  });

  it("still renders the idle label and the pet selector", () => {
    const html = renderToStaticMarkup(<BookingFormClient slotId="slot-1" userPets={userPets} />);
    expect(html).toContain("Confirmar reserva");
    expect(html).toContain("Firulais");
  });
});
