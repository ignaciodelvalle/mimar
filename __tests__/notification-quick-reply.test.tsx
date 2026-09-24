// @vitest-environment jsdom
//
// NotificationQuickReply (capture-console surface #4) — the notification
// inline quick-reply island. Covers:
//   - the mount-gate allowlist (isQuickReplyEligible) — what NotificationCard
//     uses to decide whether to render the island at all.
//   - typing a recognized phrase surfaces the CaptureConfidenceCard preview
//     BEFORE any navigation happens (mandatory-preview contract).
//   - the confirm button ("Asentar <tipo de evento>" — the verb of the act,
//     never "Confirmar"; D.3, 2026-07-30) navigates with reminderId +
//     autoconfirm=1; "Editar en el
//     formulario" navigates with reminderId but WITHOUT autoconfirm.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/notificaciones",
}));

import { NotificationQuickReply } from "@/components/NotificationQuickReply";
import {
  QUICK_REPLY_ALLOWLIST,
  isQuickReplyEligible,
} from "@/components/notification-quick-reply-eligibility";

afterEach(() => {
  cleanup();
  push.mockClear();
  replace.mockClear();
});

describe("isQuickReplyEligible — NotificationCard's mount gate", () => {
  it("allows vaccine_due and post_adoption_checkin_due when a related pet exists", () => {
    expect(isQuickReplyEligible("vaccine_due", "pet-1", true)).toBe(true);
    expect(isQuickReplyEligible("post_adoption_checkin_due", "pet-1", true)).toBe(true);
  });

  it("rejects a type outside the allowlist", () => {
    expect(isQuickReplyEligible("ppp_registration_reminder", "pet-1", true)).toBe(false);
    expect(QUICK_REPLY_ALLOWLIST.has("ppp_registration_reminder")).toBe(false);
  });

  it("rejects when relatedPetId is missing even for an allowlisted type", () => {
    expect(isQuickReplyEligible("vaccine_due", null, true)).toBe(false);
  });

  it("rejects when relatedPet failed to load even if relatedPetId is present", () => {
    expect(isQuickReplyEligible("vaccine_due", "pet-1", false)).toBe(false);
  });
});

describe("<NotificationQuickReply> — preview before commit", () => {
  it("shows no CaptureConfidenceCard before the owner submits any text", () => {
    render(<NotificationQuickReply petPublicToken="DIM-TEST-0001" reminderId="reminder-1" />);
    expect(screen.queryByText("Asentar vacuna administrada")).toBeNull();
  });

  it("typing a recognized phrase and submitting surfaces the preview with Asentar/Editar", () => {
    render(<NotificationQuickReply petPublicToken="DIM-TEST-0001" reminderId="reminder-1" />);

    fireEvent.change(screen.getByLabelText("Respuesta rápida"), {
      target: { value: "le di la antirrábica hoy" },
    });
    fireEvent.click(screen.getByText("Identificar →"));

    expect(screen.getByText("Vacuna administrada")).toBeInTheDocument();
    expect(screen.getByText("Asentar vacuna administrada")).toBeInTheDocument();
    expect(screen.getByText("Editar en el formulario")).toBeInTheDocument();
    // No navigation happened just from showing the preview.
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the unmatched message instead of a preview for unrecognized text", () => {
    render(<NotificationQuickReply petPublicToken="DIM-TEST-0001" reminderId="reminder-1" />);

    fireEvent.change(screen.getByLabelText("Respuesta rápida"), {
      target: { value: "asdkjaslkdj qwer" },
    });
    fireEvent.click(screen.getByText("Identificar →"));

    expect(screen.queryByText("Asentar vacuna administrada")).toBeNull();
    expect(screen.getByText(/No reconocimos eso/)).toBeInTheDocument();
  });

  it("the Asentar button navigates with reminderId + autoconfirm=1", () => {
    render(<NotificationQuickReply petPublicToken="DIM-TEST-0001" reminderId="reminder-1" />);

    fireEvent.change(screen.getByLabelText("Respuesta rápida"), {
      target: { value: "le di la antirrábica hoy" },
    });
    fireEvent.click(screen.getByText("Identificar →"));
    fireEvent.click(screen.getByText("Asentar vacuna administrada"));

    expect(push).toHaveBeenCalledTimes(1);
    const url = push.mock.calls[0][0] as string;
    expect(url).toContain("/mis-mascotas/DIM-TEST-0001/eventos/nuevo/vacuna");
    expect(url).toContain("reminderId=reminder-1");
    expect(url).toContain("autoconfirm=1");
  });

  it("Editar en el formulario navigates with reminderId but WITHOUT autoconfirm", () => {
    render(<NotificationQuickReply petPublicToken="DIM-TEST-0001" reminderId="reminder-1" />);

    fireEvent.change(screen.getByLabelText("Respuesta rápida"), {
      target: { value: "le di la antirrábica hoy" },
    });
    fireEvent.click(screen.getByText("Identificar →"));
    fireEvent.click(screen.getByText("Editar en el formulario"));

    expect(push).toHaveBeenCalledTimes(1);
    const url = push.mock.calls[0][0] as string;
    expect(url).toContain("/mis-mascotas/DIM-TEST-0001/eventos/nuevo/vacuna");
    expect(url).toContain("reminderId=reminder-1");
    expect(url).not.toContain("autoconfirm");
  });

  it("Enter inside the textarea never commits directly — it only re-runs the matcher", () => {
    render(<NotificationQuickReply petPublicToken="DIM-TEST-0001" reminderId="reminder-1" />);

    const textarea = screen.getByLabelText("Respuesta rápida");
    fireEvent.change(textarea, { target: { value: "le di la antirrábica hoy" } });
    // Submitting the identify <form> (Enter's native effect) must never call
    // the router directly — only the explicit Asentar button (rendered
    // inside CaptureConfidenceCard, after the preview) does that.
    fireEvent.submit(textarea.closest("form")!);

    expect(push).not.toHaveBeenCalled();
    expect(screen.getByText("Asentar vacuna administrada")).toBeInTheDocument();
  });
});
