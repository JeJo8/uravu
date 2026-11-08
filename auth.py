"""
Accounts, roles and invite links.

Roles per tree:  owner > editor > viewer
  viewer  – see the tree
  editor  – add / edit / delete people, link trees
  owner   – everything, plus members and invites
"""
import os
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from authlib.integrations.flask_client import OAuth, OAuthError
from flask import (Blueprint, abort, g, jsonify, redirect, render_template, url_for,
                   request, session)
from werkzeug.security import check_password_hash, generate_password_hash

from family_view import connected_tree_ids
from models import Invite, Person, SessionLocal, Tree, TreeMember, User

bp = Blueprint("auth", __name__)

RANK = {"viewer": 1, "editor": 2, "owner": 3}
INVITE_DAYS = 7
_DUMMY_HASH = generate_password_hash("not-a-real-password")

# ---------------------------------------------------------------- Google sign-in
oauth = OAuth()


def google_enabled():
    return bool(os.environ.get("GOOGLE_CLIENT_ID") and os.environ.get("GOOGLE_CLIENT_SECRET"))


def init_oauth(app):
    oauth.init_app(app)
    if google_enabled():
        oauth.register(
            name="google",
            client_id=os.environ["GOOGLE_CLIENT_ID"],
            client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
            server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
            client_kwargs={"scope": "openid email profile"},
        )


# Messages shown on the login page; only these fixed codes are accepted
LOGIN_ERRORS = {
    "google_cancelled": "Google sign-in was cancelled.",
    "google_failed": "Google sign-in didn't work. Please try again.",
    "google_unverified": "Your Google email isn't verified, so we can't use it.",
    "google_off": "Google sign-in isn't set up yet. Use email and password.",
}


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


# ---------------------------------------------------------------- login state

def load_user():
    """Runs before every request: sets g.user, guards pages and the API."""
    g.user = None
    uid = session.get("uid")
    if uid:
        with SessionLocal() as db:
            u = db.get(User, uid)
            if u:
                g.user = u.to_dict()
            else:
                session.clear()

    path = request.path
    public = path in ("/login", "/signup", "/healthz") or path.startswith("/api/auth/") \
        or path.startswith("/auth/google") \
        or path.startswith("/static/")
    if g.user or public:
        return None
    if path.startswith("/api/"):
        return jsonify({"error": "Please log in"}), 401
    return redirect(f"/login?next={path}")


def require_json_for_writes():
    """Blocks cross-site form posts (simple CSRF protection): browsers can't
    send application/json to another site without our permission."""
    if request.method in ("POST", "PUT", "PATCH") and request.path.startswith("/api/") \
            and not request.is_json:
        return jsonify({"error": "Expected JSON"}), 415
    return None


def _safe_next(url):
    return url if url and url.startswith("/") and not url.startswith("//") else "/"


# ---------------------------------------------------------------- roles

def role_for(db, user_id, tree_id):
    m = db.query(TreeMember).filter_by(user_id=user_id, tree_id=tree_id).first()
    return m.role if m else None


def require_role(db, tree_id, minimum):
    """Abort unless the logged-in user has at least `minimum` on this tree."""
    role = role_for(db, g.user["id"], tree_id)
    if not role:
        abort(403, "You are not a member of this tree")
    if RANK[role] < RANK[minimum]:
        abort(403, f"You need {minimum} access for this")
    return role


def my_tree_ids(db, minimum="viewer"):
    rows = db.query(TreeMember).filter_by(user_id=g.user["id"]).all()
    return {m.tree_id for m in rows if RANK[m.role] >= RANK[minimum]}


def can_view_person(db, person):
    """Members of a tree may also see families linked to it."""
    mine = my_tree_ids(db)
    if person.tree_id in mine:
        return True
    return any(person.tree_id in connected_tree_ids(db, t) for t in mine)


def claim_unowned_trees(db, user):
    """Trees made before logins existed (or by the seed commands) have no owner.
    They go to OWNER_EMAIL, or to the very first account if that isn't set."""
    owner_email = (os.environ.get("OWNER_EMAIL") or "").strip().lower()
    if owner_email:
        if user.email != owner_email:
            return
    elif db.query(User.id).order_by(User.id).first()[0] != user.id:
        return
    owned = {m.tree_id for m in db.query(TreeMember).all()}
    for t in db.query(Tree).all():
        if t.id not in owned:
            db.add(TreeMember(tree_id=t.id, user_id=user.id, role="owner"))
    db.commit()


# ---------------------------------------------------------------- rate limiting

_failures = defaultdict(deque)
LIMIT, WINDOW = 10, 15 * 60


def _client_ip():
    fwd = request.headers.get("X-Forwarded-For", "")   # Render sits behind a proxy
    return fwd.split(",")[0].strip() or request.remote_addr or "?"


def _too_many(*keys):
    cutoff = time.time() - WINDOW
    for k in keys:
        q = _failures[k]
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= LIMIT:
            return True
    return False


def _record_failure(*keys):
    for k in keys:
        _failures[k].append(time.time())


