from datetime import date

import click
from flask import Flask, jsonify, request, render_template, abort

import kinship
from models import (Base, engine, SessionLocal, Tree, Person, Relationship,
                    KinshipTerm)
from terms_seed import ALL_TERMS, LANGUAGES

app = Flask(__name__)


# ---------------------------------------------------------------- helpers

def _date(s):
    return date.fromisoformat(s) if s else None


def load_tree(db, tree_id):
    persons = db.query(Person).filter_by(tree_id=tree_id).all()
    ids = {p.id for p in persons}
    rels = [r for r in db.query(Relationship).all()
            if r.person_id in ids and r.related_id in ids]
    return persons, rels


def kin_inputs(persons, rels):
    people = {p.id: {"gender": p.gender, "birth_date": p.birth_date} for p in persons}
    links = [(r.person_id, r.related_id, r.type) for r in rels]
    return people, links


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
    with SessionLocal() as db:
        return jsonify([{"id": t.id, "name": t.name} for t in db.query(Tree).all()])


@app.get("/api/trees/<int:tree_id>")
def tree(tree_id):
    with SessionLocal() as db:
        t = db.get(Tree, tree_id) or abort(404)
        persons, rels = load_tree(db, tree_id)
        return jsonify({
            "id": t.id, "name": t.name,
            "people": [p.to_dict() for p in persons],
            "relationships": [{"person_id": r.person_id, "related_id": r.related_id,
                               "type": r.type} for r in rels],
        })


@app.get("/api/trees/<int:tree_id>/kinship/<int:person_id>")
def kinship_view(tree_id, person_id):
    """What the selected person calls everyone, and what everyone calls them."""
    lang = request.args.get("lang", "ta")
    with SessionLocal() as db:
        persons, rels = load_tree(db, tree_id)
        people, links = kin_inputs(persons, rels)
        if person_id not in people:
            abort(404)
        result = kinship.calls_everyone(people, links, all_terms(db), person_id, lang)
        return jsonify({str(k): v for k, v in result.items()})


@app.get("/api/kinship")
def kinship_pair():
    """/api/kinship?a=1&b=5&lang=ta"""
    a, b = int(request.args["a"]), int(request.args["b"])
    lang = request.args.get("lang", "ta")
    with SessionLocal() as db:
        pa = db.get(Person, a) or abort(404)
        persons, rels = load_tree(db, pa.tree_id)
        people, links = kin_inputs(persons, rels)
        if b not in people:
            abort(404)
        return jsonify(kinship.relate(people, links, all_terms(db), a, b, lang))


# ---------------------------------------------------------------- API: write

@app.post("/api/trees")
def create_tree():
    with SessionLocal() as db:
        t = Tree(name=request.json.get("name", "My Family"))
        db.add(t)
        db.commit()
        return jsonify({"id": t.id, "name": t.name}), 201


@app.post("/api/people")
def add_person():
    """Body: tree_id, full_name, gender, birth_date?, native_name?,
    and optionally relative_id + relation (father, mother, son, daughter,
    husband, wife, brother, sister) to link the new person in one go."""
    d = request.json
    if d.get("gender") not in ("M", "F") or not d.get("full_name"):
        return {"error": "full_name and gender (M/F) are required"}, 400
    with SessionLocal() as db:
        p = Person(tree_id=d["tree_id"], full_name=d["full_name"],
                   native_name=d.get("native_name"), gender=d["gender"],
                   birth_date=_date(d.get("birth_date")), photo_url=d.get("photo_url"))
        db.add(p)
        db.flush()
        rel, rid = d.get("relation"), d.get("relative_id")
        if rel and rid:
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
        parents = db.query(Relationship).filter_by(related_id=rid, type="parent").all()
        if not parents:
            return "Add a parent first, so siblings can be linked through them."
        for pr in parents:
            db.add(Relationship(person_id=pr.person_id, related_id=new.id, type="parent"))
    else:
        return f"Unknown relation '{rel}'"
    return None


@app.put("/api/people/<int:pid>")
def edit_person(pid):
    with SessionLocal() as db:
        p = db.get(Person, pid) or abort(404)
        for f in ("full_name", "native_name", "gender", "photo_url"):
            if f in request.json:
                setattr(p, f, request.json[f])
        if "birth_date" in request.json:
            p.birth_date = _date(request.json["birth_date"])
        db.commit()
        return jsonify(p.to_dict())


@app.delete("/api/people/<int:pid>")
def delete_person(pid):
    with SessionLocal() as db:
        p = db.get(Person, pid) or abort(404)
        db.query(Relationship).filter(
            (Relationship.person_id == pid) | (Relationship.related_id == pid)).delete()
        db.delete(p)
        db.commit()
        return "", 204


@app.post("/api/relationships")
def add_relationship():
    d = request.json
    if d.get("type") not in ("parent", "spouse"):
        return {"error": "type must be parent or spouse"}, 400
    with SessionLocal() as db:
        db.add(Relationship(person_id=d["person_id"], related_id=d["related_id"], type=d["type"]))
        db.commit()
        return {"ok": True}, 201


# ---------------------------------------------------------------- CLI

@app.cli.command("init-db")
def init_db():
    """Create tables and load kinship terms."""
    Base.metadata.create_all(engine)
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


if __name__ == "__main__":
    app.run(debug=True)
