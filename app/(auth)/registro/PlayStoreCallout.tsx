import { isAndroidUserAgent, resolvePlayStoreUrl } from "@/lib/ui/play-store";
import googlePlayBadge from "@/public/landing/google-play-badge-es419.png";
import { headers } from "next/headers";
import Image from "next/image";

// "Lo vas a usar en el celular?" — the Android app offered ABOVE the signup
// form (PO 2026-10-02).
//
// GATED ON THE LISTING. The app is approved on Play but not published, so
// until NEXT_PUBLIC_PLAY_STORE_URL resolves (lib/ui/play-store.ts) this renders
// NOTHING: no title, no badge, no mention of an app. The day the PO sets the
// variable the block appears with no code change (the variable is inlined at build time, so setting it needs a redeploy). Same doctrine as the landing
// hero, which shows the badge as an inert image rather than a dead link.
//
// ANDROID vs EVERYTHING ELSE. The only thing the User-Agent decides is how
// loud the offer is: a card with a large badge on an Android phone (the visitor
// who can install it right now), a compact muted row on desktop and iOS. It is
// decided on the server from the request header — no client JS, no hydration
// flash, no CSS media-query guess (a narrow desktop window is not a phone, and
// an iPhone is narrow too). The page is already dynamic (it reads the session
// cookie), so reading headers() costs it nothing.
//
// The badge is Google's own unaltered PNG, sized by height only so its aspect
// ratio and clear space are never distorted (same asset and rule as
// components/landing/LandingHero.tsx).

const TITLE = "¿Lo vas a usar en el celular?";
const LINE = "Bajá la app de miMAR para Android.";

export function PlayStoreCalloutView({
  href,
  android,
}: {
  href: string;
  android: boolean;
}) {
  const badge = (
    <a
      href={href}
      className={`block w-fit shrink-0 rounded-[var(--radius-sm)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ln-azul)]${android ? " mx-auto" : ""}`}
      data-testid="play-store-link"
    >
      <Image
        src={googlePlayBadge}
        alt="Disponible en Google Play"
        width={646}
        height={250}
        className={android ? "h-14 w-auto" : "h-10 w-auto"}
      />
    </a>
  );

  if (android) {
    return (
      <section
        aria-labelledby="play-store-callout-title"
        data-variant="android"
        className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-azul)] bg-[var(--color-ln-paper-2)] px-4 py-4 text-center"
      >
        <h2
          id="play-store-callout-title"
          className="font-ln-serif text-lg font-semibold text-[var(--color-ln-ink)]"
        >
          {TITLE}
        </h2>
        <p className="text-sm text-[var(--color-ln-ink-2)]">{LINE}</p>
        {badge}
      </section>
    );
  }

  return (
    <section
      aria-labelledby="play-store-callout-title"
      data-variant="compact"
      className="flex items-center justify-between gap-4 border-y border-[var(--color-ln-line)] py-3"
    >
      <div className="min-w-0">
        <h2
          id="play-store-callout-title"
          className="text-sm font-medium text-[var(--color-ln-ink)]"
        >
          {TITLE}
        </h2>
        <p className="text-xs text-[var(--color-ln-ink-2)]">{LINE}</p>
      </div>
      {badge}
    </section>
  );
}

export async function PlayStoreCallout() {
  // Literal access, so Next inlines the value at build time as it does for
  // every NEXT_PUBLIC_ variable (the whole `process.env` object is not inlined).
  const href = resolvePlayStoreUrl({
    NEXT_PUBLIC_PLAY_STORE_URL: process.env.NEXT_PUBLIC_PLAY_STORE_URL,
  });
  if (href === null) return null;
  const android = isAndroidUserAgent((await headers()).get("user-agent"));
  return <PlayStoreCalloutView href={href} android={android} />;
}
