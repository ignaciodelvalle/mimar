// @vitest-environment jsdom
//
// "Ver mis datos" readable summary (PO decision 13A) — pins that the web
// privacy page shows a human Spanish label per section instead of the raw
// developer key the export function returns, on a fixture shaped like the
// real thing: a hidden watermark, a kept-but-relabeled technical section, and
// an unrecognised key that must still show, generically labeled. Mirrors
// `apps/mobile/src/account/PrivacyScreen.test.tsx`'s equivalent case.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const exportMySubjectDataAction = vi.fn();
const eraseMySubjectDataAction = vi.fn();
vi.mock("@/app/actions/subject-rights", () => ({
  exportMySubjectDataAction: (...args: unknown[]) => exportMySubjectDataAction(...args),
  eraseMySubjectDataAction: (...args: unknown[]) => eraseMySubjectDataAction(...args),
}));

vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: vi.fn(),
}));

// jsdom has no real object-URL / anchor-download plumbing; the download side
// effect is not what this test is about, so it is stubbed out rather than
// exercised.
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

import { PrivacyActions } from "./PrivacyActions";

const SHAPED_EXPORT = {
  pets: [{}],
  push_targets: [{ device_id: "abc" }],
  audit_log: [{ action: "subject_data_exported" }],
  operator_feed_watermarks: [{ surface: "novedades" }],
  subject_user_id: "11111111-1111-1111-1111-111111111111",
  schema_version: 5,
  una_tabla_que_no_existia: [{}],
};

beforeEach(() => {
  exportMySubjectDataAction.mockReset();
  eraseMySubjectDataAction.mockReset();
});

afterEach(() => {
  cleanup();
});

it("never shows a raw developer key, on a fixture shaped like the real export", async () => {
  exportMySubjectDataAction.mockResolvedValue({ ok: true, data: SHAPED_EXPORT });
  render(<PrivacyActions />);

  fireEvent.click(screen.getByRole("button", { name: "Descargar JSON" }));

  await waitFor(() => {
    expect(screen.getByText("Tus mascotas")).toBeInTheDocument();
    expect(screen.getByText("Avisos activados (celular)")).toBeInTheDocument();
    expect(screen.getByText("Historial de tus acciones")).toBeInTheDocument();
    expect(screen.getByText("Otros datos")).toBeInTheDocument();
  });

  // Pure bookkeeping: hidden even though it has content.
  expect(screen.queryByText(/watermark/i)).not.toBeInTheDocument();
  // No raw snake_case key, and no lightly-unshouted version of one.
  for (const rawLeak of [
    "operator_feed_watermarks",
    "Operator feed watermarks",
    "push_targets",
    "Push targets",
    "audit_log",
    "Audit log",
    "subject_user_id",
    "Subject user id",
    "schema_version",
    "una_tabla_que_no_existia",
  ]) {
    expect(screen.queryByText(rawLeak)).not.toBeInTheDocument();
  }
});

it("shows nothing extra when the export fails", async () => {
  exportMySubjectDataAction.mockResolvedValue({ ok: false, error: "No pudimos pedir tus datos." });
  render(<PrivacyActions />);

  fireEvent.click(screen.getByRole("button", { name: "Descargar JSON" }));

  await waitFor(() => {
    expect(screen.getByText("No pudimos pedir tus datos.")).toBeInTheDocument();
  });
  expect(screen.queryByText("Un resumen de lo que guardamos sobre vos")).not.toBeInTheDocument();
});
