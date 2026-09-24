// Pure-function tests for lib/ui/notification-quick-reply-nav.ts — the URL
// builder behind the notification quick-reply island (components/
// NotificationQuickReply.tsx, capture-console surface #4).

import { describe, expect, it } from "vitest";

import { matchCaptureIntent } from "@/lib/events/event-capture-matcher";
import { buildQuickReplyUrl } from "@/lib/ui/notification-quick-reply-nav";

describe("buildQuickReplyUrl", () => {
  it("resolves a vaccine phrase to the vaccine form with reminderId + autoconfirm", () => {
    const match = matchCaptureIntent("le di la antirrábica hoy");
    expect(match).not.toBeNull();
    const url = buildQuickReplyUrl("DIM-TEST-0001", match!, "reminder-1", true);
    expect(url).not.toBeNull();
    expect(url).toContain("/mis-mascotas/DIM-TEST-0001/eventos/nuevo/vacuna");
    expect(url).toContain("reminderId=reminder-1");
    expect(url).toContain("autoconfirm=1");
    expect(url).toContain("vaccineName=");
  });

  it("omits autoconfirm on the edit path (same URL minus the flag)", () => {
    const match = matchCaptureIntent("le di la antirrábica hoy");
    const url = buildQuickReplyUrl("DIM-TEST-0001", match!, "reminder-1", false);
    expect(url).toContain("reminderId=reminder-1");
    expect(url).not.toContain("autoconfirm");
  });

  it("omits reminderId when the notification has none", () => {
    const match = matchCaptureIntent("le di la antirrábica hoy");
    const url = buildQuickReplyUrl("DIM-TEST-0001", match!, null, true);
    expect(url).not.toContain("reminderId");
    expect(url).toContain("autoconfirm=1");
  });

  it("resolves a checkin phrase to the checkin form", () => {
    const match = matchCaptureIntent("ya hice el check-in");
    expect(match).not.toBeNull();
    expect(match?.eventType).toBe("post_adoption_checkin");
    const url = buildQuickReplyUrl("DIM-TEST-0001", match!, "reminder-2", true);
    expect(url).toContain("/mis-mascotas/DIM-TEST-0001/eventos/nuevo/checkin");
    expect(url).toContain("reminderId=reminder-2");
    expect(url).toContain("autoconfirm=1");
  });

  it("returns null when the matcher itself found nothing (no URL to build)", () => {
    const match = matchCaptureIntent("asdkjaslkdj qwer");
    expect(match).toBeNull();
  });
});
