/*
 * The page calls api("/api/...") just like it did with the old Flask server.
 * This file answers those calls in the browser instead: it reads and writes
 * through the Neon Data API and runs the kinship engine locally.
 *
 * Permissions are NOT decided here. The database's Row Level Security rules
 * (db/setup.sql) decide what each user may see or change; this file only turns
 * "0 rows changed" and database errors into friendly messages.
 */
import { getClient, currentUser, friendlyError } from "./neon.js";
import { callsEveryone } from "./kinship.js";
import { loadView, kinInputs, connectedTreeIds, samePersonIds } from "./view.js";
import { LANGUAGES, TERMS } from "./terms.js";

const PERSON_COLS = "id,tree_id,full_name,native_name,gender,birth_date,phone,address";
const RANK = { viewer: 1, editor: 2, owner: 3 };
const RELATIONS = ["father", "mother", "son", "daughter", "husband", "wife", "brother", "sister"];

class ApiError extends Error {}
const fail = msg => { throw new ApiError(msg); };

/** Unwraps a Data API response, throwing a friendly error if it failed. */
function check({ data, error }, fallback) {
  if (error) fail(friendlyError(error, fallback));
  return data;
}
/** For update/delete: RLS hides rows you may not change, so 0 rows = no permission. */
function changed(res, msg) {
  const rows = check(res);
  if (!rows || !rows.length) fail(msg);
  return rows;
}

let me = null;
async function requireUser() {
  me = me || await currentUser();
  if (!me) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
    fail("Please log in");
  }
  return me;
}

// ---------------------------------------------------------------- loading
/** Every row this user may see; the database has already filtered it. */
async function loadAll() {
  const db = await getClient();
  const user = await requireUser();
  const [trees, persons, relationships, links, mine] = await Promise.all([
    db.from("trees").select("id,name").order("id"),
    db.from("persons").select(PERSON_COLS).order("id"),
    db.from("relationships").select("id,person_id,related_id,type").order("id"),
    db.from("person_links").select("id,person_a,person_b").order("id"),
    db.from("tree_members").select("tree_id,role").eq("user_id", user.id),
  ]);
  return {
    trees: check(trees), persons: check(persons), relationships: check(relationships),
    links: check(links), roles: new Map(check(mine).map(m => [m.tree_id, m.role])),
  };
}

function myRole(data, treeId) {
  return data.roles.get(treeId) || fail("You are not a member of this tree");
}
const editableTrees = data => [...data.roles].filter(([, r]) => RANK[r] >= RANK.editor).map(([t]) => t);

let lastView = null;   // reused by the kinship call that follows a tree load

async function treeView(treeId, linked) {
  const db = await getClient();
  const data = await loadAll();
  const role = myRole(data, treeId);
  const tree = data.trees.find(t => t.id === treeId);
  const view = loadView(data, treeId, linked);

  // photos are fetched separately so the main queries stay small
  const allIds = [...view.members.values()].flat();
  if (allIds.length) {
    const photos = new Map(check(await db.from("persons").select("id,photo_data")
      .in("id", allIds).not("photo_data", "is", null)).map(r => [r.id, r.photo_data]));
    for (const p of view.people) {
      p.photo_url = view.members.get(p.id).map(id => photos.get(id)).find(Boolean) || null;
    }
  }
  lastView = { key: `${treeId}|${linked}`, view };
  return {
    id: tree.id, name: tree.name, linked, role, editable_tree_ids: editableTrees(data),
    tree_ids: view.tree_ids, people: view.people, relationships: view.relationships,
  };
}

// ---------------------------------------------------------------- validation
// Same rules as the database; checked here first for clearer messages.
function personFields(d, { partial }) {
  const out = {};
  const has = k => !partial || k in d;
  const text = (v, n) => { const s = (v ?? "").toString().trim(); return s ? s.slice(0, n) : null; };
  if (has("full_name")) out.full_name = text(d.full_name, 120) || fail("Please enter a name");
  if (has("gender")) out.gender = ["M", "F"].includes(d.gender) ? d.gender : fail("Gender must be M or F");
  if (has("native_name")) out.native_name = text(d.native_name, 120);
  if (has("phone")) {
    out.phone = text(d.phone, 30);
    if (out.phone && !/^[0-9+() -]+$/.test(out.phone)) fail("Phone can only contain digits, spaces and + - ( )");
  }
  if (has("address")) out.address = text(d.address, 500);
  if (has("birth_date")) {
    out.birth_date = d.birth_date || null;
    if (out.birth_date && !/^\d{4}-\d{2}-\d{2}$/.test(out.birth_date)) fail("Birth date must be YYYY-MM-DD");
  }
  if (d.remove_photo) out.photo_data = null;
  if (d.photo) {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d.photo)) fail("Photo must be JPEG, PNG or WebP");
    if (d.photo.length > 600000) fail("Photo is too large");
    out.photo_data = d.photo;
  }
  return out;
}

