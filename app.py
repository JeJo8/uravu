import base64
import os
from datetime import date, datetime, timedelta, timezone

import click
from sqlalchemy import func
from flask import Flask, g, jsonify, request, render_template, abort, Response
from werkzeug.exceptions import HTTPException

import auth
import kinship
from auth import require_role, my_tree_ids, can_view_person, RANK
from family_view import load_view, kin_inputs, same_person_ids, connected_tree_ids
from models import (Base, engine, SessionLocal, Tree, Person, Relationship,
                    KinshipTerm, PersonLink, TreeMember, Invite, add_missing_columns)
from terms_seed import ALL_TERMS, LANGUAGES

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024  # 2 MB request limit

# Login cookie. Render sets RENDER=true, so cookies are HTTPS-only there.
# Without SECRET_KEY a random one is used: still safe, but everyone is logged
# out whenever the app restarts. render.yaml generates a permanent one.
app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY") or os.urandom(32),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(os.environ.get("RENDER")),
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)
if os.environ.get("RENDER"):
    # Render's proxy terminates HTTPS; trust its headers so Google gets https:// callback URLs
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
auth.init_oauth(app)
app.register_blueprint(auth.bp)
app.before_request(auth.require_json_for_writes)
app.before_request(auth.load_user)


@app.errorhandler(HTTPException)
def api_errors(e):
    """API callers get JSON errors instead of HTML pages."""
    if request.path.startswith("/api/"):
        return jsonify({"error": e.description}), e.code
    return e

PHOTO_TYPES = {"image/jpeg", "image/png", "image/webp"}
PHOTO_MAX_BYTES = 400 * 1024  # the browser shrinks photos to ~400px first


# ---------------------------------------------------------------- helpers

def _date(s):
    return date.fromisoformat(s) if s else None


def _clean(s, limit):
    s = (s or "").strip()
    return s[:limit] or None


def _apply_details(p, d):
    """Copy editable fields from request JSON onto a Person."""
    if "full_name" in d:
        name = _clean(d["full_name"], 120)
        if not name:
            return "Name can't be empty"
        p.full_name = name
    if "gender" in d:
        if d["gender"] not in ("M", "F"):
            return "gender must be M or F"
        p.gender = d["gender"]
    if "native_name" in d:
        p.native_name = _clean(d["native_name"], 120)
    if "phone" in d:
        phone = _clean(d["phone"], 30)
        if phone and not all(c.isdigit() or c in "+-() " for c in phone):
            return "Phone can only contain digits, spaces and + - ( )"
        p.phone = phone
    if "address" in d:
        p.address = _clean(d["address"], 500)
    if "birth_date" in d:
        try:
            p.birth_date = _date(d["birth_date"])
        except ValueError:
            return "birth_date must be YYYY-MM-DD"
    if d.get("remove_photo"):
        p.photo, p.photo_mime, p.photo_updated = None, None, None
    if d.get("photo"):
        return _set_photo(p, d["photo"])
    return None


def _set_photo(p, data_url):
    """data_url looks like 'data:image/jpeg;base64,....'"""
    try:
        header, b64 = data_url.split(",", 1)
        mime = header.split(":")[1].split(";")[0]
        raw = base64.b64decode(b64, validate=True)
    except (ValueError, IndexError):
        return "Photo could not be read"
    if mime not in PHOTO_TYPES:
        return "Photo must be JPEG, PNG or WebP"
    if len(raw) > PHOTO_MAX_BYTES:
        return "Photo is too large"
    p.photo, p.photo_mime = raw, mime
    p.photo_updated = datetime.now(timezone.utc).replace(tzinfo=None)
    return None


def _linked_flag():
    return request.args.get("linked") in ("1", "true", "yes")


def all_terms(db):
    return [t.to_dict() for t in db.query(KinshipTerm).all()]


# ---------------------------------------------------------------- pages

@app.get("/")
def home():
    return render_template("index.html")


@app.get("/healthz")
def health():
    return {"ok": True}


# ---------------------------------------------------------------- API: read

@app.get("/api/languages")
def languages():
    return jsonify(LANGUAGES)


@app.get("/api/trees")
def trees():
    """Only the trees you are a member of, with your role."""
    with SessionLocal() as db:
        # trees added by the seed commands later still go to the owner account
        auth.claim_unowned_trees(db, db.get(auth.User, g.user["id"]))
        roles = {m.tree_id: m.role for m in
                 db.query(TreeMember).filter_by(user_id=g.user["id"]).all()}
        counts = dict(db.query(Person.tree_id, func.count(Person.id)).group_by(Person.tree_id).all())
        trees_ = db.query(Tree).filter(Tree.id.in_(roles)).order_by(Tree.id).all() if roles else []
        return jsonify([{"id": t.id, "name": t.name, "people": counts.get(t.id, 0),
                         "role": roles[t.id]} for t in trees_])