# ---------------------------------------------------------------- pages

@bp.get("/login")
def login_page():
    if g.user:
        return redirect(_safe_next(request.args.get("next")))
    return render_template("auth.html", mode="login", next=_safe_next(request.args.get("next")),
                           google=google_enabled(),
                           error=LOGIN_ERRORS.get(request.args.get("error")))


@bp.get("/signup")
def signup_page():
    if g.user:
        return redirect(_safe_next(request.args.get("next")))
    return render_template("auth.html", mode="signup", next=_safe_next(request.args.get("next")),
                           google=google_enabled())


@bp.get("/join/<token>")
def join_page(token):
    with SessionLocal() as db:
        inv = db.query(Invite).filter_by(token=token).first()
        if not inv or inv.expires_at < _now():
            return render_template("auth.html", mode="bad_invite"), 404
        tree = db.get(Tree, inv.tree_id)
        current = role_for(db, g.user["id"], inv.tree_id)
        return render_template("auth.html", mode="join", token=token, tree_name=tree.name,
                               role=inv.role, current=current, user=g.user)


@bp.get("/auth/google")
def google_start():
    if not google_enabled():
        return redirect("/login?error=google_off")
    session["after_login"] = _safe_next(request.args.get("next"))
    callback = url_for("auth.google_callback", _external=True)
    return oauth.google.authorize_redirect(callback)


@bp.get("/auth/google/callback")
def google_callback():
    if not google_enabled():
        return redirect("/login?error=google_off")
    if request.args.get("error"):                    # user pressed cancel on Google's page
        return redirect("/login?error=google_cancelled")
    try:
        # checks the state and nonce, and verifies Google's signed ID token
        token = oauth.google.authorize_access_token()
    except OAuthError:
        return redirect("/login?error=google_failed")
    info = token.get("userinfo") or {}
    sub, email = info.get("sub"), (info.get("email") or "").strip().lower()
    if not sub or not email:
        return redirect("/login?error=google_failed")
    if not info.get("email_verified"):
        return redirect("/login?error=google_unverified")

    with SessionLocal() as db:
        u = db.query(User).filter_by(google_id=sub).first()
        if not u:
            # same verified email as an existing email/password account -> link them
            u = db.query(User).filter_by(email=email).first()
            if u:
                u.google_id = sub
                # Email sign-ups were never verified; Google just proved who owns this
                # address, so drop any password someone else may have set with it.
                u.password_hash = None
            else:
                name = (info.get("name") or email.split("@")[0]).strip()[:80]
                u = User(name=name, email=email, google_id=sub, password_hash=None,
                         created_at=_now())
                db.add(u)
            db.commit()
        claim_unowned_trees(db, u)
        after = session.get("after_login", "/")
        session.clear()
        session.permanent = True
        session["uid"] = u.id
    return redirect(_safe_next(after))


# ---------------------------------------------------------------- auth API

@bp.post("/api/auth/signup")
def signup():
    d = request.json or {}
    name = (d.get("name") or "").strip()[:80]
    email = (d.get("email") or "").strip().lower()
    password = d.get("password") or ""
    if not name:
        return {"error": "Please enter your name"}, 400
    if len(email) > 254 or "@" not in email or "." not in email.split("@")[-1]:
        return {"error": "Please enter a valid email"}, 400
    if len(password) < 8:
        return {"error": "Password must be at least 8 characters"}, 400
    if _too_many("ip:" + _client_ip()):
        return {"error": "Too many attempts. Try again in 15 minutes."}, 429
    with SessionLocal() as db:
        if db.query(User).filter_by(email=email).first():
            _record_failure("ip:" + _client_ip())
            return {"error": "An account with this email already exists. Log in instead."}, 400
        u = User(name=name, email=email, password_hash=generate_password_hash(password),
                 created_at=_now())
        db.add(u)
        db.commit()
        claim_unowned_trees(db, u)
        session.clear()
        session.permanent = True
        session["uid"] = u.id
        return u.to_dict(), 201


@bp.post("/api/auth/login")
def login():
    d = request.json or {}
    email = (d.get("email") or "").strip().lower()
    password = d.get("password") or ""
    keys = ("ip:" + _client_ip(), "email:" + email)
    if _too_many(*keys):
        return {"error": "Too many attempts. Try again in 15 minutes."}, 429
    with SessionLocal() as db:
        u = db.query(User).filter_by(email=email).first()
        # check a dummy hash when the email is unknown, so timing gives nothing away
        stored = u.password_hash if (u and u.password_hash) else _DUMMY_HASH
        ok = check_password_hash(stored, password) and u is not None and bool(u.password_hash)
        if not ok:
            _record_failure(*keys)
            return {"error": "Wrong email or password"}, 401
        claim_unowned_trees(db, u)
        session.clear()
        session.permanent = True
        session["uid"] = u.id
        return u.to_dict()


@bp.post("/api/auth/logout")
def logout():
    session.clear()
    return {"ok": True}