// ---------------------------------------------------------------- people
async function addPerson(d) {
  const db = await getClient();
  const fields = personFields(d, { partial: false });
  let treeId = +d.tree_id;
  const rel = d.relation || null, rid = d.relative_id ? +d.relative_id : null;
  let parentIds = [];

  if (rel && rid) {
    if (!RELATIONS.includes(rel)) fail(`Unknown relation '${rel}'`);
    const data = await loadAll();
    const relative = data.persons.find(p => p.id === rid);
    if (!relative || !connectedTreeIds(data, treeId).has(relative.tree_id)) {
      fail("That relative isn't in this tree or a linked one");
    }
    if (rel === "brother" || rel === "sister") {
      // parents may live in a linked tree (e.g. a wife's parents in her family's tree)
      const copies = samePersonIds(data, rid);
      parentIds = [...new Set(data.relationships
        .filter(r => r.type === "parent" && copies.has(r.related_id)).map(r => r.person_id))];
      if (!parentIds.length) fail("Add a parent first, so siblings can be linked through them.");
      // the new sibling belongs in the parents' tree
      treeId = data.persons.find(p => p.id === Math.min(...parentIds)).tree_id;
      if (!editableTrees(data).includes(treeId)) {
        const name = data.trees.find(t => t.id === treeId)?.name;
        fail(`Siblings go in the parents' tree (${name}). Ask an editor of ${name} to add them.`);
      }
    }
  }

  const created = check(await db.from("persons").insert({ ...fields, tree_id: treeId })
    .select(PERSON_COLS).single(), "Couldn't add this person");

  if (rel && rid) {
    const links =
      rel === "father" || rel === "mother" ? [{ person_id: created.id, related_id: rid, type: "parent" }]
      : rel === "son" || rel === "daughter" ? [{ person_id: rid, related_id: created.id, type: "parent" }]
      : rel === "husband" || rel === "wife" ? [{ person_id: rid, related_id: created.id, type: "spouse" }]
      : parentIds.map(pid => ({ person_id: pid, related_id: created.id, type: "parent" }));
    const res = await db.from("relationships").insert(links);
    if (res.error) {
      await db.from("persons").delete().eq("id", created.id);   // undo, so no orphan is left
      fail(friendlyError(res.error));
    }
  }
  return { ...created, photo_url: fields.photo_data || null };
}

async function editPerson(id, d) {
  const db = await getClient();
  const fields = personFields(d, { partial: true });
  const rows = changed(await db.from("persons").update(fields).eq("id", id).select(PERSON_COLS),
    "You need editor access to change this person");
  return rows[0];
}

async function deletePerson(id) {
  const db = await getClient();
  changed(await db.from("persons").delete().eq("id", id).select("id"),
    "You need editor access to delete this person");
  return null;
}

// ---------------------------------------------------------------- members & invites
async function members(treeId) {
  const db = await getClient();
  const list = check(await db.rpc("tree_members_list", { p_tree: treeId }));
  const myRole = list.find(m => m.is_me)?.role || fail("You are not a member of this tree");
  const out = { my_role: myRole, members: list };
  if (myRole === "owner") {
    const inv = check(await db.from("invites").select("id,role,token,expires_at")
      .eq("tree_id", treeId).gt("expires_at", new Date().toISOString()).order("id"));
    out.invites = inv.map(i => ({ id: i.id, role: i.role, url: `/join/${i.token}`, expires_at: i.expires_at }));
  }
  return out;
}

