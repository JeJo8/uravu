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

### Accounts and sharing
Everyone signs in with **Google** (one tap) or with name, email and password
(stored hashed). If someone signs in with Google using the email of an existing
account, the two are joined and the old password is removed, because email
sign-ups are never verified and Google's are. You only see
trees you're a member of. Roles per tree:

| Role | Can |
|---|---|
| owner | everything + members, invite links, rename, delete tree |
| editor | add / edit / delete people, link trees |
| viewer | look only |

Owners create **invite links** (👥 Members → Create invite link) for editors or
viewers. Links last 7 days and can be revoked. Linking two trees needs editor
access on both, and lets members of either tree see the other in the
"Include linked families" view.

Trees with no owner (made before logins, or by the seed commands) are given to
the account with `OWNER_EMAIL`, or to the first account if that isn't set.

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
pytest -q                     # 50 tests
```

## Deploy: Neon + Render

1. **Neon**: create a project → copy the connection string
   (`postgresql://...neon.tech/neondb?sslmode=require`).
2. **GitHub**: push this folder to a new repo.
3. **Render**: New → Blueprint → pick the repo (uses `render.yaml`).
   Paste the Neon string as `DATABASE_URL` when asked.
4. **Accounts:** Render generates `SECRET_KEY`. Set `OWNER_EMAIL` to your email,
   then sign up with that email so the existing trees become yours.
5. **Google sign-in** (optional, free):
   1. console.cloud.google.com → new project → *Google Auth Platform*.
   2. Branding: app name, support email. Audience: **External**, then **Publish**.
   3. Clients → Create → *Web application*. Authorised redirect URIs:
      `https://<your-app>.onrender.com/auth/google/callback` and
      `http://127.0.0.1:5000/auth/google/callback`.
   4. Put the Client ID and Secret in Render as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
6. The build runs `init-db`, which also adds new columns to existing tables.
7. Demo data (Render's free plan has no Shell, so run it on your machine):
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
| POST | `/api/auth/signup`, `/login`, `/logout`, `/password` | accounts |
| GET / PUT / DELETE | `/api/trees/<id>/members[/<user_id>]` | list, change role, remove / leave |
| POST / DELETE | `/api/trees/<id>/invites[/<id>]` | create / revoke invite link |
| POST | `/api/invites/<token>/accept` | join a tree |
| PUT / DELETE | `/api/trees/<id>` | rename / delete tree (owner) |

All API calls need a login; writes must be JSON (blocks cross-site form posts).

## Next ideas
- Link requests with approval (other family's owner says yes)
- Password reset by email
- Suggest duplicates: same name + birth year in two trees
- Hindi, Telugu, Malayalam terms
- Drag to pan on mobile
