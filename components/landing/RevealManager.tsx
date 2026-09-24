"use client";

// Scroll-reveal orchestrator for the public landing — FAIL-OPEN by design
// (ported from the handoff prototype's useReveal, app3.jsx).
//
// Contract:
//  - CSS hides `.lp-reveal` ONLY while the `.lp` root carries `.lp-motion`.
//    No JS, reduced motion, or any failure → the class is never added and
//    everything renders visible.
//  - Before enabling motion, everything already in the viewport is marked
//    `.in` in the same frame, so nothing visible ever blinks out.
//  - If the IntersectionObserver hasn't fired within ~1.4s, reveal ALL.

import { useEffect } from "react";

const FAIL_OPEN_MS = 1400;

export function RevealManager() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-landing-root]");
    if (!root) return;
    if (typeof window.matchMedia !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!("IntersectionObserver" in window)) return;

    const els = Array.from(root.querySelectorAll<HTMLElement>(".lp-reveal"));
    const revealAll = () => {
      for (const el of els) el.classList.add("in");
    };

    // Mark in-viewport elements BEFORE hiding anything (fail-open rule 1).
    const vh = window.innerHeight || 800;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.top < vh && r.bottom > 0) el.classList.add("in");
    }
    root.classList.add("lp-motion");

    let fired = false;
    const io = new IntersectionObserver(
      (entries) => {
        fired = true;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    for (const el of els) {
      if (!el.classList.contains("in")) io.observe(el);
    }

    // Fail-open rule 2: observer never fired → show everything.
    const t = setTimeout(() => {
      if (!fired) {
        revealAll();
        io.disconnect();
      }
    }, FAIL_OPEN_MS);

    return () => {
      clearTimeout(t);
      io.disconnect();
    };
  }, []);

  return null;
}
