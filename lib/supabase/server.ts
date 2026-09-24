// Supabase client for SERVER-SIDE code only — Server Components, Server Actions,
// Route Handlers. Reads/writes auth cookies via Next's headers API.
//
// Never import this file from a Client Component ("use client"). Client code
// goes through ./client.ts instead.

import { type CookieOptions, createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

type CookieToSet = { name: string; value: string; options: CookieOptions };

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Setting cookies from a Server Component will throw — that's
            // expected. The middleware refreshes the session for us.
          }
        },
      },
    },
  );
}
