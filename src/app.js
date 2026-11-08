/*
 * Uravu main page. Talks to the database only through api() (src/api.js),
 * which answers the same /api/... calls the old Flask server did.
 */
import { api } from "./api.js";
import { setupPwa } from "./pwa.js";

const CARD_W = 168, CARD_H = 104, GAP_X = 28, GAP_Y = 72, PAD = 40;
const VIEWS = ["around", "list", "tree"];
let savedView = null;
try { savedView = localStorage.getItem("uravu-view"); } catch {}
let state = { tree: null, selected: null, lang: "ta", kin: {}, kinFor: null, linked: false, trees: [], me: null, zoom: 1, dims: null,
              view: VIEWS.includes(savedView) ? savedView : "around" };
const isPhone = () => matchMedia("(max-width: 760px)").matches;
const JSON_HEADERS = { "Content-Type": "application/json" };
const canEdit = treeId => (state.tree?.editable_tree_ids || []).includes(treeId);

const $ = s => document.querySelector(s);

async function init() {
  const langs = await api("/api/languages");
  const NATIVE = { ta: "தமிழ்" };
  $("#langSel").innerHTML = Object.entries(langs)
    .map(([k, v]) => `<label${NATIVE[k] ? ' class="ta"' : ""}><input type="radio" name="lang" value="${k}"${k === state.lang ? " checked" : ""}>${esc(NATIVE[k] || v)}</label>`).join("");
  state.me = await api("/api/auth/me");
  $("#who").textContent = state.me.name;
  await refreshTrees();
  const wanted = +new URLSearchParams(location.search).get("tree");
  const first = state.trees.find(t => t.id === wanted) || state.trees[0];
  if (first) await loadTree(first.id); else showNoTrees();
  $("#treeSel").onchange = e => { state.selected = null; clearDetails(); loadTree(e.target.value); };
  $("#langSel").onchange = e => { state.lang = e.target.value; select(state.selected); };
  $("#canvas").onclick = e => { if (e.target.id === "svg" || e.target.id === "canvas") setSheet(false); };
  $("#linkedToggle").onchange = e => { state.linked = e.target.checked; loadTree(state.tree.id); };
  $(`#viewSel input[value="${state.view}"]`).checked = true;
  $("#viewSel").onchange = e => setView(e.target.value);
  $("#listSearch").oninput = () => drawList();
}

async function refreshTrees() {
  state.trees = await api("/api/trees");
  $("#treeSel").innerHTML = state.trees
    .map(t => `<option value="${t.id}">${esc(t.name)} (${t.people})${t.role === "viewer" ? " · view only" : ""}</option>`).join("");
  if (state.tree) $("#treeSel").value = state.tree.id;
}

function showNoTrees() {
  state.tree = null;
  $("#svg").setAttribute("width", 560); $("#svg").setAttribute("height", 120);
  $("#svg").innerHTML = `<text class="empty" x="30" y="50">You don't have a family tree yet.</text>
    <text class="empty" x="30" y="76">Click “+ New tree”, or open an invite link from your family.</text>`;
  $("#addSection").hidden = true; $("#membersBtn").hidden = true;
  $("#treeSel").hidden = true; $("#zoomBar").hidden = true; $("#sheetActions").hidden = true; $("#viewSel").hidden = true;
}

async function loadTree(id) {
  const fresh = state.tree?.id !== +id;
  state.tree = await api(`/api/trees/${id}${state.linked ? "?linked=1" : ""}`);
  $("#treeSel").hidden = false; $("#membersBtn").hidden = false;
  $("#zoomBar").hidden = !state.tree.people.length;
  $("#treeSel").value = state.tree.id;
  const editor = state.tree.role !== "viewer";
  $("#addSection").hidden = !editor;
  $("#viewerNote").hidden = editor;
  state.kin = {}; state.kinFor = null;
  showView();
  draw();
  if (fresh) fitZoom(isPhone() ? 0.5 : 0.45);
  if (state.selected && byId(state.selected)) select(state.selected);
  else if (state.selected) { state.selected = null; clearDetails(); }
}

function clearDetails() {
  $("#details").hidden = true;
  $("#dPhoto").hidden = $("#dSub").hidden = $("#viewpoint").hidden = true;
  $("#selTitle").textContent = "Pick a person";
  $("#selHint").innerHTML = "Tap anyone in the tree. Every card then shows what <b>they</b> call that relative, and what the relative calls them back.";
  $("#addTitle").textContent = "Add a relative";
  $("#sheetDetails").hidden = true;
}

// ---------- phone bottom sheet
function setSheet(open) {
  $("#sheet").classList.toggle("open", open);
  $("#sheetHandle").setAttribute("aria-expanded", open);
  $("#sheetHandle").setAttribute("aria-label", open ? "Collapse panel" : "Expand panel");
  if (!open) $("#sheet .sheet-body").scrollTop = 0;
}
$("#sheetHandle").onclick = () => setSheet(!$("#sheet").classList.contains("open"));
$("#sheetDetails").onclick = () => setSheet(true);
$("#sheetAdd").onclick = () => {
  setSheet(true);
  setTimeout(() => $("#addSection").scrollIntoView({ block: "start", behavior: "smooth" }), 260);
};

// relation chips: tap the chosen one again to clear it
function syncShareChips() {
  const rel = document.querySelector("#relChips input:checked")?.value;
  $("#shareChips").hidden = rel !== "brother" && rel !== "sister";
}
document.querySelectorAll("#relChips input").forEach(r => {
  r.onpointerdown = () => { r.dataset.was = r.checked; };
  r.onclick = () => { if (r.dataset.was === "true") r.checked = false; r.dataset.was = r.checked; syncShareChips(); };
  r.addEventListener("change", syncShareChips);
});

