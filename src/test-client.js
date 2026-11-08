/*
 * ONLY for local end-to-end tests (VITE_TEST_MODE=1). Never bundled in real builds.
 * Imitates Neon Auth: "signs in" by remembering a user in localStorage and
 * signing a JWT with the local PostgREST test secret, so the real database
 * security rules are exercised exactly as on Neon.
 */
import { createClient } from "@neon/neon-js";

const SECRET = import.meta.env.VITE_TEST_JWT_SECRET;
const KEY = "uravu-test-user";

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64json = obj => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function sign(claims) {
  const head = b64json({ alg: "HS256", typ: "JWT" }), body = b64json(claims);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

const userFor = (email, name) => {
  const local = email.toLowerCase().split("@")[0].replace(/[^a-z0-9]/g, "");
  return { id: `u-${local}`, email: email.toLowerCase(), name: name || local[0].toUpperCase() + local.slice(1) };
};
const current = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
const remember = u => localStorage.setItem(KEY, JSON.stringify(u));

export function createTestClient(dataApiUrl) {
  const client = createClient({
    dataApi: {
      url: dataApiUrl,
      getToken: async () => {
        const u = current();
        if (!u) return null;
        const now = Math.floor(Date.now() / 1000);
        return sign({ sub: u.id, email: u.email, role: "authenticated", iat: now, exp: now + 900 });
      },
    },
  });
  const ok = data => ({ data, error: null });
  client.auth = {
    getSession: async () => ok(current() ? { user: current(), session: { token: "test" } } : null),
    signIn: {
      email: async ({ email, password }) => {
        if (password !== "password123") return { data: null, error: { message: "Invalid email or password" } };
        remember(userFor(email)); return ok({ user: current() });
      },
      social: async ({ callbackURL }) => {
        remember(userFor("owner@example.com", "Jeeva")); location.href = callbackURL; return ok({});
      },
    },
    signUp: {
      email: async ({ email, name }) => { remember(userFor(email, name)); return ok({ user: current() }); },
    },
    signOut: async () => { localStorage.removeItem(KEY); return ok({}); },
  };
  return client;
}
