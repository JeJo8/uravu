"""
Kinship engine: works out how Person A is related to Person B,
then looks up what A calls B in a chosen language.

Relationship path codes (read left to right, from the speaker):
  F = father      M = mother
  B = brother     Z = sister      (prefixed e = elder, y = younger)
  S = son         D = daughter
  H = husband     W = wife

Examples:
  F.eB   = father's elder brother      (Tamil: Periyappa)
  M.B.S  = mother's brother's son      (Tamil: Machan / Athan)
"""
from collections import deque
from datetime import date


# ---------------------------------------------------------------- path finding

def build_graph(people, relationships):
    """people: {id: {"gender": "M"/"F", "birth_date": date|None}}
    relationships: list of (person_id, related_id, type)
      type 'parent' => person_id is parent of related_id
      type 'spouse' => person_id and related_id are married
    """
    graph = {pid: [] for pid in people}
    for a, b, kind in relationships:
        if a not in graph or b not in graph:
            continue
        if kind == "parent":
            graph[b].append(("parent", a))   # b goes UP to parent a
            graph[a].append(("child", b))    # a goes DOWN to child b
        elif kind == "spouse":
            graph[a].append(("spouse", b))
            graph[b].append(("spouse", a))
    return graph


def find_path(graph, start, end):
    """Shortest path as a list of (step_kind, node_id). BFS."""
    if start == end:
        return []
    seen = {start}
    queue = deque([(start, [])])
    while queue:
        node, path = queue.popleft()
        # parent/child first, so blood routes win ties over spouse routes
        for kind, nxt in sorted(graph[node], key=lambda e: e[0] == "spouse"):
            if nxt in seen:
                continue
            new_path = path + [(kind, nxt)]
            if nxt == end:
                return new_path
            seen.add(nxt)
            queue.append((nxt, new_path))
    return None


def _age_prefix(person, reference):
    """'e' if person is older than reference, 'y' if younger, '' if unknown."""
    a, b = person.get("birth_date"), reference.get("birth_date")
    if not a or not b or a == b:
        return ""
    return "e" if a < b else "y"


def path_to_code(path, start, people):
    """Turn [(kind, node), ...] into a code like 'F.eB.S'."""
    tokens = []
    prev = start
    i = 0
    while i < len(path):
        kind, node = path[i]
        g = people[node]["gender"]
        # parent then child = sibling of the previous person
        if kind == "parent" and i + 1 < len(path) and path[i + 1][0] == "child":
            sib = path[i + 1][1]
            tokens.append(_age_prefix(people[sib], people[prev]) +
                          ("B" if people[sib]["gender"] == "M" else "Z"))
            prev = sib
            i += 2
            continue
        if kind == "parent":
            tokens.append("F" if g == "M" else "M")
        elif kind == "child":
            tokens.append("S" if g == "M" else "D")
        else:
            tokens.append("H" if g == "M" else "W")
        prev = node
        i += 1
    return ".".join(tokens)


def strip_age(code):
    """'F.eB.S' -> 'F.B.S' (used as a fallback when no age-specific term)."""
    return ".".join(t[1:] if t[0] in "ey" and len(t) == 2 else t
                    for t in code.split("."))


# ---------------------------------------------------------------- descriptions

_WORDS = {"F": "father", "M": "mother", "B": "brother", "Z": "sister",
          "S": "son", "D": "daughter", "H": "husband", "W": "wife"}


def describe(code):
    """'F.eB.S' -> "Father's elder brother's son" (always-available fallback)."""
    if not code:
        return "Self"
    parts = []
    for t in code.split("."):
        age = {"e": "elder ", "y": "younger "}.get(t[0], "") if len(t) == 2 else ""
        parts.append(age + _WORDS[t[-1]])
    text = "'s ".join(parts)
    return text[0].upper() + text[1:]


# ---------------------------------------------------------------- term lookup

def lookup_term(terms, lang, code, speaker_gender, target_age):
    """terms: list of dicts with language, path_code, speaker_gender,
    target_age, term, term_native. Most specific match wins."""
    best, best_score = None, -1
    for candidate_rank, c in enumerate([code, strip_age(code)]):
        for t in terms:
            if t["language"] != lang or t["path_code"] != c:
                continue
            if t["speaker_gender"] not in ("any", speaker_gender):
                continue
            if t["target_age"] not in ("any", target_age):
                continue
            score = (10 if candidate_rank == 0 else 0) \
                + (2 if t["speaker_gender"] != "any" else 0) \
                + (1 if t["target_age"] != "any" else 0)
            if score > best_score:
                best, best_score = t, score
    return best


def relate(people, relationships, terms, a, b, lang="ta"):
    """What does A call B, and what does B call A?"""
    graph = build_graph(people, relationships)
    out = {}
    for label, src, dst in (("a_calls_b", a, b), ("b_calls_a", b, a)):
        path = find_path(graph, src, dst)
        if path is None:
            out[label] = None
            continue
        code = path_to_code(path, src, people)
        age = _age_prefix(people[dst], people[src]) or "any"
        age = {"e": "elder", "y": "younger"}.get(age, "any")
        t = lookup_term(terms, lang, code, people[src]["gender"], age)
        out[label] = {
            "code": code,
            "description": describe(code),
            "term": t["term"] if t else None,
            "term_native": t["term_native"] if t else None,
        }
    return out


def calls_everyone(people, relationships, terms, ego, lang="ta"):
    """For one selected person, what they call every relative (and back)."""
    return {pid: relate(people, relationships, terms, ego, pid, lang)
            for pid in people if pid != ego}