// ---------- zoom
function applyZoom() {
  if (!state.dims) return;
  const svg = $("#svg"), z = state.zoom;
  svg.setAttribute("width", Math.round(state.dims.W * z));
  svg.setAttribute("height", Math.round(state.dims.H * z));
  $("#zoomLvl").textContent = Math.round(z * 100) + "%";
}
function setZoom(z) {
  const c = $("#canvas"), old = state.zoom;
  const cx = (c.scrollLeft + c.clientWidth / 2) / old, cy = (c.scrollTop + c.clientHeight / 2) / old;
  state.zoom = Math.min(1.6, Math.max(0.35, z));
  applyZoom();
  c.scrollLeft = cx * state.zoom - c.clientWidth / 2;
  c.scrollTop = cy * state.zoom - c.clientHeight / 2;
}
function fitZoom(floor = 0.35) {
  if (!state.dims) return;
  const c = $("#canvas");
  const visibleH = isPhone() ? c.clientHeight - 200 : c.clientHeight - 128;
  const fit = Math.min((c.clientWidth - 16) / state.dims.W, visibleH / state.dims.H);
  state.zoom = Math.max(floor, Math.min(1, fit));
  applyZoom();
}
function focusSelected() {
  const g = state.selected && $(`#svg .card[data-id="${state.selected}"]`);
  if (!g) return;
  const c = $("#canvas"), r = g.getBoundingClientRect(), cr = c.getBoundingClientRect();
  const visibleH = isPhone() ? c.clientHeight - 180 : c.clientHeight;
  c.scrollTo({ left: c.scrollLeft + r.left - cr.left - (c.clientWidth - r.width) / 2,
               top: c.scrollTop + r.top - cr.top - (visibleH - r.height) / 2, behavior: "smooth" });
}
$("#zoomIn").onclick = () => setZoom(state.zoom * 1.2);
$("#zoomOut").onclick = () => setZoom(state.zoom / 1.2);
$("#zoomFit").onclick = () => fitZoom();
$("#zoomFocus").onclick = () => focusSelected();

$("#newTreeBtn").onclick = async () => {
  const name = prompt("Name for the new family tree (e.g. Kumar Family):");
  if (!name || !name.trim()) return;
  const t = await api("/api/trees", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name }) });
  state.selected = null; clearDetails();
  state.tree = { id: t.id };
  await refreshTrees();
  await loadTree(t.id);
};

const byId = id => state.tree.people.find(p => p.id === +id);

// ---------- layout: generations from parent/child links, couples side by side
function layout(people, rels) {
  const parentsOf = {}, kidsOf = {}, spousesOf = {};
  people.forEach(p => { parentsOf[p.id] = []; kidsOf[p.id] = []; spousesOf[p.id] = []; });
  rels.forEach(r => {
    if (r.type === "parent") { parentsOf[r.related_id].push(r.person_id); kidsOf[r.person_id].push(r.related_id); }
    else { spousesOf[r.person_id].push(r.related_id); spousesOf[r.related_id].push(r.person_id); }
  });
  const gen = {};
  for (const p of people) {
    if (gen[p.id] !== undefined) continue;
    gen[p.id] = 0; const q = [p.id];
    while (q.length) {
      const n = q.shift();
      const push = (m, g) => { if (gen[m] === undefined) { gen[m] = g; q.push(m); } };
      parentsOf[n].forEach(m => push(m, gen[n] - 1));
      kidsOf[n].forEach(m => push(m, gen[n] + 1));
      spousesOf[n].forEach(m => push(m, gen[n]));
    }
  }
  const levels = [...new Set(Object.values(gen))].sort((a, b) => a - b);
  const pos = {}, order = {};
  let maxCols = 0;
  levels.forEach((lv, row) => {
    const rowPeople = people.filter(p => gen[p.id] === lv);
    const key = id => {
      const ps = parentsOf[id].filter(x => order[x] !== undefined);
      return ps.length ? ps.reduce((s, x) => s + order[x], 0) / ps.length : null;
    };
    // build couple units
    const placed = new Set(), units = [];
    const birth = id => byIdIn(people, id).birth_date || "";
    rowPeople.slice().sort((a, b) => (birth(a.id) > birth(b.id) ? 1 : -1)).forEach(p => {
      if (placed.has(p.id)) return;
      const unit = [p.id, ...spousesOf[p.id].filter(s => gen[s] === lv && !placed.has(s))];
      unit.forEach(u => placed.add(u));
      const keys = unit.map(key).filter(k => k !== null);
      units.push({ unit, k: keys.length ? Math.min(...keys) : 1e9 + units.length });
    });
    units.sort((a, b) => a.k - b.k);
    // inside a couple, put the blood-linked person nearest to their parents
    const flat = units.flatMap(u => u.unit.sort((a, b) =>
      ((key(a) ?? 1e9) - (key(b) ?? 1e9)) || (byIdIn(people, a).gender === "M" ? -1 : 1)));
    flat.forEach((id, i) => { order[id] = i; pos[id] = { x: i, row }; });
    maxCols = Math.max(maxCols, flat.length);
  });
  // centre each row
  levels.forEach((lv, row) => {
    const ids = Object.keys(pos).filter(id => pos[id].row === row);
    const off = (maxCols - ids.length) / 2;
    ids.forEach(id => {
      pos[id].px = PAD + (pos[id].x + off) * (CARD_W + GAP_X);
      pos[id].py = PAD + row * (CARD_H + GAP_Y);
    });
  });
  return { pos, parentsOf, maxCols, rows: levels.length };
}
const byIdIn = (people, id) => people.find(p => p.id === +id);