@bp.get("/api/auth/me")
def me():
    if not g.user:
        return {"error": "Please log in"}, 401
    return g.user


@bp.post("/api/auth/password")
def change_password():
    if not g.user:
        return {"error": "Please log in"}, 401
    d = request.json or {}
    if len(d.get("new_password") or "") < 8:
        return {"error": "New password must be at least 8 characters"}, 400
    with SessionLocal() as db:
        u = db.get(User, g.user["id"])
        if not u.password_hash:
            return {"error": "You sign in with Google, so there's no password to change"}, 400
        if not check_password_hash(u.password_hash, d.get("current_password") or ""):
            _record_failure("ip:" + _client_ip())
            return {"error": "Current password is wrong"}, 400
        u.password_hash = generate_password_hash(d["new_password"])
        db.commit()
        return {"ok": True}


# ---------------------------------------------------------------- members

@bp.get("/api/trees/<int:tree_id>/members")
def members(tree_id):
    with SessionLocal() as db:
        my_role = require_role(db, tree_id, "viewer")
        rows = db.query(TreeMember, User).join(User, User.id == TreeMember.user_id) \
            .filter(TreeMember.tree_id == tree_id).order_by(User.name).all()
        out = {"my_role": my_role,
               "members": [{"user_id": u.id, "name": u.name, "role": m.role,
                            # only owners see email addresses
                            "email": u.email if my_role == "owner" else None,
                            "is_me": u.id == g.user["id"]} for m, u in rows]}
        if my_role == "owner":
            out["invites"] = [{"id": i.id, "role": i.role, "url": f"/join/{i.token}",
                               "expires_at": i.expires_at.isoformat()}
                              for i in db.query(Invite).filter_by(tree_id=tree_id).all()
                              if i.expires_at >= _now()]
        return out


def _owners(db, tree_id):
    return db.query(TreeMember).filter_by(tree_id=tree_id, role="owner").count()


@bp.put("/api/trees/<int:tree_id>/members/<int:user_id>")
def change_role(tree_id, user_id):
    role = (request.json or {}).get("role")
    if role not in RANK:
        return {"error": "Role must be owner, editor or viewer"}, 400
    with SessionLocal() as db:
        require_role(db, tree_id, "owner")
        m = db.query(TreeMember).filter_by(tree_id=tree_id, user_id=user_id).first() or abort(404)
        if m.role == "owner" and role != "owner" and _owners(db, tree_id) == 1:
            return {"error": "A tree needs at least one owner"}, 400
        m.role = role
        db.commit()
        return {"ok": True}


@bp.delete("/api/trees/<int:tree_id>/members/<int:user_id>")
def remove_member(tree_id, user_id):
    """Owners remove anyone; anyone can remove themselves (leave)."""
    with SessionLocal() as db:
        if user_id != g.user["id"]:
            require_role(db, tree_id, "owner")
        m = db.query(TreeMember).filter_by(tree_id=tree_id, user_id=user_id).first() or abort(404)
        if m.role == "owner" and _owners(db, tree_id) == 1:
            return {"error": "A tree needs at least one owner. Make someone else owner first."}, 400
        db.delete(m)
        db.commit()
        return "", 204


# ---------------------------------------------------------------- invites

@bp.post("/api/trees/<int:tree_id>/invites")
def create_invite(tree_id):
    role = (request.json or {}).get("role", "viewer")
    if role not in ("editor", "viewer"):
        return {"error": "Invite role must be editor or viewer"}, 400
    with SessionLocal() as db:
        require_role(db, tree_id, "owner")
        inv = Invite(token=secrets.token_urlsafe(18), tree_id=tree_id, role=role,
                     created_by=g.user["id"], expires_at=_now() + timedelta(days=INVITE_DAYS))
        db.add(inv)
        db.commit()
        return {"id": inv.id, "role": role, "url": f"/join/{inv.token}",
                "expires_at": inv.expires_at.isoformat()}, 201


@bp.delete("/api/trees/<int:tree_id>/invites/<int:invite_id>")
def revoke_invite(tree_id, invite_id):
    with SessionLocal() as db:
        require_role(db, tree_id, "owner")
        inv = db.query(Invite).filter_by(id=invite_id, tree_id=tree_id).first() or abort(404)
        db.delete(inv)
        db.commit()
        return "", 204


@bp.post("/api/invites/<token>/accept")
def accept_invite(token):
    with SessionLocal() as db:
        inv = db.query(Invite).filter_by(token=token).first()
        if not inv or inv.expires_at < _now():
            return {"error": "This invite link has expired. Ask for a new one."}, 404
        m = db.query(TreeMember).filter_by(tree_id=inv.tree_id, user_id=g.user["id"]).first()
        if not m:
            db.add(TreeMember(tree_id=inv.tree_id, user_id=g.user["id"], role=inv.role))
        elif RANK[inv.role] > RANK[m.role]:
            m.role = inv.role          # never downgrade an existing member
        db.commit()
        return {"tree_id": inv.tree_id}
