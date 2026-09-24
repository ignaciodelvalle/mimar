import { describe, expect, it } from "vitest";

import {
  FEED_EVENT_TYPES,
  type FeedEventType,
  feedDestinationCapability,
  feedDestinationLabel,
  feedQueueHref,
} from "./novedades-feed-links";

// C2 language contract (2026-07-22): the label a Novedades feed row shows
// must match what its destination actually IS. The pre-fix bug hardcoded
// "Ver en su cola →" for every event type even though 4 of 5 route to
// /gob/vigilancia — a MAP ("Mapa de vigilancia"), not a queue. These tests
// assert the label is DERIVED from the destination's declared capability
// class, so a future feed type can never retype a mismatched string.

describe("feedDestinationLabel — derives from capability class, never hardcoded", () => {
  it("map-capability event types say 'Ver en el mapa →', never 'cola'", () => {
    const mapTypes: FeedEventType[] = [
      "outbreak_signal",
      "disease_reported",
      "rabies_observation_started",
      "incident_reported",
    ];
    for (const eventType of mapTypes) {
      expect(feedDestinationCapability(eventType)).toBe("map");
      expect(feedDestinationLabel(eventType)).toBe("Ver en el mapa →");
      expect(feedDestinationLabel(eventType)).not.toMatch(/cola/i);
    }
  });

  it("queue-capability event types say 'Ver en la cola →'", () => {
    expect(feedDestinationCapability("custody_dispute_raised")).toBe("queue");
    expect(feedDestinationLabel("custody_dispute_raised")).toBe("Ver en la cola →");
  });

  it("every declared feed event type has a label consistent with its own capability class", () => {
    for (const eventType of FEED_EVENT_TYPES) {
      const capability = feedDestinationCapability(eventType);
      const label = feedDestinationLabel(eventType);
      if (capability === "queue") expect(label).toContain("cola");
      if (capability === "map") expect(label).toContain("mapa");
    }
  });

  it("the map destination for surveillance event types is /gob/vigilancia", () => {
    expect(feedQueueHref("outbreak_signal")).toBe("/gob/vigilancia");
    expect(feedQueueHref("disease_reported")).toBe("/gob/vigilancia");
    expect(feedQueueHref("rabies_observation_started")).toBe("/gob/vigilancia");
    expect(feedQueueHref("incident_reported")).toBe("/gob/vigilancia");
  });

  it("the queue destination for custody disputes is the Casos hub's Disputas tab (F6 fusion)", () => {
    expect(feedQueueHref("custody_dispute_raised")).toBe("/gob/casos?expediente=disputas");
  });
});