function draw() {
  if (state.view === "list") return drawList();
  if (state.view === "around") return drawAround();
  drawTree();
}

function drawTree() {
  const { people, relationships } = state.tree;
  const svg = $("#svg");
  const L = layout(people, relationships);
  const W = PAD * 2 + L.maxCols * (CARD_W + GAP_X) - GAP_X, H = PAD * 2 + L.rows * (CARD_H + GAP_Y) - GAP_Y;
  state.dims = { W, H };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  applyZoom();
  let out = "";
  // parent → child links (from couple midpoint); each family gets its own bus height
  const families = {};
  people.forEach(c => {
    const ps = L.parentsOf[c.id]; if (!ps.length) return;
    const fam = ps.slice().sort().join("-");
    if (!(fam in families)) families[fam] = Object.keys(families).length;
    const mx = ps.reduce((s, p) => s + L.pos[p].px, 0) / ps.length + CARD_W / 2;
    const my = L.pos[ps[0]].py + CARD_H;
    const cx = L.pos[c.id].px + CARD_W / 2, cy = L.pos[c.id].py;
    const midY = my + 20 + (families[fam] % 4) * 10;
    out += `<path class="link" d="M${mx},${my} V${midY} H${cx} V${cy}"/>`;
  });
  relationships.filter(r => r.type === "spouse").forEach(r => {
    const a = L.pos[r.person_id], b = L.pos[r.related_id];
    const [l, rr] = a.px < b.px ? [a, b] : [b, a];
    out += `<line class="spouse" x1="${l.px + CARD_W}" y1="${l.py + CARD_H / 2}" x2="${rr.px}" y2="${rr.py + CARD_H / 2}"/>`;
  });
  people.forEach(p => {
    const { px, py } = L.pos[p.id];
    const k = state.kin[p.id];
    const sel = state.selected === p.id;
    let termText = "";
    if (sel) termText = `<text class="term" x="14" y="82">Selected</text>`;
    else if (k?.a_calls_b) {
      const a = k.a_calls_b, b = k.b_calls_a;
      const main = trim(a.term || a.description, 17);
      const native = a.term_native && a.term_native !== a.term && main.length + a.term_native.length <= 22
        ? ` <tspan class="native">${esc(a.term_native)}</tspan>` : "";
      termText = `<text class="term" x="14" y="76" data-w="${CARD_W - 26}">${esc(main)}${native}</text>`;
      // what they call the selected person, shown in its own colour (no label)
      if (b) termText += `<text class="back" x="14" y="93" data-w="${CARD_W - 26}">${esc(trim(b.term || b.description, state.lang === "ta" ? 16 : 22))}</text>`;
    }
    const year = p.birth_date ? p.birth_date.slice(0, 4) : "";
    const avatar = p.photo_url
      ? `<image href="${esc(p.photo_url)}" x="10" y="10" width="36" height="36" preserveAspectRatio="xMidYMid slice" clip-path="url(#avClip)"/>`
      : `<text class="initial" x="28" y="33" text-anchor="middle">${esc(p.full_name[0] || "?")}</text>`;
    const linkedBadge = p.linked_to?.length
      ? `<use class="badge" href="#i-link" x="${CARD_W - 26}" y="10" width="16" height="16"/>` : "";
    const sub = p.from_other_tree ? `${year} · ${p.tree_name}` : year;
    const label = `${p.full_name}${k?.a_calls_b ? ", " + (k.a_calls_b.term || k.a_calls_b.description) : ""}${sel ? ", selected" : ""}`;
    out += `<g class="card ${p.gender}${sel ? " selected" : ""}${p.from_other_tree ? " other" : ""}" data-id="${p.id}" transform="translate(${px},${py})" tabindex="0" role="button" aria-label="${esc(label)}">
      <title>${esc(k?.a_calls_b?.description || p.full_name)}</title>
      ${sel ? `<rect class="ring" x="-3" y="-3" width="${CARD_W + 6}" height="${CARD_H + 6}" rx="16"/>` : ""}
      <rect class="box" width="${CARD_W}" height="${CARD_H}" rx="14"/>
      <circle class="avatar-bg" cx="28" cy="28" r="18"/>${avatar}
      <text class="name" x="54" y="25" data-w="${CARD_W - 54 - (p.linked_to?.length ? 30 : 12)}">${esc(p.full_name)}</text>
      <text class="year" x="54" y="42" data-w="${CARD_W - 66}">${esc(sub)}</text>
      <line class="rule" x1="12" x2="${CARD_W - 12}" y1="56" y2="56"/>
      ${linkedBadge}${termText}</g>`;
  });
  if (!people.length) {
    out = `<text class="empty" x="20" y="40">This tree is empty.</text><text class="empty" x="20" y="64">${isPhone() ? "Tap “Add relative” below" : "Add the first person on the right"}.</text>`;
    state.dims = null; svg.removeAttribute("viewBox");
    svg.setAttribute("width", 360); svg.setAttribute("height", 100);
  }
  svg.innerHTML = `<defs><clipPath id="avClip" clipPathUnits="userSpaceOnUse">
    <circle cx="28" cy="28" r="18"/></clipPath></defs>` + out;
  fitCardText(svg);
  svg.querySelectorAll(".card").forEach(g => {
    g.onclick = e => { e.stopPropagation(); select(+g.dataset.id); };
    g.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(+g.dataset.id); } };
  });
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const trim = (s, n) => s.length > n ? s.slice(0, n - 1) + "…" : s;

