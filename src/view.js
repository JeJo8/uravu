/*
 * Builds what the tree screen shows: one tree, or one tree plus every family
 * connected to it through "same person" links.
 *
 * Linked cards are merged into one node, so the kinship engine walks across
 * families without knowing trees exist: Arun's son -> his mother Kavya
 * (linked to her own family's tree) -> her brother = Maama.
 *
 * `data` holds every row the signed-in user may see (the database's
 * Row Level Security already filtered it):
 *   { trees, persons, relationships, links }
 */

/** Union-find: Map id -> Set of ids that are the same person. */
export function groups(pairs) {
  const parent = new Map();
  const find = x => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const [a, b] of pairs) parent.set(find(a), find(b));
  const members = new Map();
  for (const x of parent.keys()) {
    const r = find(x);
    if (!members.has(r)) members.set(r, new Set());
    members.get(r).add(x);
  }
  const out = new Map();
  for (const m of members.values()) for (const x of m) out.set(x, m);
  return out;
}

/** This tree plus every tree reachable through person links. */
export function connectedTreeIds(data, treeId) {
  const treeOf = new Map(data.persons.map(p => [p.id, p.tree_id]));
  const found = new Set([treeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of data.links) {
      const ta = treeOf.get(l.person_a), tb = treeOf.get(l.person_b);
      if (found.has(ta) && tb !== undefined && !found.has(tb)) { found.add(tb); changed = true; }
      else if (found.has(tb) && ta !== undefined && !found.has(ta)) { found.add(ta); changed = true; }
    }
  }
  return found;
}

/** id plus every card linked to it, in any tree. */
export function samePersonIds(data, id) {
  return groups(data.links.map(l => [l.person_a, l.person_b])).get(id) || new Set([id]);
}

const FILL = ["birth_date", "phone", "address", "native_name"];

export function loadView(data, treeId, includeLinked = false) {
  const treeIds = includeLinked ? connectedTreeIds(data, treeId) : new Set([treeId]);
  const treeNames = new Map(data.trees.map(t => [t.id, t.name]));
  const byId = new Map(data.persons.map(p => [p.id, p]));
  const onScreen = data.persons.filter(p => treeIds.has(p.tree_id));
  const ids = new Set(onScreen.map(p => p.id));

  // merge only cards that are both on screen
  const screenGroups = groups(data.links.filter(l => ids.has(l.person_a) && ids.has(l.person_b))
    .map(l => [l.person_a, l.person_b]));

  // one display card per group: prefer the copy in the tree being viewed
  const alias = new Map();
  for (const id of ids) {
    const group = [...(screenGroups.get(id) || [id])];
    const home = group.filter(g => byId.get(g).tree_id === treeId);
    alias.set(id, Math.min(...(home.length ? home : group)));
  }

  // "linked to" badges: every other copy anywhere, even if not on screen
  const everyone = groups(data.links.map(l => [l.person_a, l.person_b]));
  const linkId = new Map(data.links.map(l => [[l.person_a, l.person_b].sort((x, y) => x - y).join("-"), l.id]));

  const people = [], members = new Map();
  for (const id of [...ids].sort((x, y) => x - y)) {
    if (alias.get(id) !== id) continue;
    const p = byId.get(id);
    const d = { ...p, photo_url: null };
    const copies = [...(everyone.get(id) || [id])].filter(x => x !== id).map(x => byId.get(x)).filter(Boolean);
    for (const c of copies) for (const f of FILL) if (!d[f] && c[f]) d[f] = c[f];
    d.tree_name = treeNames.get(p.tree_id) ?? null;
    d.from_other_tree = p.tree_id !== treeId;
    d.linked_to = copies.map(c => ({
      person_id: c.id, tree_id: c.tree_id, tree_name: treeNames.get(c.tree_id) ?? null,
      link_id: linkId.get([id, c.id].sort((x, y) => x - y).join("-")) ?? null,
    }));
    people.push(d);
    members.set(id, [id, ...copies.map(c => c.id)]);
  }

  const relationships = [], seen = new Set();
  for (const r of data.relationships) {
    if (!ids.has(r.person_id) || !ids.has(r.related_id)) continue;
    const a = alias.get(r.person_id), b = alias.get(r.related_id);
    const key = r.type === "parent" ? [a, b, r.type] : [Math.min(a, b), Math.max(a, b), r.type];
    const k = key.join("|");
    if (a === b || seen.has(k)) continue;
    seen.add(k);
    relationships.push({ person_id: key[0], related_id: key[1], type: r.type });
  }

  return { tree_ids: [...treeIds].sort((x, y) => x - y), people, relationships, alias, members };
}

/** Inputs for the kinship engine. */
export function kinInputs(view) {
  const people = {};
  for (const p of view.people) people[p.id] = { gender: p.gender, birth_date: p.birth_date };
  return [people, view.relationships.map(r => [r.person_id, r.related_id, r.type])];
}
