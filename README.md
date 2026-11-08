# Uravu (உறவு): family tree with kinship terms

A family tree that shows **what each person calls every relative** in their own
language, and what the relative calls them back. Tamil and English to start.

Click Karthik → his father's elder brother shows **Periyappa (பெரியப்பா)**,
calls back **Magan**. Switch to English → "Uncle" / "Nephew".

## How it's built

```
Browser (static site on Render, never sleeps)
   │  Neon Auth: Google / email sign-in
   │  Neon Data API: reads & writes tables
   ▼
Neon Postgres: Row Level Security decides what each user may see or change
```

There is no server of our own. The rules that used to live in Python now live
in the database (`db/setup.sql`), so they can't be bypassed from the browser.

**Safari:** Neon Auth is reached through this site's own `/api/auth/*` path
(forwarded to Neon by `render.yaml`, and by `vite.config.js` during development).
That keeps the sign-in cookie first-party; Safari blocks it when the app calls
Neon's auth domain directly.

| File | What it does |
|---|---|
| `src/kinship.js` | Finds how two people are related (`F.eB` = father's elder brother) and looks up the term |
| `src/terms.js` | Tamil + English terms. Add a language = add rows |
| `src/view.js` | Merges "same person" cards when linked families are shown |
| `src/api.js` | Answers the page's `/api/...` calls using the Data API |
| `src/app.js`, `index.html` | The tree page |
| `src/auth-page.js`, `auth.html` | Log in, sign up, join-a-tree |
| `db/setup.sql` | Tables, security rules, and the functions the app calls |

### Security rules (Row Level Security)

| Role | Can |
|---|---|
| owner | everything + members, invite links, rename, delete tree |
| editor | add / edit / delete people, link trees |
| viewer | look only |

Members of a tree can also see families **linked** to it. Linking needs editor
access on both trees. Invite links are random, last 7 days and can be revoked.
Trees with no owner go to the Google-verified email set at the end of `db/setup.sql`.

## Setup

### 1. Neon
1. **Auth** → *Enable Neon Auth*. Copy the **Auth URL**.
2. **Data API** → tick *Use Neon Auth*, leave *Grant public schema access* **unticked**
   (the setup script grants exactly what's needed) → *Enable*. Copy the **API URL**.
3. **SQL Editor** → paste all of `db/setup.sql`, change the email on the last line
   to yours → *Run*. Safe to run again; it keeps existing trees, people, links and photos.
4. **Data API** → *Refresh schema cache*.
5. **Auth → Settings**:
   - *Domains*: add your site, e.g. `https://uravu.onrender.com` (and `http://localhost:5173` for development).
   - *OAuth / Google*: use your own Client ID and secret (Neon's shared ones show "Neon" on the Google screen).

### 2. Google Cloud (for your own Google sign-in screen)
Clients → your Web client → *Authorised redirect URIs*: add
`<your Neon Auth URL>/callback/google`.

### 3. Render
New → Blueprint → this repo. Set `VITE_NEON_DATA_API_URL`.
If your Neon Auth URL changes, update the `/api/auth/*` destination in `render.yaml`.

### Run locally
```bash
npm install
cp .env.example .env.local   # paste your two Neon URLs
npm run dev                  # http://localhost:5173
npm test                     # kinship engine: same answers as the old Python version
```

`npm run test:db` checks every security rule against a local Postgres
(set `PGURL`, e.g. `postgresql://postgres@localhost:5432/postgres`).
`tests-db/neon_emulation.sql` imitates the roles and functions Neon provides.

## Next ideas
- Link requests with approval (the other family's owner says yes)
- Hindi, Telugu, Malayalam terms
- Suggest duplicates: same name + birth year in two trees
