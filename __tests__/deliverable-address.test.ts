// `isDeliverableAddress` refuses exactly the reserved, never-deliverable TLDs
// (RFC 2606 / 6761) and malformed input — and never a real mailbox.

import { describe, expect, it } from "vitest";

import { isDeliverableAddress } from "@/lib/infra/deliverable-address";

describe("isDeliverableAddress", () => {
  it.each([
    "admin@dim.test",
    "govt.caba@DIM.TEST",
    "someone@example",
    "someone@mail.example",
    "nobody@foo.invalid",
    "dev@localhost",
    "dev@app.localhost",
    "trailing@dim.test.",
    "doc@example.com",
    "doc@mail.example.org",
  ])("refuses %s", (address) => {
    expect(isDeliverableAddress(address)).toBe(false);
  });

  it.each([
    "vecina@gmail.com",
    "operador@tandil.gob.ar",
    "a.b+tag@mimar.com.ar",
    "user@testing.com",
    "user@test.com.ar",
    "user@myexample.com",
    "user@contest",
    "fixture@dim-test.local",
  ])("keeps the real-shaped mailbox %s", (address) => {
    expect(isDeliverableAddress(address)).toBe(true);
  });

  it.each([null, undefined, "", "   ", "no-at-sign", "@dim.com.ar", "user@"])(
    "refuses malformed input %s",
    (address) => {
      expect(isDeliverableAddress(address)).toBe(false);
    },
  );
});
