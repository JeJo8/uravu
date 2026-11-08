/*
 * Log in, sign up, and join-a-tree pages (all served as auth.html).
 *   /login?next=…     /signup?next=…     /join/<invite token>
 * Sign-in is handled by Neon Auth; joining calls accept_invite() in the database.
 */
import { getClient, currentUser, friendlyError } from "./neon.js";
import { setupPwa } from "./pwa.js";

const view = document.getElementById("view");
const params = new URLSearchParams(location.search);
const safeNext = u => (u && u.startsWith("/") && !u.startsWith("//") ? u : "/");
const next = safeNext(params.get("next"));
const path = location.pathname;

/** Tiny DOM helper: h("p", {class: "x"}, "text", child...). Text is never parsed as HTML. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
const show = (...nodes) => view.replaceChildren(...nodes);
const errBox = () => h("div", { class: "err", role: "alert" });

function googleButton(label) {
  const a = h("a", { class: "google", href: "#" }, label);
  a.addEventListener("click", async e => {
    e.preventDefault();
    a.setAttribute("aria-disabled", "true");
    a.parentElement.querySelector(".notice")?.remove();
    let error;
    try {
      const client = await getClient();
      error = (await client.auth.signIn.social({ provider: "google", callbackURL: location.origin + next }))?.error;
    } catch (ex) {
      error = ex;   // the SDK throws for some HTTP errors instead of returning them
    }
    if (error) {
      a.removeAttribute("aria-disabled");
      a.after(h("div", { class: "notice" }, authError(error)));
    }
  });
  return a;
}

function form(fields, buttonLabel, submit) {
  const err = errBox();
  const btn = h("button", {}, buttonLabel);
  const f = h("form", {}, ...fields, btn, err);
  f.addEventListener("submit", async e => {
    e.preventDefault();
    btn.disabled = true;
    err.textContent = "";
    try {
      await submit(Object.fromEntries(new FormData(f)));
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });
  return f;
}

/** Neon Auth error -> message. "Invalid callbackURL" means this site isn't a trusted domain yet. */
function authError(err) {
  const m = `${err?.message || ""} ${err?.code || ""} ${err?.body?.error || ""}`;
  if (/callback|origin|INVALID_CALLBACKURL|403/i.test(m)) {
    return `Sign-in isn't set up for ${location.origin} yet. In Neon: Settings → Better Auth → add it as a trusted domain.`;
  }
  return friendlyError(err, "Google sign-in didn't work. Please try again.");
}

const field = (label, attrs) => h("label", {}, label, h("input", attrs));
const linkTo = (p, text) => h("a", { href: `${p}?next=${encodeURIComponent(next)}` }, text);

async function emailAuth(kind, values) {
  const client = await getClient();
  let res;
  try {
    res = kind === "login"
      ? await client.auth.signIn.email({ email: values.email.trim(), password: values.password })
      : await client.auth.signUp.email({ email: values.email.trim(), password: values.password, name: values.name.trim() });
  } catch (ex) {
    res = { error: ex };   // the SDK throws for some HTTP errors instead of returning them
  }
  if (res?.error && /callback|origin|403/i.test(`${res.error.message} ${res.error.code}`)) {
    throw new Error(authError(res.error));
  }
  if (res?.error) {
    const m = res.error.message || "";
    throw new Error(/invalid|incorrect|credential/i.test(m) ? "Wrong email or password"
      : /exist/i.test(m) ? "An account with this email already exists. Log in instead."
      : friendlyError(res.error));
  }
  if (!(await currentUser())) {
    // Neon Auth can be set to require email verification before the first sign-in
    show(h("p", {}, "Check your inbox to verify your email, then log in."), linkTo("/login", "Go to log in"));
    return;
  }
  location.href = next;
}

function loginPage() {
  document.title = "Uravu — Log in";
  show(
    h("p", {}, "Log in to see your family trees."),
    googleButton("Continue with Google"),
    h("div", { class: "or" }, "or use email"),
    form([field("Email", { name: "email", type: "email", autocomplete: "email", required: true, autofocus: true }),
          field("Password", { name: "password", type: "password", autocomplete: "current-password", required: true })],
         "Log in", v => emailAuth("login", v)),
    h("div", { class: "alt" }, "New here? ", linkTo("/signup", "Create an account"),
      h("br"), h("small", {}, "Signed up with Google? Use the Google button.")),
  );
}

function signupPage() {
  document.title = "Uravu — Sign up";
  show(
    h("p", {}, "Create an account to build and share your family tree."),
    googleButton("Continue with Google"),
    h("div", { class: "or" }, "or sign up with email"),
    form([field("Your name", { name: "name", autocomplete: "name", required: true, autofocus: true, maxlength: 80 }),
          field("Email", { name: "email", type: "email", autocomplete: "email", required: true }),
          field("Password (8+ characters)", { name: "password", type: "password", autocomplete: "new-password", minlength: 8, required: true })],
         "Create account", v => emailAuth("signup", v)),
    h("div", { class: "alt" }, "Already have an account? ", linkTo("/login", "Log in")),
  );
}

async function joinPage(token) {
  document.title = "Uravu — Join a family tree";
  const user = await currentUser();
  if (!user) {
    location.href = `/login?next=${encodeURIComponent(path)}`;
    return;
  }
  const client = await getClient();
  const { data, error } = await client.rpc("invite_info", { p_token: token });
  const info = data?.[0];
  if (error || !info) {
    show(h("p", {}, "This invite link has expired or was removed. Ask the person who sent it for a new one."),
         h("a", { href: "/" }, "Go to my trees"));
    return;
  }
  const logout = h("a", { href: "#" }, "Log out");
  logout.addEventListener("click", async e => {
    e.preventDefault();
    await client.auth.signOut();
    location.href = `/login?next=${encodeURIComponent(path)}`;
  });
  const parts = [
    h("p", {}, `Hi ${user.name}, you've been invited to`),
    h("div", { class: "tree" }, info.tree_name),
    h("p", { style: "margin-top:6px" }, "as ", h("b", {}, info.role),
      info.role === "editor" ? " (can add and edit people)." : " (can view)."),
  ];
  if (info.my_role) {
    parts.push(h("p", {}, "You're already a ", h("b", {}, info.my_role), " of this tree."),
               h("a", { href: `/?tree=${info.tree_id}` }, h("button", { type: "button", style: "width:100%" }, "Open my trees")));
  } else {
    const err = errBox();
    const btn = h("button", { style: "width:100%" }, "Join this tree");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const res = await client.rpc("accept_invite", { p_token: token });
      if (res.error) { err.textContent = friendlyError(res.error); btn.disabled = false; return; }
      location.href = `/?tree=${res.data}`;
    });
    parts.push(btn, err);
  }
  parts.push(h("div", { class: "alt" }, "Not you? ", logout));
  show(...parts);
}

async function main() {
  const join = path.match(/^\/join\/([0-9a-f]{64})\/?$/);
  if (join) return joinPage(join[1]);
  if (path.startsWith("/join/")) {
    return show(h("p", {}, "This invite link isn't valid. Check you copied all of it."), h("a", { href: "/" }, "Go to my trees"));
  }
  if (await currentUser()) { location.href = next; return; }   // already signed in
  return path.startsWith("/signup") ? signupPage() : loginPage();
}

main().catch(e => show(h("div", { class: "notice" }, friendlyError(e))));

setupPwa(null);
