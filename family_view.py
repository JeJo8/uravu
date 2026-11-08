"""
Builds what the tree screen shows: one tree, or one tree plus every family
connected to it through "same person" links.

Linked cards are merged into one node, so the kinship engine walks across
families without knowing trees exist: Arun's son -> his mother Kavya
(linked to her own family's tree) -> her brother = Maama.
"""
from models import Person, PersonLink, Relationship, Tree


def _groups(pairs):
    """Union-find: {id: frozenset of ids that are the same person}."""
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in pairs:
        parent[find(a)] = find(b)
    members = {}
    for x in parent:
        members.setdefault(find(x), set()).add(x)
    return {x: frozenset(m) for m in members.values() for x in m}


def connected_tree_ids(db, tree_id):
    """This tree plus every tree reachable through person links."""
    links = db.query(PersonLink).all()
    if not links:
        return {tree_id}
    ids = {l.person_a for l in links} | {l.person_b for l in links}
    tree_of = dict(db.query(Person.id, Person.tree_id).filter(Person.id.in_(ids)).all())
    found, changed = {tree_id}, True
    while changed:
        changed = False
        for l in links:
            ta, tb = tree_of.get(l.person_a), tree_of.get(l.person_b)
            if ta in found and tb not in found and tb is not None:
                found.add(tb); changed = True
            elif tb in found and ta not in found and ta is not None:
                found.add(ta); changed = True
    return found


def same_person_ids(db, pid):
    """pid plus every card linked to it, in any tree."""
    pairs = [(l.person_a, l.person_b) for l in db.query(PersonLink).all()]
    return set(_groups(pairs).get(pid, {pid}))


def load_view(db, tree_id, include_linked=False):
    tree_ids = connected_tree_ids(db, tree_id) if include_linked else {tree_id}
    tree_names = {t.id: t.name for t in db.query(Tree).all()}
    persons = db.query(Person).filter(Person.tree_id.in_(tree_ids)).all()
    by_id = {p.id: p for p in persons}
    ids = set(by_id)

    all_links = db.query(PersonLink).all()
    # merge only cards that are both on screen
    groups = _groups([(l.person_a, l.person_b) for l in all_links
                      if l.person_a in ids and l.person_b in ids])

    # one display card per group: prefer the copy in the tree being viewed
    alias = {}
    for pid in ids:
        group = groups.get(pid, {pid})
        home = [g for g in group if by_id[g].tree_id == tree_id]
        alias[pid] = min(home) if home else min(group)

    # "linked to" badges: every other copy anywhere, even if not on screen
    everyone = _groups([(l.person_a, l.person_b) for l in all_links])
    other_ids = {x for pid in ids for x in everyone.get(pid, ())} - ids
    others = {p.id: p for p in db.query(Person).filter(Person.id.in_(other_ids)).all()} \
        if other_ids else {}
    link_id = {frozenset((l.person_a, l.person_b)): l.id for l in all_links}

    people = []
    for pid in sorted(ids):
        if alias[pid] != pid:
            continue
        p = by_id[pid]
        d = p.to_dict()
        group = everyone.get(pid, {pid})
        copies = [by_id.get(x) or others.get(x) for x in group if x != pid]
        # fill gaps (birth date matters for elder/younger terms)
        for c in copies:
            if c is None:
                continue
            for f in ("birth_date", "phone", "address", "native_name", "photo_url"):
                if not d[f] and c.to_dict()[f]:
                    d[f] = c.to_dict()[f]
        d["tree_name"] = tree_names.get(p.tree_id)
        d["from_other_tree"] = p.tree_id != tree_id
        d["linked_to"] = [
            {"person_id": c.id, "tree_id": c.tree_id, "tree_name": tree_names.get(c.tree_id),
             "link_id": link_id.get(frozenset((pid, c.id)))}
            for c in copies if c is not None]
        people.append(d)

    rels, seen = [], set()
    for r in db.query(Relationship).filter(Relationship.person_id.in_(ids)).all():
        if r.related_id not in ids:
            continue
        a, b = alias[r.person_id], alias[r.related_id]
        key = (a, b, r.type) if r.type == "parent" else (min(a, b), max(a, b), r.type)
        if a == b or key in seen:
            continue
        seen.add(key)
        rels.append({"person_id": key[0], "related_id": key[1], "type": r.type})

    return {"tree_ids": sorted(tree_ids), "people": people,
            "relationships": rels, "alias": alias}


def kin_inputs(view):
    from datetime import date
    people = {p["id"]: {"gender": p["gender"],
                        "birth_date": date.fromisoformat(p["birth_date"]) if p["birth_date"] else None}
              for p in view["people"]}
    links = [(r["person_id"], r["related_id"], r["type"]) for r in view["relationships"]]
    return people, links