// Web fonts change text widths once they arrive, so measure again then.
document.fonts?.ready.then(() => { if (state.tree?.people?.length) draw(); });

// Letter counts don't predict width (Tamil, wide capitals), so measure each
// card line after drawing and shorten it until it fits inside the box.
function fitCardText(svg) {
  for (const t of svg.querySelectorAll("text[data-w]")) {
    const max = +t.dataset.w;
    if (t.getComputedTextLength() <= max) continue;
    const extra = t.querySelector("tspan");
    if (extra) { extra.remove(); if (t.getComputedTextLength() <= max) continue; }
    const full = t.textContent.trimEnd();
    let lo = 0, hi = full.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      t.textContent = full.slice(0, mid).trimEnd() + "…";
      if (t.getComputedTextLength() <= max) lo = mid; else hi = mid - 1;
    }
    t.textContent = full.slice(0, lo).trimEnd() + "…";
  }
}

async function select(id) {
  if (!id) return;
  state.selected = id;
  const p = byId(id);
  const first = p.full_name.split(" ")[0];
  $("#selTitle").textContent = p.full_name;
  $("#selHint").textContent = state.view === "tree"
    ? `Cards show what ${first} calls each relative.` + (isPhone() ? "" : " Hover a card for the full relationship.")
    : `Everyone is shown as ${first} would call them. Tap someone to see the family from their side.`;
  $("#viewpointText").innerHTML = `<span class="key a">${state.lang === "ta" ? `${esc(first)} அழைப்பது` : `${esc(first)} calls them`}</span>`
    + ` · <span class="key b">${state.lang === "ta" ? `அவர்கள் ${esc(first)}-ஐ அழைப்பது` : `they call ${esc(first)}`}</span>`;
  $("#viewpoint").hidden = false;
  $("#addTitle").textContent = `Add a relative of ${first}`;
  $("#sheetDetails").hidden = false; $("#sheetActions").hidden = false;
  showDetails(p);
  const kin = await api(`/api/trees/${state.tree.id}/kinship/${id}?lang=${state.lang}${state.linked ? "&linked=1" : ""}`);
  if (state.selected !== id) return;   // another person was picked meanwhile
  const recentre = state.view === "around" && state.kinFor !== id;
  state.kin = kin; state.kinFor = id;
  draw();
  if (recentre) { fitZoom(0.8); centreCanvas(); }
  const g = $(`#svg .card[data-id="${id}"]`);
  if (g) g.focus({ preventScroll: true });
}

function showDetails(p) {
  $("#details").hidden = false;
  $("#editForm").hidden = true;
  $("#dPhoto").innerHTML = p.photo_url
    ? `<img src="${esc(p.photo_url)}" alt="${esc(p.full_name)}">`
    : `<div class="ph ${p.gender}">${esc(p.full_name[0] || "?")}</div>`;
  $("#dPhoto").hidden = false;
  $("#dSub").textContent = p.native_name || "";
  $("#dSub").hidden = !p.native_name;
  $("#dBorn").textContent = p.birth_date || "—";
  $("#dPhone").innerHTML = p.phone
    ? `<a href="tel:${esc(p.phone.replace(/[^+\d]/g, ""))}">${esc(p.phone)}</a>` : "—";
  $("#dAddress").innerHTML = p.address
    ? `<a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}">${esc(p.address)}</a>`
    : "—";
  showConnect(p);
  const editable = canEdit(p.tree_id);
  $("#editBtn").hidden = $("#delBtn").hidden = !editable;
  showLinks(p);
}

// ---------- connect two people already in the tree (e.g. mark Kalaimani as Sekar's wife)
const RELATIONS = { F: [["wife", "Wife"], ["mother", "Mother"], ["daughter", "Daughter"]],
                    M: [["husband", "Husband"], ["father", "Father"], ["son", "Son"]] };

function showConnect(p) {
  const f = $("#connectForm");
  const others = state.tree.people.filter(x => x.id !== p.id && canEdit(x.tree_id))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  $("#connectBox").hidden = !canEdit(p.tree_id) || !others.length;
  $("#connectErr").textContent = "";
  f.elements.person.innerHTML = `<option value="">Pick a person</option>` + others.map(x =>
    `<option value="${x.id}">${esc(x.full_name)}${x.birth_date ? " (" + x.birth_date.slice(0, 4) + ")" : ""}</option>`).join("");
  fillRelations(p, null);
}

function fillRelations(p, other) {
  const sel = $("#connectForm").elements.relation;
  const opts = other ? RELATIONS[other.gender] : [];
  sel.innerHTML = other
    ? opts.map(([v, label]) => `<option value="${v}">is ${esc(p.full_name)}'s ${label.toLowerCase()}</option>`).join("")
    : `<option value="">…is ${esc(p.full_name)}'s</option>`;
  sel.disabled = !other;
}

$("#connectForm").elements.person.onchange = e => {
  fillRelations(byId(state.selected), byId(+e.target.value));
};

