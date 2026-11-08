/*
 * Kinship engine: works out how person A is related to person B,
 * then looks up what A calls B in a chosen language.
 *
 * Relationship path codes (read left to right, from the speaker):
 *   F = father      M = mother
 *   B = brother     Z = sister      (prefixed e = elder, y = younger)
 *   S = son         D = daughter
 *   H = husband     W = wife
 *
 * Examples:
 *   F.eB   = father's elder brother      (Tamil: Periyappa)
 *   M.B.S  = mother's brother's son      (Tamil: Machan / Athan)
 *
 * people:        Map/obj id -> { gender: "M"|"F", birth_date: "YYYY-MM-DD"|null }
 * relationships: [[person_id, related_id, "parent"|"spouse"], ...]
 *                "parent" means person_id is the parent of related_id
 */

export function buildGraph(people, relationships) {
  const graph = new Map();
  for (const id of Object.keys(people)) graph.set(+id, []);
  for (const [a, b, kind] of relationships) {
    if (!graph.has(a) || !graph.has(b)) continue;
    if (kind === "parent") {
      graph.get(b).push(["parent", a]);   // b goes UP to parent a
      graph.get(a).push(["child", b]);    // a goes DOWN to child b
    } else if (kind === "spouse") {
      graph.get(a).push(["spouse", b]);
      graph.get(b).push(["spouse", a]);
    }
  }
  return graph;
}

/** Shortest path as a list of [stepKind, nodeId]. Breadth-first search. */
export function findPath(graph, start, end) {
  if (start === end) return [];
  const seen = new Set([start]);
  const queue = [[start, []]];
  while (queue.length) {
    const [node, path] = queue.shift();
    // parent/child first, so blood routes win ties over spouse routes (stable sort)
    const edges = [...graph.get(node)].sort((x, y) => (x[0] === "spouse") - (y[0] === "spouse"));
    for (const [kind, next] of edges) {
      if (seen.has(next)) continue;
      const newPath = [...path, [kind, next]];
      if (next === end) return newPath;
      seen.add(next);
      queue.push([next, newPath]);
    }
  }
  return null;
}

/** "e" if person is older than reference, "y" if younger, "" if unknown. */
function agePrefix(person, reference) {
  const a = person.birth_date, b = reference.birth_date;
  if (!a || !b || a === b) return "";
  return a < b ? "e" : "y";
}

/** Turn [[kind, node], ...] into a code like "F.eB.S". */
export function pathToCode(path, start, people) {
  const tokens = [];
  let prev = start;
  for (let i = 0; i < path.length; i++) {
    const [kind, node] = path[i];
    const g = people[node].gender;
    // parent then child = sibling of the previous person
    if (kind === "parent" && i + 1 < path.length && path[i + 1][0] === "child") {
      const sib = path[i + 1][1];
      tokens.push(agePrefix(people[sib], people[prev]) + (people[sib].gender === "M" ? "B" : "Z"));
      prev = sib;
      i++;
      continue;
    }
    if (kind === "parent") tokens.push(g === "M" ? "F" : "M");
    else if (kind === "child") tokens.push(g === "M" ? "S" : "D");
    else tokens.push(g === "M" ? "H" : "W");
    prev = node;
  }
  return tokens.join(".");
}

/** "F.eB.S" -> "F.B.S" (fallback when there's no age-specific term). */
export function stripAge(code) {
  return code.split(".").map(t => (t.length === 2 && "ey".includes(t[0]) ? t.slice(1) : t)).join(".");
}

const WORDS = { F: "father", M: "mother", B: "brother", Z: "sister",
                S: "son", D: "daughter", H: "husband", W: "wife" };

/** "F.eB.S" -> "Father's elder brother's son" (always available). */
export function describe(code) {
  if (!code) return "Self";
  const text = code.split(".").map(t => {
    const age = t.length === 2 ? ({ e: "elder ", y: "younger " }[t[0]] || "") : "";
    return age + WORDS[t.at(-1)];
  }).join("'s ");
  return text[0].toUpperCase() + text.slice(1);
}

// Tamil words for each step: [on its own, "of" form used before the next step]
const TA_WORDS = {
  F: ["அப்பா", "அப்பாவின்"], M: ["அம்மா", "அம்மாவின்"],
  eB: ["அண்ணன்", "அண்ணனின்"], yB: ["தம்பி", "தம்பியின்"], B: ["சகோதரன்", "சகோதரனின்"],
  eZ: ["அக்கா", "அக்காவின்"], yZ: ["தங்கை", "தங்கையின்"], Z: ["சகோதரி", "சகோதரியின்"],
  S: ["மகன்", "மகனின்"], D: ["மகள்", "மகளின்"],
  H: ["கணவர்", "கணவரின்"], W: ["மனைவி", "மனைவியின்"],
};

/** "F.eB.S" -> "அப்பாவின் அண்ணனின் மகன்" (Tamil fallback when there's no single word). */
export function describeTamil(code) {
  if (!code) return "நீங்கள்";
  const parts = code.split(".");
  return parts.map((t, i) => TA_WORDS[t][i === parts.length - 1 ? 0 : 1]).join(" ");
}

/** Most specific matching term wins. */
export function lookupTerm(terms, lang, code, speakerGender, targetAge) {
  let best = null, bestScore = -1;
  [code, stripAge(code)].forEach((c, rank) => {
    for (const t of terms) {
      if (t.language !== lang || t.path_code !== c) continue;
      if (t.speaker_gender !== "any" && t.speaker_gender !== speakerGender) continue;
      if (t.target_age !== "any" && t.target_age !== targetAge) continue;
      const score = (rank === 0 ? 10 : 0) + (t.speaker_gender !== "any" ? 2 : 0) + (t.target_age !== "any" ? 1 : 0);
      if (score > bestScore) { best = t; bestScore = score; }
    }
  });
  return best;
}

function oneWay(graph, people, terms, src, dst, lang) {
  const path = findPath(graph, src, dst);
  if (path === null) return null;
  const code = pathToCode(path, src, people);
  const age = { e: "elder", y: "younger" }[agePrefix(people[dst], people[src])] || "any";
  const t = lookupTerm(terms, lang, code, people[src].gender, age);
  return { code, description: describe(code), term: t ? t.term : null, term_native: t ? t.term_native : null };
}

/** What does A call B, and what does B call A? */
export function relate(people, relationships, terms, a, b, lang = "ta", graph = null) {
  graph = graph || buildGraph(people, relationships);
  return { a_calls_b: oneWay(graph, people, terms, a, b, lang),
           b_calls_a: oneWay(graph, people, terms, b, a, lang) };
}

/** For one selected person: what they call every relative (and back). */
export function callsEveryone(people, relationships, terms, ego, lang = "ta") {
  const graph = buildGraph(people, relationships);
  const out = {};
  for (const id of Object.keys(people)) {
    if (+id !== ego) out[id] = relate(people, relationships, terms, ego, +id, lang, graph);
  }
  return out;
}
