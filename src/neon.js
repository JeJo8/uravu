/*
 * One Neon client for the whole app: Neon Auth (sign-in) + Data API (tables).
 * The two URLs come from the Neon Console and are safe to publish: what each
 * signed-in user can read or change is decided by the database's security rules.
 */
import { createClient } from "@neon/neon-js";

// VITE_AUTH_PROXY=1: reach Neon Auth through this site's own /api/auth path, so the
// sign-in cookie is first-party (Safari blocks Neon's cross-site cookie). Needs a host
// that can forward /api/auth/* without adding X-Forwarded-Host, which Neon rejects;
// Render's static-site rewrites add it, so on Render we call Neon Auth directly.
const AUTH_URL = import.meta.env.VITE_AUTH_PROXY === "1" && typeof location !== "undefined"
  ? `${location.origin}/api/auth`
  : import.meta.env.VITE_NEON_AUTH_URL;
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
      if (!AUTH_URL || !DATA_API_URL) {
        throw new Error("Missing VITE_NEON_AUTH_URL / VITE_NEON_DATA_API_URL. See README.");
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
