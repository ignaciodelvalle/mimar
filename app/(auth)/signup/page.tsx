// Permanent redirect: /signup → /registro. Twin of the /login stub — see that
// file for why it stays permanently and why the query string is preserved.

import { permanentRedirect } from "next/navigation";

export default async function SignupRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === "string") qs.set(key, value);
    else if (Array.isArray(value)) for (const v of value) qs.append(key, v);
  }
  const query = qs.toString();
  permanentRedirect(query ? `/registro?${query}` : "/registro");
}
