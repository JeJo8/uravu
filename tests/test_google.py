"""Google sign-in, with Google itself faked out."""
from urllib.parse import parse_qs, urlparse

import pytest

import auth
from app import app, init_db
from models import SessionLocal, User

METADATA = {"issuer": "https://accounts.google.com",
            "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth",
            "token_endpoint": "https://oauth2.googleapis.com/token",
            "jwks_uri": "https://www.googleapis.com/oauth2/v3/certs"}


@pytest.fixture(autouse=True)
def fake_google(monkeypatch):
    app.test_cli_runner().invoke(init_db)
    g = auth.oauth.google
    monkeypatch.setattr(g, "load_server_metadata", lambda: METADATA)
    state = {"userinfo": None, "fail": False}

    def fake_token(**kw):
        if state["fail"]:
            raise auth.OAuthError(error="invalid_grant")
        return {"access_token": "x", "userinfo": state["userinfo"]}
    monkeypatch.setattr(g, "authorize_access_token", fake_token)
    return state


def google_user(sub, email, verified=True, name="Google Person"):
    return {"sub": sub, "email": email, "email_verified": verified, "name": name}


def test_login_page_shows_button():
    page = app.test_client().get("/login").get_data(as_text=True)
    assert "Continue with Google" in page


def test_start_redirects_to_google_with_safe_scopes():
    c = app.test_client()
    r = c.get("/auth/google?next=/join/abc")
    assert r.status_code == 302
    url = urlparse(r.headers["Location"])
    q = parse_qs(url.query)
    assert url.netloc == "accounts.google.com"
    assert q["scope"] == ["openid email profile"]
    assert q["redirect_uri"][0].endswith("/auth/google/callback")
    assert "state" in q and "nonce" in q
    with c.session_transaction() as s:
        assert s["after_login"] == "/join/abc"


def test_new_google_user_is_created_and_logged_in(fake_google):
    fake_google["userinfo"] = google_user("g-new-1", "New.Person@Gmail.com", name="Meena K")
    c = app.test_client()
    with c.session_transaction() as s:
        s["after_login"] = "/join/xyz"
    r = c.get("/auth/google/callback?code=abc&state=s")
    assert r.status_code == 302 and r.headers["Location"] == "/join/xyz"
    me = c.get("/api/auth/me").json
    assert me["name"] == "Meena K" and me["email"] == "new.person@gmail.com"
    # same Google account next time -> same user, no duplicate
    c2 = app.test_client()
    c2.get("/auth/google/callback?code=abc&state=s")
    assert c2.get("/api/auth/me").json["id"] == me["id"]
    # no password to log in with
    r = app.test_client().post("/api/auth/login", json={"email": "new.person@gmail.com", "password": ""})
    assert r.status_code == 401


def test_links_existing_email_account_and_clears_password(fake_google):
    c = app.test_client()
    c.post("/api/auth/signup", json={"name": "Old", "email": "linkme@gmail.com", "password": "password123"})
    uid = c.get("/api/auth/me").json["id"]
    fake_google["userinfo"] = google_user("g-link-1", "linkme@gmail.com")
    g = app.test_client()
    g.get("/auth/google/callback?code=abc&state=s")
    assert g.get("/api/auth/me").json["id"] == uid          # same account, trees kept
    with SessionLocal() as db:
        u = db.get(User, uid)
        assert u.google_id == "g-link-1" and u.password_hash is None
    r = app.test_client().post("/api/auth/login", json={"email": "linkme@gmail.com", "password": "password123"})
    assert r.status_code == 401                              # old (unverified) password no longer works


def test_unverified_email_refused(fake_google):
    fake_google["userinfo"] = google_user("g-unv", "unverified@example.com", verified=False)
    c = app.test_client()
    r = c.get("/auth/google/callback?code=abc&state=s")
    assert r.headers["Location"] == "/login?error=google_unverified"
    assert c.get("/api/auth/me").status_code == 401


def test_cancel_and_failure(fake_google):
    c = app.test_client()
    assert c.get("/auth/google/callback?error=access_denied").headers["Location"] == "/login?error=google_cancelled"
    fake_google["fail"] = True
    assert c.get("/auth/google/callback?code=x&state=y").headers["Location"] == "/login?error=google_failed"
    page = c.get("/login?error=google_failed").get_data(as_text=True)
    assert "didn&#39;t work" in page or "didn't work" in page
    # unknown codes are ignored, never echoed back
    page = c.get("/login?error=<b>hacked</b>").get_data(as_text=True)
    assert "hacked" not in page and 'class="notice"' not in page


def test_no_open_redirect_after_google(fake_google):
    fake_google["userinfo"] = google_user("g-redir", "redir@gmail.com")
    c = app.test_client()
    with c.session_transaction() as s:
        s["after_login"] = "//evil.example"
    assert c.get("/auth/google/callback?code=a&state=b").headers["Location"] == "/"


def test_google_user_cannot_change_password(fake_google):
    fake_google["userinfo"] = google_user("g-pw", "pw@gmail.com")
    c = app.test_client()
    c.get("/auth/google/callback?code=a&state=b")
    r = c.post("/api/auth/password", json={"current_password": "", "new_password": "newpassword1"})
    assert r.status_code == 400
