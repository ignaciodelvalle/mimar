// Unit tests for LnPhoto component helpers.

import {
  type PhotoSize,
  type PhotoStatus,
  getSizePx,
  getStatusBadgeProps,
  getStatusRingClass,
} from "@/lib/infra/photo-helpers";
import { describe, expect, it } from "vitest";

const statuses: PhotoStatus[] = ["ok", "lost", "found", "deceased"];
const sizes: PhotoSize[] = ["sm", "md", "lg", "xl"];

describe("getStatusRingClass", () => {
  it("returns a string for every status", () => {
    for (const status of statuses) {
      const result = getStatusRingClass(status);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it("ok → plain 1px border with ln-line-strong", () => {
    const cls = getStatusRingClass("ok");
    expect(cls).toContain("border");
    expect(cls).toContain("ln-line-strong");
  });

  it("lost → 2px border with ln-seal (danger token)", () => {
    const cls = getStatusRingClass("lost");
    expect(cls).toContain("border-2");
    expect(cls).toContain("ln-seal");
  });

  it("found → 2px border with ln-ok (success token)", () => {
    const cls = getStatusRingClass("found");
    expect(cls).toContain("border-2");
    expect(cls).toContain("ln-ok");
  });

  it("deceased → muted border + grayscale filter", () => {
    const cls = getStatusRingClass("deceased");
    expect(cls).toContain("ln-mute");
    expect(cls).toContain("grayscale");
  });
});

describe("getStatusBadgeProps", () => {
  it("returns null for 'ok' status", () => {
    expect(getStatusBadgeProps("ok")).toBeNull();
  });

  it("lost → danger tone + 'perdida' label", () => {
    const badge = getStatusBadgeProps("lost");
    expect(badge).not.toBeNull();
    expect(badge?.tone).toBe("danger");
    expect(badge?.label).toBe("perdida");
  });

  it("found → success tone + 'encontrada' label", () => {
    const badge = getStatusBadgeProps("found");
    expect(badge).not.toBeNull();
    expect(badge?.tone).toBe("success");
    expect(badge?.label).toBe("encontrada");
  });

  it("deceased → neutral tone + 'en memoria' label", () => {
    const badge = getStatusBadgeProps("deceased");
    expect(badge).not.toBeNull();
    expect(badge?.tone).toBe("neutral");
    expect(badge?.label).toBe("en memoria");
  });

  it("returns a result for every status", () => {
    for (const status of statuses) {
      // Just ensuring no throws — null is valid for "ok"
      expect(() => getStatusBadgeProps(status)).not.toThrow();
    }
  });
});

describe("getSizePx", () => {
  it("returns correct pixel values for each size", () => {
    expect(getSizePx("sm")).toBe(40);
    expect(getSizePx("md")).toBe(56);
    expect(getSizePx("lg")).toBe(80);
    expect(getSizePx("xl")).toBe(120);
  });

  it("returns a positive number for every size", () => {
    for (const size of sizes) {
      const px = getSizePx(size);
      expect(typeof px).toBe("number");
      expect(px).toBeGreaterThan(0);
    }
  });

  it("sizes are ordered ascending sm < md < lg < xl", () => {
    expect(getSizePx("sm")).toBeLessThan(getSizePx("md"));
    expect(getSizePx("md")).toBeLessThan(getSizePx("lg"));
    expect(getSizePx("lg")).toBeLessThan(getSizePx("xl"));
  });
});