@app.get("/api/trees/<int:tree_id>")
def tree(tree_id):
    """?linked=1 also shows every family joined through "same person" links."""
    with SessionLocal() as db:
        t = db.get(Tree, tree_id) or abort(404)
        role = require_role(db, tree_id, "viewer")
        view = load_view(db, tree_id, _linked_flag())
        return jsonify({"id": t.id, "name": t.name, "linked": _linked_flag(), "role": role,
                        "editable_tree_ids": sorted(my_tree_ids(db, "editor")),
                        "tree_ids": view["tree_ids"], "people": view["people"],
                        "relationships": view["relationships"]})


@app.get("/api/trees/<int:tree_id>/kinship/<int:person_id>")
def kinship_view(tree_id, person_id):
    """What the selected person calls everyone, and what everyone calls them."""
    lang = request.args.get("lang", "ta")
    with SessionLocal() as db:
        require_role(db, tree_id, "viewer")
        view = load_view(db, tree_id, _linked_flag())
        people, links = kin_inputs(view)
        ego = view["alias"].get(person_id)
        if ego is None:
            abort(404)
        result = kinship.calls_everyone(people, links, all_terms(db), ego, lang)
        return jsonify({str(k): v for k, v in result.items()})


@app.get("/api/kinship")
def kinship_pair():
    """/api/kinship?a=1&b=5&lang=ta — works across linked trees."""
    a, b = int(request.args["a"]), int(request.args["b"])
    lang = request.args.get("lang", "ta")
    with SessionLocal() as db:
        pa = db.get(Person, a) or abort(404)
        require_role(db, pa.tree_id, "viewer")
        view = load_view(db, pa.tree_id, include_linked=True)
        people, links = kin_inputs(view)
        if b not in view["alias"]:
            abort(404)
        return jsonify(kinship.relate(people, links, all_terms(db),
                                      view["alias"][a], view["alias"][b], lang))


# ---------------------------------------------------------------- API: links

@app.post("/api/links")
def add_link():
    """Mark two cards in different trees as the same person."""
    d = request.json
    with SessionLocal() as db:
        a, b = db.get(Person, d.get("person_a")), db.get(Person, d.get("person_b"))
        if not a or not b:
            return {"error": "Both people must exist"}, 400
        if a.tree_id == b.tree_id:
            return {"error": "Pick someone from a different tree"}, 400
        # linking shares both trees with each other's members, so you must edit both
        require_role(db, a.tree_id, "editor")
        require_role(db, b.tree_id, "editor")
        if a.gender != b.gender:
            return {"error": f"{a.full_name} and {b.full_name} have different genders"}, 400
        if b.id in same_person_ids(db, a.id):
            return {"error": "Already linked"}, 400
        if any(db.get(Person, x).tree_id == b.tree_id for x in same_person_ids(db, a.id)):
            return {"error": f"{a.full_name} is already linked to someone in that tree"}, 400
        link = PersonLink(person_a=a.id, person_b=b.id, status="approved")
        db.add(link)
        db.commit()
        return {"id": link.id, "person_a": a.id, "person_b": b.id}, 201


@app.delete("/api/links/<int:link_id>")
def remove_link(link_id):
    with SessionLocal() as db:
        link = db.get(PersonLink, link_id) or abort(404)
        editable = my_tree_ids(db, "editor")
        trees_ = {db.get(Person, link.person_a).tree_id, db.get(Person, link.person_b).tree_id}
        if not trees_ & editable:
            abort(403, "You need editor access to one of these trees")
        db.delete(link)
        db.commit()
        return "", 204


# ---------------------------------------------------------------- API: write

@app.post("/api/trees")
def create_tree():
    with SessionLocal() as db:
        name = _clean(request.json.get("name"), 120)
        if not name:
            return {"error": "Give the tree a name"}, 400
        t = Tree(name=name)
        db.add(t)
        db.flush()
        db.add(TreeMember(tree_id=t.id, user_id=g.user["id"], role="owner"))
        db.commit()
        return jsonify({"id": t.id, "name": t.name, "role": "owner"}), 201


@app.put("/api/trees/<int:tree_id>")
def rename_tree(tree_id):
    with SessionLocal() as db:
        require_role(db, tree_id, "owner")
        name = _clean((request.json or {}).get("name"), 120)
        if not name:
            return {"error": "Give the tree a name"}, 400
        db.get(Tree, tree_id).name = name
        db.commit()
        return {"id": tree_id, "name": name}


