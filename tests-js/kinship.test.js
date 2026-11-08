import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { callsEveryone, describe, stripAge } from "../src/kinship.js";
import { loadView, kinInputs } from "../src/view.js";
import { TERMS } from "../src/terms.js";

// parity.json = the old Python engine's answers for every pair in the demo families
const { data, expected } = JSON.parse(readFileSync(new URL("./parity.json", import.meta.url)));

// Words deliberately corrected after checking the Tamil Lexicon (the rest must match Python exactly)
const LEXICON_FIXES = new Set(["F.Z.S", "M.B.S", "F.Z.D", "M.B.D", "W.B", "W.Z", "W.Z.H", "H.B", "H.B.W", "B.W"]);
const relaxed = (code, lang) => lang === "ta" && LEXICON_FIXES.has(code.replace(/\b[ey](?=[BZ])/g, ""));
function compare(got, want, lang) {
  for (const id of Object.keys(want)) {
    for (const dir of ["a_calls_b", "b_calls_a"]) {
      const g = got[id]?.[dir], w = want[id][dir];
      if (!w) { assert.equal(g, w); continue; }
      assert.equal(g.code, w.code);
      assert.equal(g.description, w.description);
      if (!relaxed(w.code, lang)) assert.deepEqual(g, w, `${w.code}`);
    }
  }
}

test("JS engine gives the Python answers for every pair", () => {
  let checked = 0;
  for (const linked of [false, true]) {
    const view = loadView(data, 1, linked);
    const [people, rels] = kinInputs(view);
    for (const lang of ["ta", "en"]) {
      for (const ego of Object.keys(people)) {
        const got = callsEveryone(people, rels, TERMS, +ego, lang);
        compare(got, expected[`${+linked}|${lang}|${ego}`], lang);
        checked += Object.keys(got).length;
      }
    }
  }
  assert.ok(checked > 1000, `checked ${checked} pairs`);
});

test("linked view merges the same person and keeps badges", () => {
  for (const linked of [false, true]) {
    const view = loadView(data, 1, linked);
    const slim = view.people.map(p => ({ id: p.id, full_name: p.full_name, tree_name: p.tree_name,
      from_other_tree: p.from_other_tree,
      linked_to: p.linked_to.map(l => ({ person_id: l.person_id, tree_id: l.tree_id, tree_name: l.tree_name })) }));
    assert.deepEqual(slim, expected[`view${+linked}`]);
  }
});

test("spot checks", () => {
  const view = loadView(data, 1, true);
  const [people, rels] = kinInputs(view);
  const id = n => view.people.find(p => p.full_name === n).id;
  const k = callsEveryone(people, rels, TERMS, id("Karthik"), "ta");
  assert.equal(k[id("Selvam")].a_calls_b.term, "Appa");
  assert.equal(k[id("Murugan")].a_calls_b.term, "Periyappa");
  assert.equal(k[id("Balu")].a_calls_b.term, "Maama");
  assert.equal(k[id("Balu")].b_calls_a.term, "Marumagan");
  assert.equal(describe("F.eB.S"), "Father's elder brother's son");
  assert.equal(stripAge("F.eB.yZ"), "F.B.Z");
});

test("Tamil descriptions read naturally", async () => {
  const { describeTamil } = await import("../src/kinship.js");
  assert.equal(describeTamil("F.eB.W.F"), "அப்பாவின் அண்ணனின் மனைவியின் அப்பா");
  assert.equal(describeTamil("M.B.S"), "அம்மாவின் சகோதரனின் மகன்");
  assert.equal(describeTamil("yZ"), "தங்கை");
});

test("Tamil Lexicon corrections", async () => {
  const { lookupTerm } = await import("../src/kinship.js");
  const t = (code, sg, age) => lookupTerm(TERMS, "ta", code, sg, age)?.term_native;
  assert.equal(t("M.B.D", "F", "younger"), "மச்சினி");   // a woman's younger cross cousin (was missing)
  assert.equal(t("F.Z.D", "F", "elder"), "மச்சினி");     // not அண்ணி (that is elder brother's wife)
  assert.equal(t("M.B.D", "M", "elder"), "மதினி");
  assert.equal(t("M.B.S", "F", "younger"), "மச்சான்");
  assert.equal(t("M.B.S", "F", "elder"), "அத்தான்");
  assert.equal(t("W.eZ.H", "M", "any"), "சகலை");
  assert.equal(t("H.eB.W", "F", "any"), "ஓரகத்தி");
  assert.equal(t("yB.W", "M", "any"), "கொழுந்தி");
  assert.equal(t("eB.W", "M", "any"), "அண்ணி");
});
