"""Accounts, roles, invites and the basic security protections."""
import pytest

import auth
from app import app, init_db


@pytest.fixture(scope="module", autouse=True)
def db_ready():
    app.test_cli_runner().invoke(init_db)


def new_user(name):
    c = app.test_client()
    r = c.post("/api/auth/signup", json={"name": name, "email": f"{name.lower()}@sec.test",
                                         "password": "password123"})
    assert r.status_code == 201, r.json
    return c


@pytest.fixture
def family():
    """Asha owns a tree with one person; Bala is a stranger."""
    asha, bala = new_user(f"Asha{id(object())}"), new_user(f"Bala{id(object())}")
    tree = asha.post("/api/trees", json={"name": "Asha Family"}).json
    person = asha.post("/api/people", json={"tree_id": tree["id"], "full_name": "Amma",
                                            "gender": "F", "phone": "+91 99999 00000"}).json
    return asha, bala, tree["id"], person["id"]


def test_logged_out_is_blocked():
    c = app.test_client()
    assert c.get("/api/trees").status_code == 401
    r = c.get("/")
    assert r.status_code == 302 and r.headers["Location"].startswith("/login")
    assert c.get("/login").status_code == 200
    assert c.get("/healthz").status_code == 200


def test_signup_validation():
    c = app.test_client()
    bad = [{"name": "", "email": "a@b.co", "password": "password123"},
           {"name": "X", "email": "not-an-email", "password": "password123"},
           {"name": "X", "email": "short@pw.test", "password": "1234567"}]
    for body in bad:
        assert c.post("/api/auth/signup", json=body).status_code == 400
    new_user("Dup")
    r = c.post("/api/auth/signup", json={"name": "Dup", "email": "DUP@sec.test", "password": "password123"})
    assert r.status_code == 400 and "already exists" in r.json["error"]


def test_login_logout_and_password_is_hashed():
    new_user("Lena")
    c = app.test_client()
    assert c.post("/api/auth/login", json={"email": "lena@sec.test", "password": "nope"}).status_code == 401
    assert c.post("/api/auth/login", json={"email": "LENA@sec.test", "password": "password123"}).status_code == 200
    assert c.get("/api/auth/me").json["name"] == "Lena"
    from models import SessionLocal, User
    with SessionLocal() as db:
        assert "password123" not in db.query(User).filter_by(email="lena@sec.test").one().password_hash
    c.post("/api/auth/logout", json={})
    assert c.get("/api/trees").status_code == 401


def test_strangers_see_nothing(family):
    asha, bala, tree_id, person_id = family
    assert tree_id not in [t["id"] for t in bala.get("/api/trees").json]
    assert bala.get(f"/api/trees/{tree_id}").status_code == 403
    assert bala.get(f"/api/trees/{tree_id}/kinship/{person_id}").status_code == 403
    assert bala.put(f"/api/people/{person_id}", json={"phone": "123"}).status_code == 403
    assert bala.delete(f"/api/people/{person_id}").status_code == 403
    assert bala.post("/api/people", json={"tree_id": tree_id, "full_name": "X", "gender": "M"}).status_code == 403
    assert bala.get(f"/api/trees/{tree_id}/members").status_code == 403
    assert bala.delete(f"/api/trees/{tree_id}").status_code == 403


def test_viewer_invite(family):
    asha, bala, tree_id, person_id = family
    inv = asha.post(f"/api/trees/{tree_id}/invites", json={"role": "viewer"}).json
    assert bala.get(inv["url"]).status_code == 200                    # join page
    assert bala.post(f"/api/invites/{inv['url'].split('/')[-1]}/accept", json={}).json["tree_id"] == tree_id
    assert bala.get(f"/api/trees/{tree_id}").status_code == 200       # can view
    assert bala.put(f"/api/people/{person_id}", json={"phone": "1"}).status_code == 403   # can't edit
    assert bala.post(f"/api/trees/{tree_id}/invites", json={"role": "editor"}).status_code == 403
    members = bala.get(f"/api/trees/{tree_id}/members").json
    assert all(m["email"] is None for m in members["members"])        # emails hidden from non-owners
    assert "invites" not in members