$("#connectForm").onsubmit = async e => {
  e.preventDefault();
  const f = e.target, err = $("#connectErr");
  err.textContent = "";
  if (!f.elements.person.value || !f.elements.relation.value) return;
  const body = { person_id: state.selected, other_id: +f.elements.person.value, relation: f.elements.relation.value };
  const post = extra => api("/api/relationships", { method: "POST", headers: JSON_HEADERS,
                                                     body: JSON.stringify({ ...body, ...extra }) });
  try {
    const { suggestions } = await post({ dry_run: true });
    let include = false;
    if (suggestions.length) {
      const list = suggestions.map(s => `• ${s.parent_name} as ${s.child_name}'s ${byId(s.parent).gender === "F" ? "mother" : "father"}`).join("\n");
      include = confirm(`Also connect their children?\n\n${list}`);
    }
    await post({ include_children: include });
    $("#connectBox").open = false;
    await loadTree(state.tree.id);
  } catch (ex) { err.textContent = ex.message; }
};

function showLinks(p) {
  const box = $("#linkList");
  box.hidden = !p.linked_to?.length;
  box.innerHTML = (p.linked_to || []).map(l => `<div class="item">
      <span><svg class="i"><use href="#i-link"/></svg><span>Same person in <b>${esc(l.tree_name)}</b></span></span>
      ${state.trees.some(t => t.id === l.tree_id) ? `<button type="button" data-open="${l.tree_id}:${l.person_id}">Open</button>` : ""}
      ${l.link_id && (canEdit(p.tree_id) || canEdit(l.tree_id)) ? `<button type="button" class="danger" data-unlink="${l.link_id}">Unlink</button>` : ""}
    </div>`).join("");
  box.querySelectorAll("[data-open]").forEach(b => b.onclick = async () => {
    const [tid, pid] = b.dataset.open.split(":").map(Number);
    state.selected = pid;
    await loadTree(tid);
  });
  box.querySelectorAll("[data-unlink]").forEach(b => b.onclick = async () => {
    if (!confirm("Remove this link? Both people stay in their own trees.")) return;
    await api(`/api/links/${b.dataset.unlink}`, { method: "DELETE" });
    await loadTree(state.tree.id);
  });
  // link form: other trees, same-gender people
  const f = $("#linkForm"), mine = new Set([p.tree_id, ...(p.linked_to || []).map(l => l.tree_id)]);
  const others = state.trees.filter(t => !mine.has(t.id) && t.role !== "viewer");
  $("#linkBox").hidden = !others.length || !canEdit(p.tree_id);
  $("#linkErr").textContent = "";
  f.elements.tree.innerHTML = `<option value="">— pick a tree —</option>` +
    others.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  f.elements.person.innerHTML = "";
}

$("#linkForm").elements.tree.onchange = async e => {
  const sel = $("#linkForm").elements.person, me = byId(state.selected);
  sel.innerHTML = "";
  if (!e.target.value) return;
  const t = await api(`/api/trees/${e.target.value}`);
  const matches = t.people.filter(x => x.gender === me.gender);
  sel.innerHTML = matches.length
    ? matches.map(x => `<option value="${x.id}">${esc(x.full_name)}${x.birth_date ? " (" + x.birth_date.slice(0, 4) + ")" : ""}</option>`).join("")
    : `<option value="">No ${me.gender === "M" ? "men" : "women"} in that tree yet</option>`;
};

$("#linkForm").onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  if (!f.elements.person.value) return;
  try {
    await api("/api/links", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person_a: state.selected, person_b: +f.elements.person.value }) });
    $("#linkBox").open = false;
    await loadTree(state.tree.id);
  } catch (err) { $("#linkErr").textContent = err.message; }
};

// Shrink photos in the browser (max 400px JPEG) so uploads stay small
async function readPhoto(file) {
  if (!file || !file.size) return null;
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 400 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.82);
}

$("#editBtn").onclick = () => {
  const p = byId(state.selected), f = $("#editForm");
  for (const k of ["full_name", "native_name", "gender", "birth_date", "phone", "address"])
    f.elements[k].value = p[k] || "";
  f.elements.photo.value = ""; f.elements.remove_photo.checked = false;
  $("#editErr").textContent = "";
  f.hidden = false;
  setSheet(true);
  f.scrollIntoView({ block: "nearest", behavior: "smooth" });
};
$("#cancelEdit").onclick = () => { $("#editForm").hidden = true; };

$("#editForm").onsubmit = async e => {
  e.preventDefault();
  const f = e.target, body = {};
  for (const k of ["full_name", "native_name", "gender", "phone", "address"]) body[k] = f.elements[k].value;
  body.birth_date = f.elements.birth_date.value || null;
  body.remove_photo = f.elements.remove_photo.checked;
  try {
    body.photo = await readPhoto(f.elements.photo.files[0]);
    await api(`/api/people/${state.selected}`, { method: "PUT",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await loadTree(state.tree.id);
  } catch (err) { $("#editErr").textContent = err.message; }
};

$("#delBtn").onclick = async () => {
  const p = byId(state.selected);
  if (!confirm(`Delete ${p.full_name} and their links? This can't be undone.`)) return;
  await api(`/api/people/${p.id}`, { method: "DELETE" });
  state.selected = null; state.kin = {};
  clearDetails();
  await loadTree(state.tree.id);
  await refreshTrees();
};

$("#addForm").onsubmit = async e => {
  e.preventDefault();
  $("#err").textContent = "";
  const f = Object.fromEntries(new FormData(e.target));
  if (f.relation && !state.selected) { $("#err").textContent = "Select a person in the tree first."; return; }
  try {
    f.photo = await readPhoto(e.target.elements.photo.files[0]);
    await api("/api/people", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...f, relative_id: state.selected,
                             tree_id: (f.relation && byId(state.selected)?.tree_id) || state.tree.id,
                             birth_date: f.birth_date || null, relation: f.relation || null }) });
    e.target.reset();
    syncShareChips();
    setSheet(false);
    await loadTree(state.tree.id);
    await refreshTrees();
  } catch (err) { $("#err").textContent = err.message; }
};