@app.delete("/api/trees/<int:tree_id>")
def delete_tree(tree_id):
    """Owner only. Removes the tree, its people, their links, members and invites."""
    with SessionLocal() as db:
        require_role(db, tree_id, "owner")
        ids = [pid for (pid,) in db.query(Person.id).filter_by(tree_id=tree_id).all()]
        if ids:
            db.query(Relationship).filter(Relationship.person_id.in_(ids) |
                                          Relationship.related_id.in_(ids)).delete(synchronize_session=False)
            db.query(PersonLink).filter(PersonLink.person_a.in_(ids) |
                                        PersonLink.person_b.in_(ids)).delete(synchronize_session=False)
            db.query(Person).filter(Person.id.in_(ids)).delete(synchronize_session=False)
        db.query(TreeMember).filter_by(tree_id=tree_id).delete()
        db.query(Invite).filter_by(tree_id=tree_id).delete()
        db.delete(db.get(Tree, tree_id))
        db.commit()
        return "", 204


@app.post("/api/people")
def add_person():
    """Body: tree_id, full_name, gender, birth_date?, native_name?,
    and optionally relative_id + relation (father, mother, son, daughter,
    husband, wife, brother, sister) to link the new person in one go."""
    d = request.json
    if d.get("gender") not in ("M", "F") or not d.get("full_name"):
        return {"error": "full_name and gender (M/F) are required"}, 400
    with SessionLocal() as db:
        require_role(db, d.get("tree_id"), "editor")
        p = Person(tree_id=d["tree_id"])
        err = _apply_details(p, d)
        if err:
            return {"error": err}, 400
        db.add(p)
        db.flush()
        rel, rid = d.get("relation"), d.get("relative_id")
        if rel and rid:
            relative = db.get(Person, rid)
            if not relative or relative.tree_id not in connected_tree_ids(db, p.tree_id):
                db.rollback()
                return {"error": "That relative isn't in this tree or a linked one"}, 400
            err = _link(db, p, rid, rel)
            if err:
                db.rollback()
                return {"error": err}, 400
        db.commit()
        return jsonify(p.to_dict()), 201


def _link(db, new, rid, rel):
    if rel in ("father", "mother"):
        db.add(Relationship(person_id=new.id, related_id=rid, type="parent"))
    elif rel in ("son", "daughter"):
        db.add(Relationship(person_id=rid, related_id=new.id, type="parent"))
    elif rel in ("husband", "wife"):
        db.add(Relationship(person_id=rid, related_id=new.id, type="spouse"))
    elif rel in ("brother", "sister"):
        # parents may live in a linked tree (e.g. a wife's parents in her family's tree)
        copies = same_person_ids(db, rid)
        parents = db.query(Relationship).filter(
            Relationship.related_id.in_(copies), Relationship.type == "parent").all()
        if not parents:
            return "Add a parent first, so siblings can be linked through them."
        parent_ids = {pr.person_id for pr in parents}
        # the new sibling belongs in the parents' tree
        new.tree_id = db.get(Person, min(parent_ids)).tree_id
        if new.tree_id not in my_tree_ids(db, "editor"):
            name = db.get(Tree, new.tree_id).name
            return f"Siblings go in the parents' tree ({name}). Ask an editor of {name} to add them."
        for pid in parent_ids:
            db.add(Relationship(person_id=pid, related_id=new.id, type="parent"))
    else:
        return f"Unknown relation '{rel}'"
    return None


@app.put("/api/people/<int:pid>")
def edit_person(pid):
    with SessionLocal() as db:
        p = db.get(Person, pid) or abort(404)
        require_role(db, p.tree_id, "editor")
        err = _apply_details(p, request.json)
        if err:
            db.rollback()
            return {"error": err}, 400
        db.commit()
        return jsonify(p.to_dict())


@app.get("/api/people/<int:pid>/photo")
def person_photo(pid):
    with SessionLocal() as db:
        p = db.get(Person, pid) or abort(404)
        if not can_view_person(db, p):
            abort(403)
        if not p.photo:
            abort(404)
        # URL has ?v=<timestamp>, so the browser can cache it for a long time
        return Response(p.photo, mimetype=p.photo_mime,
                        headers={"Cache-Control": "private, max-age=31536000"})


@app.delete("/api/people/<int:pid>")
def delete_person(pid):
    with SessionLocal() as db:
        p = db.get(Person, pid) or abort(404)
        require_role(db, p.tree_id, "editor")
        db.query(Relationship).filter(
            (Relationship.person_id == pid) | (Relationship.related_id == pid)).delete()
        db.query(PersonLink).filter(
            (PersonLink.person_a == pid) | (PersonLink.person_b == pid)).delete()
        db.delete(p)
        db.commit()
        return "", 204


