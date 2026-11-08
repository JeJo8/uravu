/*
 * Security rules (db/setup.sql) tested on a local Postgres that imitates Neon.
 * Each query runs as the `authenticated` role with a JWT "sub", exactly like
 * a request through the Neon Data API.
 *
 *   PGURL=postgresql://postgres@localhost:5433/postgres node --test tests-db/
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";

const ADMIN_URL = process.env.PGURL || "postgresql://postgres@localhost:5433/postgres";
const DB = "uravu_rls_test";
let admin, db;

const sql = f => readFileSync(new URL(f, import.meta.url), "utf8");

before(async () => {
  admin = new pg.Client(ADMIN_URL);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`CREATE DATABASE ${DB}`);
  db = new pg.Client(ADMIN_URL.replace(/\/[^/]*$/, `/${DB}`));
  await db.connect();
  await db.query(sql("./neon_emulation.sql"));
  await db.query(sql("../db/setup.sql").replace("CHANGE-ME@gmail.com", "owner@example.com"));
  await db.query(`INSERT INTO neon_auth."user" (id, name, email, "emailVerified") VALUES
    ('u-owner', 'Jeeva', 'owner@example.com', true),
    ('u-fake',  'Fake',  'OWNER@example.com.evil', true),
    ('u-asha',  'Asha',  'asha@example.com', true),
    ('u-bala',  'Bala',  'bala@example.com', true),
    ('u-cara',  'Cara',  'cara@example.com', true)`);
});

after(async () => { await db?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${DB}`); await admin?.end(); });

/** Run queries as a signed-in user. Returns rows of the last query. */
async function as(uid, text, params = []) {
  await db.query("BEGIN");
  try {
    await db.query(uid ? "SET LOCAL ROLE authenticated" : "SET LOCAL ROLE anonymous");
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [uid ? JSON.stringify({ sub: uid }) : ""]);
    const r = await db.query(text, params);
    await db.query("COMMIT");
    return r.rows;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
const rejects = (p, re) => assert.rejects(p, re);
const newTree = async (uid, name) => (await as(uid, "SELECT * FROM create_tree($1)", [name]))[0].id;
const addPerson = async (uid, tree, name, gender = "M") =>
  (await as(uid, "INSERT INTO persons (tree_id, full_name, gender) VALUES ($1,$2,$3) RETURNING id", [tree, name, gender]))[0].id;
const invite = async (uid, tree, role) =>
  (await as(uid, "INSERT INTO invites (tree_id, role) VALUES ($1,$2) RETURNING token", [tree, role]))[0].token;
const join = (uid, token) => as(uid, "SELECT accept_invite($1) AS t", [token]);

test("old trees go to the verified owner email only", async () => {
  const t = (await db.query("INSERT INTO trees (name) VALUES ('Old Flask Tree') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO persons (tree_id, full_name, gender) VALUES ($1, 'Thatha', 'M')", [t]);
  assert.equal((await as("u-fake", "SELECT claim_unowned_trees() AS n"))[0].n, 0);
  assert.equal((await as("u-asha", "SELECT claim_unowned_trees() AS n"))[0].n, 0);
  await db.query(`UPDATE neon_auth."user" SET "emailVerified" = false WHERE id = 'u-owner'`);
  assert.equal((await as("u-owner", "SELECT claim_unowned_trees() AS n"))[0].n, 0, "unverified email can't claim");
  await db.query(`UPDATE neon_auth."user" SET "emailVerified" = true WHERE id = 'u-owner'`);
  assert.ok((await as("u-owner", "SELECT claim_unowned_trees() AS n"))[0].n >= 1);
  assert.deepEqual((await as("u-owner", "SELECT name FROM trees")).map(r => r.name), ["Old Flask Tree"]);
  assert.equal((await as("u-owner", "SELECT claim_unowned_trees() AS n"))[0].n, 0, "nothing left to claim");
});

test("strangers see and change nothing", async () => {
  const t = await newTree("u-asha", "Asha Family");
  const amma = await addPerson("u-asha", t, "Amma", "F");
  const appa = await addPerson("u-asha", t, "Appa", "M");
  await as("u-asha", "INSERT INTO relationships (person_id, related_id, type) VALUES ($1,$2,'spouse')", [amma, appa]);
  await invite("u-asha", t, "viewer");

  for (const table of ["trees", "persons", "relationships", "tree_members", "invites"]) {
    const rows = await as("u-bala", `SELECT * FROM ${table} WHERE ${table === "trees" ? "id" : table === "persons" ? "tree_id" : table === "relationships" ? "person_id" : "tree_id"} = $1`,
      [table === "relationships" ? amma : t]);
    assert.equal(rows.length, 0, `stranger reads ${table}`);
  }
  assert.equal((await as("u-bala", "UPDATE persons SET phone = '1' WHERE id = $1 RETURNING id", [amma])).length, 0);
  assert.equal((await as("u-bala", "DELETE FROM persons WHERE id = $1 RETURNING id", [amma])).length, 0);
  assert.equal((await as("u-bala", "UPDATE trees SET name = 'x' WHERE id = $1 RETURNING id", [t])).length, 0);
  assert.equal((await as("u-bala", "DELETE FROM trees WHERE id = $1 RETURNING id", [t])).length, 0);
  await rejects(addPerson("u-bala", t, "Intruder"), /row-level security/);
  await rejects(as("u-bala", "INSERT INTO tree_members (tree_id, user_id, role) VALUES ($1,'u-bala','owner')", [t]), /permission denied/);
  await rejects(as("u-bala", "INSERT INTO invites (tree_id, role) VALUES ($1,'editor')", [t]), /row-level security/);
  await rejects(as("u-bala", "SELECT * FROM tree_members_list($1)", [t]), /not a member/);
  await rejects(as("u-bala", "SELECT * FROM app_settings"), /permission denied/);
  assert.equal((await as("u-asha", "SELECT full_name FROM persons WHERE id = $1", [amma]))[0].full_name, "Amma");
});

test("logged-out (anonymous) requests get nothing", async () => {
  await rejects(as(null, "SELECT * FROM persons"), /permission denied/);
  await rejects(as(null, "SELECT create_tree('x')"), /permission denied/);
});

test("viewer invite: can look, can't change", async () => {
  const t = await newTree("u-asha", "Viewer Test");
  const p = await addPerson("u-asha", t, "Paati", "F");
  const token = await invite("u-asha", t, "viewer");
  const info = (await as("u-bala", "SELECT * FROM invite_info($1)", [token]))[0];
  assert.deepEqual([info.tree_name, info.role, info.my_role], ["Viewer Test", "viewer", null]);
  await join("u-bala", token);
  assert.equal((await as("u-bala", "SELECT * FROM persons WHERE tree_id = $1", [t])).length, 1);
  assert.equal((await as("u-bala", "UPDATE persons SET phone = '1' WHERE id = $1 RETURNING id", [p])).length, 0);
  await rejects(addPerson("u-bala", t, "X"), /row-level security/);
  await rejects(as("u-bala", "INSERT INTO invites (tree_id, role) VALUES ($1,'editor')", [t]), /row-level security/);
  const list = await as("u-bala", "SELECT * FROM tree_members_list($1)", [t]);
  assert.ok(list.every(m => m.email === null), "non-owners don't see emails");
  assert.equal((await as("u-bala", "SELECT * FROM invites WHERE tree_id = $1", [t])).length, 0);
  // a viewer link can't downgrade, and accepting twice is fine
  await join("u-bala", token);
});

test("editor invite, roles, last owner, leaving", async () => {
  const t = await newTree("u-asha", "Roles Test");
  await join("u-bala", await invite("u-asha", t, "editor"));
  const p = await addPerson("u-bala", t, "Chithappa");
  assert.equal((await as("u-bala", "UPDATE persons SET phone = '+91 1' WHERE id = $1 RETURNING id", [p])).length, 1);
  assert.equal((await as("u-bala", "DELETE FROM trees WHERE id = $1 RETURNING id", [t])).length, 0, "only owners delete trees");
  assert.equal((await as("u-bala", "UPDATE tree_members SET role = 'owner' WHERE tree_id = $1 AND user_id = 'u-bala' RETURNING id", [t])).length, 0, "editors can't promote themselves");
  const list = await as("u-asha", "SELECT * FROM tree_members_list($1)", [t]);
  assert.deepEqual(list.map(m => [m.name, m.role, !!m.email, m.is_me]), [["Asha", "owner", true, true], ["Bala", "editor", true, false]]);
  // last owner can't step down or leave
  await rejects(as("u-asha", "UPDATE tree_members SET role = 'viewer' WHERE tree_id = $1 AND user_id = 'u-asha'", [t]), /at least one owner/);
  await rejects(as("u-asha", "DELETE FROM tree_members WHERE tree_id = $1 AND user_id = 'u-asha'", [t]), /at least one owner/);
  await rejects(as("u-asha", "UPDATE tree_members SET user_id = 'u-cara' WHERE tree_id = $1", [t]), /permission denied/);
  // owner demotes Bala; Bala leaves on his own
  assert.equal((await as("u-asha", "UPDATE tree_members SET role = 'viewer' WHERE tree_id = $1 AND user_id = 'u-bala' RETURNING id", [t])).length, 1);
  assert.equal((await as("u-bala", "DELETE FROM tree_members WHERE tree_id = $1 AND user_id = 'u-bala' RETURNING id", [t])).length, 1);
  assert.equal((await as("u-bala", "SELECT * FROM persons WHERE tree_id = $1", [t])).length, 0);
});

test("invite links: random, owner-set role only, revoke and expiry", async () => {
  const t = await newTree("u-asha", "Invite Test");
  const token = await invite("u-asha", t, "viewer");
  assert.match(token, /^[0-9a-f]{64}$/);
  await rejects(as("u-asha", "INSERT INTO invites (tree_id, role, token) VALUES ($1,'viewer','chosen')", [t]), /permission denied/);
  await rejects(as("u-asha", "INSERT INTO invites (tree_id, role, expires_at) VALUES ($1,'viewer','2999-01-01')", [t]), /permission denied/);
  await rejects(as("u-asha", "INSERT INTO invites (tree_id, role) VALUES ($1,'owner')", [t]), /invites_role_ok/);
  await as("u-asha", "DELETE FROM invites WHERE token = $1", [token]);
  await rejects(join("u-bala", token), /expired/);
  const t2 = await invite("u-asha", t, "viewer");
  await db.query("UPDATE invites SET expires_at = now() - interval '1 minute' WHERE token = $1", [t2]);
  await rejects(join("u-bala", t2), /expired/);
  assert.equal((await as("u-bala", "SELECT * FROM invite_info($1)", [t2])).length, 0);
});

test("linking trees: editor on both, validation, shared visibility", async () => {
  const a = await newTree("u-asha", "Link A");
  const priyaA = await addPerson("u-asha", a, "Priya", "F");
  const b = await newTree("u-cara", "Link B");
  const priyaB = await addPerson("u-cara", b, "Priya", "F");
  const balu = await addPerson("u-cara", b, "Balu", "M");

  await rejects(as("u-asha", "INSERT INTO person_links (person_a, person_b) VALUES ($1,$2)", [priyaA, priyaB]), /row-level security/);
  await join("u-asha", await invite("u-cara", b, "editor"));
  await rejects(as("u-asha", "INSERT INTO person_links (person_a, person_b) VALUES ($1,$2)", [priyaA, balu]), /different genders/);
  const p2 = await addPerson("u-asha", a, "Kamala", "F");
  await rejects(as("u-asha", "INSERT INTO person_links (person_a, person_b) VALUES ($1,$2)", [priyaA, p2]), /different tree/);
  await as("u-asha", "INSERT INTO person_links (person_a, person_b) VALUES ($1,$2)", [priyaA, priyaB]);
  await rejects(as("u-asha", "INSERT INTO person_links (person_a, person_b) VALUES ($1,$2)", [priyaB, priyaA]), /Already linked/);
  await rejects(as("u-asha", "INSERT INTO person_links (person_a, person_b) VALUES ($1,$2)", [p2, priyaB]), /already linked to someone in that tree|different tree/);

  // Bala views tree A only; the link lets him see the linked family B too (read-only)
  await join("u-bala", await invite("u-asha", a, "viewer"));
  const seen = (await as("u-bala", "SELECT full_name FROM persons ORDER BY id")).map(r => r.full_name);
  assert.ok(seen.includes("Balu"), "linked family visible");
  assert.equal((await as("u-bala", "UPDATE persons SET phone = '1' WHERE id = $1 RETURNING id", [balu])).length, 0);
  // someone with no access to either tree still sees nothing
  assert.equal((await as("u-fake", "SELECT * FROM persons WHERE id IN ($1,$2)", [priyaA, balu])).length, 0);
  // unlinking: editor of either side
  assert.equal((await as("u-cara", "DELETE FROM person_links WHERE person_a = $1 RETURNING id", [priyaA])).length, 1);
  assert.ok(!(await as("u-bala", "SELECT full_name FROM persons")).some(r => r.full_name === "Balu"));
});

test("data rules: phone, photo, names, relationships", async () => {
  const t = await newTree("u-asha", "Rules");
  const p = await addPerson("u-asha", t, "Mani");
  await rejects(as("u-asha", "UPDATE persons SET phone = 'call<script>' WHERE id = $1", [p]), /persons_phone_ok/);
  await rejects(as("u-asha", "UPDATE persons SET photo_data = 'data:text/html;base64,PGI+' WHERE id = $1", [p]), /persons_photo_ok/);
  await rejects(as("u-asha", "UPDATE persons SET full_name = '   ' WHERE id = $1", [p]), /persons_name_ok/);
  await rejects(as("u-asha", "UPDATE persons SET gender = 'X' WHERE id = $1", [p]), /gender/);
  await rejects(as("u-asha", "INSERT INTO relationships (person_id, related_id, type) VALUES ($1,$1,'parent')", [p]), /relationships_type_ok/);
  await rejects(as("u-asha", "SELECT create_tree('  ')"), /name/);
  const ok = await as("u-asha", "UPDATE persons SET phone = '+44 7700 900123', photo_data = 'data:image/png;base64,iVBORw0KGgo=' WHERE id = $1 RETURNING id", [p]);
  assert.equal(ok.length, 1);
});

test("owner deletes a tree: everything in it goes", async () => {
  const t = await newTree("u-asha", "Delete Me");
  await join("u-bala", await invite("u-asha", t, "editor"));
  const p = await addPerson("u-asha", t, "Gone");
  await invite("u-asha", t, "viewer");
  assert.equal((await as("u-asha", "DELETE FROM trees WHERE id = $1 RETURNING id", [t])).length, 1);
  for (const [q, v] of [["SELECT count(*) n FROM persons WHERE id = $1", p], ["SELECT count(*) n FROM tree_members WHERE tree_id = $1", t],
                        ["SELECT count(*) n FROM invites WHERE tree_id = $1", t]]) {
    assert.equal(+(await db.query(q, [v])).rows[0].n, 0);
  }
});