// ---------- account + members
$("#logoutBtn").onclick = async () => {
  await api("/api/auth/logout", { method: "POST", headers: JSON_HEADERS, body: "{}" });
  location.href = "/login";
};

$("#membersBtn").onclick = () => openMembers();
$("#mClose").onclick = () => $("#membersDlg").close();

async function openMembers() {
  $("#mErr").textContent = "";
  const t = state.tree, m = await api(`/api/trees/${t.id}/members`);
  const owner = m.my_role === "owner";
  $("#mTitle").textContent = `${t.name} · you are ${m.my_role}`;
  $("#mRename").hidden = !owner;
  $("#renameForm").elements.name.value = t.name;
  $("#mInvites").hidden = !owner;
  $("#delTreeBtn").hidden = !owner;
  $("#mList").innerHTML = m.members.map(x => `<div class="mrow">
      <div class="grow"><b>${esc(x.name)}</b>${x.is_me ? " (you)" : ""}${x.email ? `<small>${esc(x.email)}</small>` : ""}</div>
      ${owner ? `<select data-role="${x.user_id}" aria-label="Role for ${esc(x.name)}">
          ${["owner", "editor", "viewer"].map(r => `<option ${r === x.role ? "selected" : ""}>${r}</option>`).join("")}</select>`
        : `<span class="pill">${x.role}</span>`}
      ${owner && !x.is_me ? `<button type="button" class="danger" data-remove="${x.user_id}">Remove</button>` : ""}
    </div>`).join("");
  $("#mList").querySelectorAll("[data-role]").forEach(sel => sel.onchange = () =>
    memberAction(`/api/trees/${t.id}/members/${sel.dataset.role}`, "PUT", { role: sel.value }));
  $("#mList").querySelectorAll("[data-remove]").forEach(b => b.onclick = () => {
    if (confirm("Remove this person's access to the tree?"))
      memberAction(`/api/trees/${t.id}/members/${b.dataset.remove}`, "DELETE");
  });
  showInvites(m.invites || []);
  if (!$("#membersDlg").open) $("#membersDlg").showModal();
}

async function memberAction(url, method, body) {
  try {
    await api(url, { method, headers: JSON_HEADERS, body: body ? JSON.stringify(body) : undefined });
  } catch (err) { $("#mErr").textContent = err.message; }
  await openMembers();
}

function showInvites(invites) {
  $("#invList").innerHTML = invites.map(i => {
    const url = location.origin + i.url;
    const msg = encodeURIComponent(`Join our family tree "${state.tree.name}" on Uravu: ${url}`);
    return `<div class="mrow"><div class="grow"><span class="pill">${i.role}</span>
        <div class="invite-url">${esc(url)}</div><small>Expires ${i.expires_at.slice(0, 10)}</small></div>
      <button type="button" data-copy="${esc(url)}">Copy</button>
      <a class="btn" href="https://wa.me/?text=${msg}" target="_blank" rel="noopener">WhatsApp</a>
      <button type="button" class="danger" data-revoke="${i.id}">Revoke</button></div>`;
  }).join("");
  $("#invList").querySelectorAll("[data-copy]").forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied"; }
    catch { prompt("Copy this link:", b.dataset.copy); }
  });
  $("#invList").querySelectorAll("[data-revoke]").forEach(b => b.onclick = () =>
    memberAction(`/api/trees/${state.tree.id}/invites/${b.dataset.revoke}`, "DELETE"));
}

$("#invBtn").onclick = () =>
  memberAction(`/api/trees/${state.tree.id}/invites`, "POST", { role: $("#invRole").value });

$("#renameForm").onsubmit = async e => {
  e.preventDefault();
  await memberAction(`/api/trees/${state.tree.id}`, "PUT", { name: e.target.elements.name.value });
  await refreshTrees(); await loadTree(state.tree.id); await openMembers();
};

$("#leaveBtn").onclick = async () => {
  if (!confirm("Leave this tree? You'll need a new invite to come back.")) return;
  try {
    await api(`/api/trees/${state.tree.id}/members/${state.me.id}`, { method: "DELETE" });
    location.href = "/";
  } catch (err) { $("#mErr").textContent = err.message; }
};

$("#delTreeBtn").onclick = async () => {
  const name = state.tree.name;
  if (prompt(`This deletes "${name}" and everyone in it, for all members. Type the tree name to confirm:`) !== name) return;
  try {
    await api(`/api/trees/${state.tree.id}`, { method: "DELETE" });
    location.href = "/";
  } catch (err) { $("#mErr").textContent = err.message; }
};

init().catch(err => {
  if (err.message !== "Please log in") {   // that one already redirected to the login page
    console.error(err);
    $("#svg").innerHTML = `<text class="empty" x="30" y="50">${esc(err.message)}</text>`;
  }
});

setupPwa(document.getElementById("installBtn"));

