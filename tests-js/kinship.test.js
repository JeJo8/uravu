import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { callsEveryone, describe, stripAge } from "../src/kinship.js";
import { loadView, kinInputs } from "../src/view.js";
import { TERMS } from "../src/terms.js";

// parity.json = the old Python engine's answers for every pair in the demo families
const { data, expected } = JSON.parse(readFileSync(new URL("./parity.json", import.meta.url)));

test("JS engine gives exactly the Python answers for every pair", () => {
  let checked = 0;
  for (const linked of [false, true]) {
    const view = loadView(data, 1, linked);
    const [people, rels] = kinInputs(view);
    for (const lang of ["ta", "en"]) {
      for (const ego of Object.keys(people)) {
        const got = callsEveryone(people, rels, TERMS, +ego, lang);
        assert.deepEqual(got, expected[`${+linked}|${lang}|${ego}`], `linked=${linked} lang=${lang} ego=${ego}`);
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