def test_editor_invite_and_roles(family):
    asha, bala, tree_id, person_id = family
    token = asha.post(f"/api/trees/{tree_id}/invites", json={"role": "editor"}).json["url"].split("/")[-1]
    bala.post(f"/api/invites/{token}/accept", json={})
    assert bala.post("/api/people", json={"tree_id": tree_id, "full_name": "Appa", "gender": "M",
                                          "relative_id": person_id, "relation": "husband"}).status_code == 201
    assert bala.delete(f"/api/trees/{tree_id}").status_code == 403    # only owners delete trees
    m = asha.get(f"/api/trees/{tree_id}/members").json
    assert any(x["email"] for x in m["members"])                      # owner sees emails
    asha_id = next(x["user_id"] for x in m["members"] if x["is_me"])
    bala_id = next(x["user_id"] for x in m["members"] if not x["is_me"])
    # last owner can't step down or leave
    assert asha.put(f"/api/trees/{tree_id}/members/{asha_id}", json={"role": "viewer"}).status_code == 400
    assert asha.delete(f"/api/trees/{tree_id}/members/{asha_id}").status_code == 400
    # owner demotes Bala; Bala can leave by himself
    assert asha.put(f"/api/trees/{tree_id}/members/{bala_id}", json={"role": "viewer"}).status_code == 200
    assert bala.delete(f"/api/trees/{tree_id}/members/{bala_id}").status_code == 204
    assert bala.get(f"/api/trees/{tree_id}").status_code == 403


def test_revoked_and_expired_invites(family):
    asha, bala, tree_id, _ = family
    inv = asha.post(f"/api/trees/{tree_id}/invites", json={"role": "viewer"}).json
    assert asha.delete(f"/api/trees/{tree_id}/invites/{inv['id']}").status_code == 204
    token = inv["url"].split("/")[-1]
    assert bala.post(f"/api/invites/{token}/accept", json={}).status_code == 404
    assert asha.post(f"/api/trees/{tree_id}/invites", json={"role": "owner"}).status_code == 400

    from datetime import datetime, timedelta
    from models import Invite, SessionLocal
    inv2 = asha.post(f"/api/trees/{tree_id}/invites", json={"role": "viewer"}).json
    with SessionLocal() as db:
        i = db.get(Invite, inv2["id"])
        i.expires_at = datetime(2000, 1, 1)
        db.commit()
    assert bala.post(f"/api/invites/{inv2['url'].split('/')[-1]}/accept", json={}).status_code == 404


def test_linking_needs_editor_on_both_trees(family):
    asha, bala, tree_id, person_id = family
    bala_tree = bala.post("/api/trees", json={"name": "Bala Family"}).json["id"]
    amma2 = bala.post("/api/people", json={"tree_id": bala_tree, "full_name": "Amma", "gender": "F"}).json["id"]
    assert bala.post("/api/links", json={"person_a": amma2, "person_b": person_id}).status_code == 403
    token = asha.post(f"/api/trees/{tree_id}/invites", json={"role": "editor"}).json["url"].split("/")[-1]
    bala.post(f"/api/invites/{token}/accept", json={})
    assert bala.post("/api/links", json={"person_a": amma2, "person_b": person_id}).status_code == 201


def test_owner_can_delete_tree(family):
    asha, _, tree_id, person_id = family
    assert asha.delete(f"/api/trees/{tree_id}").status_code == 204
    assert tree_id not in [t["id"] for t in asha.get("/api/trees").json]
    assert asha.get(f"/api/people/{person_id}/photo").status_code == 404


def test_cross_site_form_posts_rejected(family):
    asha, _, tree_id, _ = family
    r = asha.post("/api/trees", data={"name": "evil"})               # form-encoded, like a CSRF form
    assert r.status_code == 415


def test_no_open_redirect():
    c = app.test_client()
    page = c.get("/login?next=//evil.example").get_data(as_text=True)
    assert 'const next = "/";' in page


def test_login_rate_limit():
    new_user("Ravi")
    c = app.test_client()
    try:
        for _ in range(auth.LIMIT):
            c.post("/api/auth/login", json={"email": "ravi@sec.test", "password": "wrong"})
        r = c.post("/api/auth/login", json={"email": "ravi@sec.test", "password": "password123"})
        assert r.status_code == 429
    finally:
        auth._failures.clear()