// ---------- views: around-me circles, grouped list, full tree
function setView(v) {
  state.view = v;
  try { localStorage.setItem("uravu-view", v); } catch {}
  showView();
  if (!state.tree) return;
  draw();
  if (v === "tree") fitZoom(isPhone() ? 0.5 : 0.45);
  if (v === "around") { fitZoom(0.8); centreCanvas(); }
  if (state.selected) select(state.selected);
}
function showView() {
  const list = state.view === "list";
  $("#list").hidden = !list;
  $("#canvas").hidden = list;
  $("#zoomBar").hidden = list || !state.tree?.people.length;
  $("#viewSel").hidden = !state.tree?.people.length;
}
function centreCanvas() {
  // put the person in the middle of what's visible (above the phone's bottom sheet)
  const me = $("#svg .card.me");
  if (!me) return;
  const c = $("#canvas"), r = me.getBoundingClientRect(), cr = c.getBoundingClientRect();
  const visibleH = isPhone() ? c.clientHeight - 180 : c.clientHeight;
  c.scrollLeft += r.left - cr.left - (c.clientWidth - r.width) / 2;
  c.scrollTop += r.top - cr.top - (visibleH - r.height) / 2;
}

/** Who sits in the middle when nobody is picked: you, if you're in the tree; else the best-connected person. */
function defaultEgo() {
  const people = state.tree.people;
  const mine = people.find(p => p.full_name.trim().toLowerCase() === (state.me?.name || "").trim().toLowerCase());
  if (mine) return mine.id;
  const deg = {};
  for (const r of state.tree.relationships) { deg[r.person_id] = (deg[r.person_id] || 0) + 1; deg[r.related_id] = (deg[r.related_id] || 0) + 1; }
  return people.slice().sort((a, b) => (deg[b.id] || 0) - (deg[a.id] || 0))[0].id;
}

/** Steps in a kinship code ("F.eB.S" = 3); 0 when not connected. */
const steps = k => k?.a_calls_b?.code ? k.a_calls_b.code.split(".").length : 0;
const firstStep = k => (k?.a_calls_b?.code || "").split(".")[0].replace(/^[ey]/, "");
const termOf = k => k?.a_calls_b ? (k.a_calls_b.term || k.a_calls_b.description) : "";
const backOf = k => k?.b_calls_a ? (k.b_calls_a.term || k.b_calls_a.description) : "";
// Where each side of the family sits, in degrees clockwise from the top:
// father's side upper left, mother's upper right, siblings left, spouse right, children below.
const SIDE = { F: -50, M: 50, B: -110, Z: -110, H: 110, W: 110, S: 180, D: 180 };

/** Needs the kinship answers for the selected person; asks for them if missing. */
function egoReady() {
  const people = state.tree.people;
  if (!people.length) return false;
  if (!state.selected || !byId(state.selected)) { select(defaultEgo()); return false; }
  return state.kinFor === state.selected;
}

function drawAround() {
  const svg = $("#svg");
  if (!state.tree.people.length) return drawTree();   // shows the empty-tree message
  if (!egoReady()) { svg.innerHTML = ""; return; }
  const RINGS = 3, NODE = 112;   // NODE = room each bubble needs along its circle
  const ego = byId(state.selected);
  const rings = Array.from({ length: RINGS }, () => []);
  let further = 0;
  for (const p of state.tree.people) {
    if (p.id === ego.id) continue;
    const k = state.kin[p.id], n = steps(k);
    if (n >= 1 && n <= RINGS) rings[n - 1].push(p); else further++;
  }
  // radius grows with how many people share a circle, so bubbles never overlap
  const radii = [];
  rings.forEach((ps, i) => {
    const need = ps.length * NODE / (2 * Math.PI);
    radii.push(Math.max(i ? radii[i - 1] + 118 : 128, need));
  });
  const used = rings.map((ps, i) => ps.length ? radii[i] : 0);
  const R = Math.max(...used, 0) + 74;
  const W = R * 2, H = R * 2 + (further ? 40 : 0), cx = R, cy = R;
  state.dims = { W, H };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  applyZoom();

  const avatar = (p, r) => p.photo_url
    ? `<image href="${esc(p.photo_url)}" x="${-r}" y="${-r}" width="${2 * r}" height="${2 * r}" preserveAspectRatio="xMidYMid slice" clip-path="url(#bub${r})"/>`
    : `<text class="initial" x="0" y="${Math.round(r * 0.3)}" text-anchor="middle">${esc(p.full_name[0] || "?")}</text>`;
  let out = `<defs><clipPath id="bub22" clipPathUnits="userSpaceOnUse"><circle r="22"/></clipPath>
    <clipPath id="bub34" clipPathUnits="userSpaceOnUse"><circle r="34"/></clipPath></defs>`;
  rings.forEach((ps, i) => { if (ps.length) out += `<circle class="orbit" cx="${cx}" cy="${cy}" r="${radii[i]}"/>`; });

  rings.forEach((ps, i) => {
    if (!ps.length) return;
    const pref = p => SIDE[firstStep(state.kin[p.id])] ?? 0;
    ps.sort((a, b) => pref(a) - pref(b) || state.kin[a.id].a_calls_b.code.localeCompare(state.kin[b.id].a_calls_b.code)
      || (a.birth_date || "9").localeCompare(b.birth_date || "9"));
    // spread evenly, then turn the whole circle so people land near their side
    const step = 360 / ps.length;
    let sx = 0, sy = 0;
    ps.forEach((p, j) => { const d = (pref(p) - j * step) * Math.PI / 180; sx += Math.cos(d); sy += Math.sin(d); });
    const turn = ps.length === 1 ? pref(ps[0]) : Math.atan2(sy, sx) * 180 / Math.PI;
    ps.forEach((p, j) => {
      const a = (turn + j * step) * Math.PI / 180;
      const x = cx + radii[i] * Math.sin(a), y = cy - radii[i] * Math.cos(a);
      const k = state.kin[p.id];
      const label = `${p.full_name}, ${termOf(k)}. They call ${ego.full_name.split(" ")[0]}: ${backOf(k)}`;
      out += `<g class="card bubble ${p.gender}${p.from_other_tree ? " other" : ""}" data-id="${p.id}" transform="translate(${x.toFixed(1)},${(y - 14).toFixed(1)})" tabindex="0" role="button" aria-label="${esc(label)}">
        <title>${esc(label)}</title>
        <circle class="avatar-bg" r="22"/>${avatar(p, 22)}
        <text class="term" y="42" text-anchor="middle" data-w="${NODE - 8}">${esc(termOf(k))}</text>
        <text class="name" y="58" text-anchor="middle" data-w="${NODE - 8}">${esc(p.full_name)}</text></g>`;
    });
  });

  out += `<g class="card me ${ego.gender}" data-id="${ego.id}" transform="translate(${cx},${cy - 12})" tabindex="0" role="button" aria-label="${esc(ego.full_name)}, in the centre">
    <circle class="halo" r="42"/><circle class="avatar-bg" r="34"/>${ego.photo_url ? avatar(ego, 34) : `<text class="initial" y="9" text-anchor="middle">${esc(ego.full_name[0] || "?")}</text>`}
    <text class="name" y="58" text-anchor="middle" data-w="${NODE + 20}">${esc(ego.full_name)}</text></g>`;
  if (further) out += `<text class="more" x="${cx}" y="${H - 14}" text-anchor="middle">${further} more relative${further > 1 ? "s" : ""} further away · see List</text>`;
  if (!rings.some(r => r.length)) out += `<text class="more" x="${cx}" y="${cy + 90}" text-anchor="middle">No relatives added yet</text>`;

  svg.innerHTML = out;
  fitCardText(svg);
  svg.querySelectorAll(".card").forEach(g => {
    g.onclick = e => { e.stopPropagation(); if (+g.dataset.id !== state.selected) select(+g.dataset.id); else setSheet(true); };
    g.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); g.onclick(e); } };
  });
}

