// Unit tests for lib/surveillance-eyebrow.ts — C19 eyebrow helper.

import { describe, expect, it } from "vitest";

import { surveillanceEyebrow } from "@/lib/ui/surveillance-eyebrow";

describe("surveillanceEyebrow", () => {
  it("returns Admin label for admin role", () => {
    expect(surveillanceEyebrow("admin")).toBe("Admin · Vigilancia");
  });

  it("returns Gobierno label for govt role", () => {
    expect(surveillanceEyebrow("govt")).toBe("Gobierno · Vigilancia");
  });
});
