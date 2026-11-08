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

Add a language = add rows to `terms_seed.py` (no code changes).
Tamil terms vary by region and family — review and adjust.

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
flask --app app init-db       # tables + kinship terms (uses SQLite locally)
flask --app app seed-demo     # sample 3-generation family
flask --app app run           # http://127.0.0.1:5000
pytest -q                     # 18 tests
```

## Deploy: Neon + Render

1. **Neon**: create a project → copy the connection string
   (`postgresql://...neon.tech/neondb?sslmode=require`).
2. **GitHub**: push this folder to a new repo.
3. **Render**: New → Blueprint → pick the repo (uses `render.yaml`).
   Paste the Neon string as `DATABASE_URL` when asked.
4. The build runs `init-db`. For demo data, run once in the Render shell:
   `flask --app app seed-demo`

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/trees/<id>` | people + relationships |
| GET | `/api/trees/<id>/kinship/<person_id>?lang=ta` | what that person calls everyone |
| GET | `/api/kinship?a=1&b=5&lang=en` | one pair, both directions |
| POST | `/api/people` | add person (+ `relative_id`, `relation`: father/mother/son/daughter/husband/wife/brother/sister) |
| PUT / DELETE | `/api/people/<id>` | edit / remove |
| POST | `/api/relationships` | raw link: `type` parent or spouse |

## Next ideas
- Login + private trees, share link
- Photos (Cloudinary)
- Hindi, Telugu, Malayalam terms
- Edit/delete in the UI, drag to pan on mobile