// list order inside a group: parents, spouse, siblings, children
const RANK = { F: 0, M: 1, H: 2, W: 2, B: 3, Z: 3, S: 4, D: 4 };
const GROUPS = [
  ["close", "Close family"], ["F", "Father's side"], ["M", "Mother's side"], ["spouse", "Spouse's family"],
  ["sib", "Brothers' and sisters' families"], ["kids", "Children's families"], ["none", "Not connected yet"],
];
function groupOf(k) {
  const n = steps(k);
  if (!n) return "none";
  if (n === 1) return "close";
  const f = firstStep(k);
  return f === "F" || f === "M" ? f : f === "H" || f === "W" ? "spouse" : f === "S" || f === "D" ? "kids" : "sib";
}

function drawList() {
  const body = $("#listBody");
  if (!state.tree.people.length) { body.innerHTML = `<p class="list-empty">This tree is empty.</p>`; return; }
  if (!egoReady()) { body.innerHTML = ""; return; }
  const ego = byId(state.selected);
  const q = $("#listSearch").value.trim().toLowerCase();
  const rows = {};
  for (const p of state.tree.people) {
    if (p.id === ego.id) continue;
    const k = state.kin[p.id];
    const hay = [p.full_name, p.native_name, termOf(k), k?.a_calls_b?.description].join(" ").toLowerCase();
    if (q && !hay.includes(q)) continue;
    (rows[groupOf(k)] ||= []).push(p);
  }
  const row = p => {
    const k = state.kin[p.id], year = p.birth_date ? p.birth_date.slice(0, 4) : "";
    const sub = [p.full_name, year, p.from_other_tree ? p.tree_name : ""].filter(Boolean).join(" · ");
    const av = p.photo_url ? `<img src="${esc(p.photo_url)}" alt="">` : esc(p.full_name[0] || "?");
    return `<button type="button" class="lrow" data-id="${p.id}">
      <span class="av ${p.gender}">${av}</span>
      <span class="mid"><span class="t">${esc(termOf(k) || "—")}</span><span class="n">${esc(sub)}</span></span>
      ${backOf(k) ? `<span class="back"><b>${esc(backOf(k))}</b></span>` : ""}</button>`;
  };
  const html = GROUPS.filter(([g]) => rows[g]?.length).map(([g, title]) => {
    const rank = p => RANK[firstStep(state.kin[p.id])] ?? 9;
    const ps = rows[g].sort((a, b) => steps(state.kin[a.id]) - steps(state.kin[b.id]) || rank(a) - rank(b)
      || (state.kin[a.id]?.a_calls_b?.code || "").localeCompare(state.kin[b.id]?.a_calls_b?.code || "")
      || (a.birth_date || "9").localeCompare(b.birth_date || "9"));
    return `<section class="lgroup"><h2>${title} <span>${ps.length}</span></h2><div class="lrows">${ps.map(row).join("")}</div></section>`;
  }).join("");
  body.innerHTML = `<p class="hint" style="margin:4px 4px 0">As <b>${esc(ego.full_name)}</b> would call them. Tap someone to see it from their side.</p>`
    + (html || `<p class="list-empty">No one matches “${esc(q)}”.</p>`);
  body.querySelectorAll(".lrow").forEach(b => b.onclick = () => { select(+b.dataset.id); $("#list").scrollTop = 0; });
}
