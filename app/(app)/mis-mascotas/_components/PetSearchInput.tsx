"use client";

// PetSearchInput — the name search the /mis-mascotas 200-cap notice always
// promised but never had (owner-ia-redesign P5; inventory §9.3 / §12.9). The
// filtering is server-side (the page reads ?q= and applies a bounded ILIKE);
// this input just debounces the query into the URL so a large-household owner
// can narrow past the cap. Debounced replace() keeps history clean (no entry
// per keystroke) and preserves any other params (e.g. a vet's ?as=owner).

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";

const DEBOUNCE_MS = 300;

export function PetSearchInput({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initialQuery);
  // Skip the first effect run so mounting with an existing ?q= doesn't
  // immediately re-navigate to the same URL.
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      const trimmed = value.trim();
      if (trimmed) {
        params.set("q", trimmed);
      } else {
        params.delete("q");
      }
      const qs = params.toString();
      router.replace(qs ? `/mis-mascotas?${qs}` : "/mis-mascotas", { scroll: false });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, router, searchParams]);

  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-ln-mute)]"
      >
        <Icon name="lupa" size={16} decorative />
      </span>
      <input
        type="search"
        inputMode="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Buscar por nombre"
        aria-label="Buscar mascotas por nombre"
        className="w-full rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] py-2.5 pl-10 pr-3 text-md text-[var(--color-ln-ink)] placeholder:text-[var(--color-ln-mute)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]"
      />
    </div>
  );
}