@app.post("/api/relationships")
def add_relationship():
    d = request.json
    if d.get("type") not in ("parent", "spouse"):
        return {"error": "type must be parent or spouse"}, 400
    with SessionLocal() as db:
        a, b = db.get(Person, d.get("person_id")), db.get(Person, d.get("related_id"))
        if not a or not b or a.id == b.id:
            return {"error": "Both people must exist"}, 400
        require_role(db, a.tree_id, "editor")
        require_role(db, b.tree_id, "editor")
        db.add(Relationship(person_id=a.id, related_id=b.id, type=d["type"]))
        db.commit()
        return {"ok": True}, 201


# ---------------------------------------------------------------- CLI

@app.cli.command("init-db")
def init_db():
    """Create tables and load kinship terms."""
    Base.metadata.create_all(engine)
    add_missing_columns()
    with SessionLocal() as db:
        db.query(KinshipTerm).delete()
        db.add_all(KinshipTerm(**t) for t in ALL_TERMS)
        db.commit()
    click.echo(f"Tables ready, {len(ALL_TERMS)} kinship terms loaded.")


@app.cli.command("seed-demo")
def seed_demo():
    """Add a sample 3-generation family."""
    with SessionLocal() as db:
        t = Tree(name="Demo Family")
        db.add(t)
        db.flush()
        data = [  # key, name, gender, birth year
            ("ramasamy", "Ramasamy", "M", 1940), ("lakshmi", "Lakshmi", "F", 1945),
            ("ganesan", "Ganesan", "M", 1942), ("saroja", "Saroja", "F", 1946),
            ("meena", "Meena", "F", 1963), ("murugan", "Murugan", "M", 1965),
            ("selvam", "Selvam", "M", 1970), ("kamala", "Kamala", "F", 1968),
            ("senthil", "Senthil", "M", 1972), ("priya", "Priya", "F", 1974),
            ("ravi", "Ravi", "M", 1960), ("arun", "Arun", "M", 1992),
            ("divya", "Divya", "F", 1996), ("karthik", "Karthik", "M", 1998),
            ("anitha", "Anitha", "F", 1990), ("vijay", "Vijay", "M", 2000),
            ("nila", "Nila", "F", 1997),
        ]
        p = {}
        for key, name, g, y in data:
            p[key] = Person(tree_id=t.id, full_name=name, gender=g, birth_date=date(y, 1, 1))
            db.add(p[key])
        db.flush()

        def parent(par, *kids):
            for k in kids:
                db.add(Relationship(person_id=p[par].id, related_id=p[k].id, type="parent"))

        def married(a, b):
            db.add(Relationship(person_id=p[a].id, related_id=p[b].id, type="spouse"))

        married("ramasamy", "lakshmi"); married("ganesan", "saroja")
        married("murugan", "kamala"); married("selvam", "priya"); married("meena", "ravi")
        for par in ("ramasamy", "lakshmi"):
            parent(par, "meena", "murugan", "selvam")
        for par in ("ganesan", "saroja"):
            parent(par, "kamala", "senthil")
        for par in ("murugan", "kamala"):
            parent(par, "arun", "divya")
        for par in ("selvam", "priya"):
            parent(par, "karthik")
        for par in ("meena", "ravi"):
            parent(par, "anitha", "vijay")
        parent("senthil", "nila")
        db.commit()
        click.echo(f"Demo tree created with id {t.id}")


@app.cli.command("seed-linked-demo")
def seed_linked_demo():
    """Add a second family (Priya's side) and link it to the Demo Family."""
    with SessionLocal() as db:
        demo = db.query(Tree).filter_by(name="Demo Family").first()
        priya = demo and db.query(Person).filter_by(tree_id=demo.id, full_name="Priya").first()
        if not priya:
            raise click.ClickException("Run seed-demo first")
        t = Tree(name="Kumar Family")
        db.add(t)
        db.flush()
        p = {}
        for key, name, g, y in [("kumar", "Kumar", "M", 1945), ("valli", "Valli", "F", 1950),
                                ("balu", "Balu", "M", 1971), ("priya", "Priya", "F", 1974),
                                ("geetha", "Geetha", "F", 1975), ("hari", "Hari", "M", 2001)]:
            p[key] = Person(tree_id=t.id, full_name=name, gender=g, birth_date=date(y, 1, 1))
            db.add(p[key])
        db.flush()
        R = lambda a, b, k: db.add(Relationship(person_id=p[a].id, related_id=p[b].id, type=k))
        R("kumar", "valli", "spouse"); R("balu", "geetha", "spouse")
        for par in ("kumar", "valli"):
            R(par, "balu", "parent"); R(par, "priya", "parent")
        for par in ("balu", "geetha"):
            R(par, "hari", "parent")
        db.add(PersonLink(person_a=priya.id, person_b=p["priya"].id, status="approved"))
        db.commit()
        click.echo(f"Kumar Family created (id {t.id}) and linked through Priya")


if __name__ == "__main__":
    app.run(debug=True)