// ---------------------------------------------------------------- router
const routes = [
  ["GET", /^\/api\/languages$/, () => LANGUAGES],

  ["GET", /^\/api\/auth\/me$/, () => requireUser()],

  ["POST", /^\/api\/auth\/logout$/, async () => {
    const db = await getClient();
    await db.auth.signOut();
    me = null;
    return { ok: true };
  }],

  ["GET", /^\/api\/trees$/, async () => {
    const db = await getClient();
    await requireUser();
    await db.rpc("claim_unowned_trees");   // gives pre-login trees to the owner email; harmless otherwise
    const data = await loadAll();
    const counts = new Map();
    for (const p of data.persons) counts.set(p.tree_id, (counts.get(p.tree_id) || 0) + 1);
    return data.trees.filter(t => data.roles.has(t.id))
      .map(t => ({ id: t.id, name: t.name, people: counts.get(t.id) || 0, role: data.roles.get(t.id) }));
  }],

  ["POST", /^\/api\/trees$/, async (m, body) => {
    const db = await getClient();
    const t = check(await db.rpc("create_tree", { p_name: (body.name || "").trim() }).single());
    return { id: t.id, name: t.name, role: "owner" };
  }],

  ["GET", /^\/api\/trees\/(\d+)$/, (m, body, q) => treeView(+m[1], q.get("linked") === "1")],

  ["PUT", /^\/api\/trees\/(\d+)$/, async (m, body) => {
    const db = await getClient();
    const name = (body.name || "").trim() || fail("Give the tree a name");
    changed(await db.from("trees").update({ name: name.slice(0, 120) }).eq("id", +m[1]).select("id"),
      "Only owners can rename a tree");
    return { id: +m[1], name };
  }],

  ["DELETE", /^\/api\/trees\/(\d+)$/, async m => {
    const db = await getClient();
    changed(await db.from("trees").delete().eq("id", +m[1]).select("id"), "Only owners can delete a tree");
    return null;
  }],

  ["GET", /^\/api\/trees\/(\d+)\/kinship\/(\d+)$/, async (m, body, q) => {
    const treeId = +m[1], linked = q.get("linked") === "1", lang = q.get("lang") || "ta";
    if (lastView?.key !== `${treeId}|${linked}`) await treeView(treeId, linked);
    const { view } = lastView;
    const ego = view.alias.get(+m[2]) ?? fail("Person not found");
    const [people, rels] = kinInputs(view);
    return callsEveryone(people, rels, TERMS, ego, lang);
  }],

  ["POST", /^\/api\/people$/, (m, body) => addPerson(body)],
  ["PUT", /^\/api\/people\/(\d+)$/, (m, body) => editPerson(+m[1], body)],
  ["DELETE", /^\/api\/people\/(\d+)$/, m => deletePerson(+m[1])],

  ["POST", /^\/api\/links$/, async (m, body) => {
    const db = await getClient();
    const row = check(await db.from("person_links")
      .insert({ person_a: +body.person_a, person_b: +body.person_b }).select("id,person_a,person_b").single(),
      "You need editor access to both trees to link them");
    return row;
  }],

  ["DELETE", /^\/api\/links\/(\d+)$/, async m => {
    const db = await getClient();
    changed(await db.from("person_links").delete().eq("id", +m[1]).select("id"),
      "You need editor access to one of these trees");
    return null;
  }],

  ["GET", /^\/api\/trees\/(\d+)\/members$/, m => members(+m[1])],

  ["PUT", /^\/api\/trees\/(\d+)\/members\/([^/]+)$/, async (m, body) => {
    const db = await getClient();
    if (!RANK[body.role]) fail("Role must be owner, editor or viewer");
    changed(await db.from("tree_members").update({ role: body.role })
      .eq("tree_id", +m[1]).eq("user_id", decodeURIComponent(m[2])).select("id"), "Only owners can change roles");
    return { ok: true };
  }],

  ["DELETE", /^\/api\/trees\/(\d+)\/members\/([^/]+)$/, async m => {
    const db = await getClient();
    changed(await db.from("tree_members").delete()
      .eq("tree_id", +m[1]).eq("user_id", decodeURIComponent(m[2])).select("id"), "Only owners can remove people");
    return null;
  }],

  ["POST", /^\/api\/trees\/(\d+)\/invites$/, async (m, body) => {
    const db = await getClient();
    const role = body.role || "viewer";
    if (!["editor", "viewer"].includes(role)) fail("Invite role must be editor or viewer");
    const i = check(await db.from("invites").insert({ tree_id: +m[1], role })
      .select("id,role,token,expires_at").single(), "Only owners can create invite links");
    return { id: i.id, role: i.role, url: `/join/${i.token}`, expires_at: i.expires_at };
  }],

  ["DELETE", /^\/api\/trees\/(\d+)\/invites\/(\d+)$/, async m => {
    const db = await getClient();
    changed(await db.from("invites").delete().eq("id", +m[2]).eq("tree_id", +m[1]).select("id"),
      "Only owners can revoke invite links");
    return null;
  }],
];

/** Drop-in replacement for the old fetch-based api(url, opts). */
export async function api(url, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const u = new URL(url, location.origin);
  const body = opts.body ? JSON.parse(opts.body) : {};
  for (const [verb, re, handler] of routes) {
    const m = verb === method && u.pathname.match(re);
    if (m) {
      try {
        return await handler(m, body, u.searchParams);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new Error(friendlyError(e));
      }
    }
  }
  throw new Error(`Unknown request ${method} ${u.pathname}`);
}
