/*
 * One Neon client for the whole app: Neon Auth (sign-in) + Data API (tables).
 * The two URLs come from the Neon Console and are safe to publish: what each
 * signed-in user can read or change is decided by the database's security rules.
 */
import { createClient } from "@neon/neon-js";

// Neon Auth is reached through our own site (/api/auth, forwarded to Neon by
// render.yaml in production and by vite.config.js in development). That makes
// the sign-in cookie first-party, which Safari requires: it blocks cookies set
// by other sites (Neon's auth domain) in the background.
const AUTH_URL = typeof location !== "undefined" ? `${location.origin}/api/auth` : null;
const DATA_API_URL = import.meta.env.VITE_NEON_DATA_API_URL;

let clientPromise;

export function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      // Local end-to-end tests swap in a stand-in for Neon Auth (never in real builds)
      if (import.meta.env.VITE_TEST_MODE === "1") {
        const { createTestClient } = await import("./test-client.js");
        return createTestClient(DATA_API_URL);
      }
      if (!DATA_API_URL) {
        throw new Error("Missing VITE_NEON_DATA_API_URL. See README.");
      }
      return createClient({ auth: { url: AUTH_URL }, dataApi: { url: DATA_API_URL } });
    })();
  }
  return clientPromise;
}

/** The signed-in user, or null. */
export async function currentUser() {
  const client = await getClient();
  const res = await client.auth.getSession();
  const user = res?.data?.user ?? res?.user ?? null;
  return user ? { id: String(user.id), name: user.name || (user.email || "").split("@")[0], email: user.email } : null;
}

/** Turns SDK/database errors into short messages people can act on. */
export function friendlyError(err, fallback = "Something went wrong. Please try again.") {
  if (!err) return null;
  const msg = err.message || err.error_description || String(err);
  if (err.code === "42501" || /row-level security|permission denied/i.test(msg)) {
    return "You don't have permission to do that here.";
  }
  if (/persons_phone_ok/.test(msg)) return "Phone can only contain digits, spaces and + - ( )";
  if (/persons_photo_ok/.test(msg)) return "Photo must be a JPEG, PNG or WebP under 400 KB";
  if (/persons_name_ok|trees_name_ok/.test(msg)) return "Name can't be empty";
  if (/AuthRequired|JWT|not authenticated/i.test(msg)) return "Please log in again.";
  if (/Failed to fetch|NetworkError/i.test(msg)) return "Can't reach the server. Check your connection.";
  return msg || fallback;
}
