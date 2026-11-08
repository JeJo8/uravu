# Uravu (உறவு) — family tree with kinship terms

A family tree that shows **what each person calls every relative** in their own
language, and what the relative calls them back. Tamil and English to start.

Click Arun → his father's younger brother shows **Chithappa (சித்தப்பா)**,
calls back **Magan**. Switch to English → "Uncle" / "Nephew".

## How it works

1. **Path finding** (`kinship.py`): BFS through parent/spouse links finds the
   shortest route between two people and encodes it, e.g. `F.yB` = father's
   younger brother, `M.B.D` = mother's brother's daughter. Birth dates decide
   elder (`e`) / younger (`y`).
2. **Term lookup**: the code, the speaker's gender and the relative's age are
   matched against the `kinship_terms` table. No match → a plain description.
3. **Reverse term**: the same lookup run from the other person.

Each person can also have a **phone** (tap to call), **address** (opens Google Maps)
and a **photo** (resized to 400px in the browser, stored in Postgres because
Render's disk is wiped on every deploy).

### Linking family trees
Each family keeps its own tree. When one person belongs to two families
(e.g. Priya is in her husband's tree and her parents' tree), link the two cards
as **the same person**: select her → *Same person in another tree…*.

Tick **Include linked families** to see both trees together. Linked cards merge
into one, so terms work across families: Priya's son → her brother = **Maama**.
Code: `family_view.py` merges linked cards before the kinship engine runs.

Add a language = add rows to `terms_seed.py` (no code changes).
Tamil terms vary by region and family — review and adjust.

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
flask --app app init-db       # tables + kinship terms (uses SQLite locally)
flask --app app seed-demo     # sample 3-generation family
flask --app app seed-linked-demo  # second family, linked through Priya
flask --app app run           # http://127.0.0.1:5000
pytest -q                     # 31 tests
```

## Deploy: Neon + Render

1. **Neon**: create a project → copy the connection string
   (`postgresql://...neon.tech/neondb?sslmode=require`).
2. **GitHub**: push this folder to a new repo.
3. **Render**: New → Blueprint → pick the repo (uses `render.yaml`).
   Paste the Neon string as `DATABASE_URL` when asked.
4. **Family password (recommended):** in Render → Environment add `APP_PASSWORD`.
   The site then asks for a login: username `family`, that password.
   Without it, anyone with the link can see phone numbers and addresses.
5. The build runs `init-db`, which also adds new columns to existing tables.
6. Demo data (Render's free plan has no Shell, so run it on your machine):
   `export DATABASE_URL='<neon string>' && flask --app app seed-demo && flask --app app seed-linked-demo`

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/trees/<id>` | people + relationships |
| GET | `/api/trees/<id>/kinship/<person_id>?lang=ta` | what that person calls everyone |
| GET | `/api/kinship?a=1&b=5&lang=en` | one pair, both directions |
| POST | `/api/people` | add person (+ `relative_id`, `relation`: father/mother/son/daughter/husband/wife/brother/sister) |
| PUT / DELETE | `/api/people/<id>` | edit (incl. `phone`, `address`, `photo` data URL, `remove_photo`) / remove |
| GET | `/api/people/<id>/photo` | the stored photo |
| POST | `/api/relationships` | raw link: `type` parent or spouse |
| GET | `/api/trees/<id>?linked=1` | tree plus every linked family, linked cards merged |
| POST | `/api/trees` | new tree: `name` |
| POST / DELETE | `/api/links`, `/api/links/<id>` | link two cards as the same person (`person_a`, `person_b`) / unlink |

## Next ideas
- Share link + link requests with approval (needs logins)
- Suggest duplicates: same name + birth year in two trees
- Hindi, Telugu, Malayalam terms
- Drag to pan on mobile
