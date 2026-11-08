-- =============================================================================
-- Uravu database setup for Neon Auth + Neon Data API
--
-- Run the whole file in the Neon SQL Editor AFTER enabling Neon Auth and the
-- Data API. It is safe to run again (every step checks what already exists),
-- and it upgrades the old Flask database: trees, people, links and photos are
-- kept; old logins, memberships and invites are removed (everyone signs in again).
--
-- 1) Change the email on the LAST LINE to your own Google email first.
-- 2) Select all, Run.
--
-- Security model: the browser talks straight to the database, so every rule
-- lives here as Row Level Security (RLS). Roles per tree:
--   owner  > editor > viewer
-- =============================================================================

BEGIN;   -- all or nothing: if any step fails, the database is left unchanged

-- ---------------------------------------------------------------- 0. checks
DO $$
BEGIN
  IF to_regprocedure('auth.user_id()') IS NULL THEN
    RAISE EXCEPTION 'auth.user_id() is missing. Enable the Data API (with Neon Auth) in the Neon Console first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'Role "authenticated" is missing. Enable the Data API in the Neon Console first.';
  END IF;
  IF to_regclass('neon_auth."user"') IS NULL THEN
    RAISE EXCEPTION 'Table neon_auth."user" is missing. Enable Neon Auth in the Neon Console first.';
  END IF;
END $$;

-- ---------------------------------------------------------------- 1. old Flask-only tables
-- Flask kept its own accounts; Neon Auth replaces them.
DO $$
BEGIN
  -- old memberships/invites point at integer Flask user ids: start them fresh
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'tree_members'
               AND column_name = 'user_id' AND data_type = 'integer') THEN
    DROP TABLE public.invites;
    DROP TABLE public.tree_members;
  END IF;
END $$;
DROP TABLE IF EXISTS public.users;
DROP TABLE IF EXISTS public.kinship_terms;   -- terms now live in the app (src/terms.js)

-- ---------------------------------------------------------------- 2. tables
CREATE TABLE IF NOT EXISTS public.trees (
  id   serial PRIMARY KEY,
  name varchar(120) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.persons (
  id          serial PRIMARY KEY,
  tree_id     integer NOT NULL REFERENCES public.trees(id) ON DELETE CASCADE,
  full_name   varchar(120) NOT NULL,
  native_name varchar(120),
  gender      varchar(1) NOT NULL,
  birth_date  date,
  phone       varchar(30),
  address     text
);
ALTER TABLE public.persons ADD COLUMN IF NOT EXISTS phone varchar(30);
ALTER TABLE public.persons ADD COLUMN IF NOT EXISTS address text;
-- photos are stored as small data URLs (the browser resizes them to 400px)
ALTER TABLE public.persons ADD COLUMN IF NOT EXISTS photo_data text;

-- move Flask's binary photos into photo_data, then drop the old columns
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'persons' AND column_name = 'photo') THEN
    UPDATE public.persons
       SET photo_data = 'data:' || photo_mime || ';base64,'
                        || replace(replace(encode(photo, 'base64'), E'\n', ''), E'\r', '')
     WHERE photo IS NOT NULL AND photo_mime IN ('image/jpeg', 'image/png', 'image/webp')
       AND photo_data IS NULL;
    ALTER TABLE public.persons DROP COLUMN photo;
  END IF;
END $$;
ALTER TABLE public.persons DROP COLUMN IF EXISTS photo_mime;
ALTER TABLE public.persons DROP COLUMN IF EXISTS photo_updated;
ALTER TABLE public.persons DROP COLUMN IF EXISTS photo_url;

CREATE TABLE IF NOT EXISTS public.relationships (
  id         serial PRIMARY KEY,
  person_id  integer NOT NULL REFERENCES public.persons(id) ON DELETE CASCADE,
  related_id integer NOT NULL REFERENCES public.persons(id) ON DELETE CASCADE,
  type       varchar(10) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.person_links (
  id       serial PRIMARY KEY,
  person_a integer NOT NULL REFERENCES public.persons(id) ON DELETE CASCADE,
  person_b integer NOT NULL REFERENCES public.persons(id) ON DELETE CASCADE,
  status   varchar(10) NOT NULL DEFAULT 'approved'
);

CREATE TABLE IF NOT EXISTS public.tree_members (
  id      serial PRIMARY KEY,
  tree_id integer NOT NULL REFERENCES public.trees(id) ON DELETE CASCADE,
  user_id text NOT NULL,                      -- Neon Auth user id (JWT "sub")
  role    varchar(10) NOT NULL,
  UNIQUE (tree_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.invites (
  id         serial PRIMARY KEY,
  -- 64 random hex characters; users can't choose it (no column grant)
  token      text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', '')
                                         || replace(gen_random_uuid()::text, '-', ''),
  tree_id    integer NOT NULL REFERENCES public.trees(id) ON DELETE CASCADE,
  role       varchar(10) NOT NULL,
  created_by text NOT NULL DEFAULT auth.user_id(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);

-- settings only the database owner can read (no grants)
CREATE TABLE IF NOT EXISTS public.app_settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_persons_tree ON public.persons (tree_id);
CREATE INDEX IF NOT EXISTS ix_rel_person ON public.relationships (person_id);
CREATE INDEX IF NOT EXISTS ix_rel_related ON public.relationships (related_id);
CREATE INDEX IF NOT EXISTS ix_links_a ON public.person_links (person_a);
CREATE INDEX IF NOT EXISTS ix_links_b ON public.person_links (person_b);
CREATE INDEX IF NOT EXISTS ix_members_user ON public.tree_members (user_id);

-- ---------------------------------------------------------------- 3. data rules
-- NOT VALID: enforced for new and changed rows, old rows aren't re-checked.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('trees', 'trees_name_ok',
       $c$CHECK (length(btrim(name)) BETWEEN 1 AND 120)$c$),
    ('persons', 'persons_name_ok',
       $c$CHECK (length(btrim(full_name)) BETWEEN 1 AND 120)$c$),
    ('persons', 'persons_gender_ok',
       $c$CHECK (gender IN ('M', 'F'))$c$),
    ('persons', 'persons_phone_ok',
       $c$CHECK (phone IS NULL OR phone ~ '^[0-9+() -]{1,30}$')$c$),
    ('persons', 'persons_address_ok',
       $c$CHECK (address IS NULL OR length(address) <= 500)$c$),
    ('persons', 'persons_photo_ok',
       $c$CHECK (photo_data IS NULL OR (length(photo_data) <= 600000
               AND photo_data ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'))$c$),
    ('relationships', 'relationships_type_ok',
       $c$CHECK (type IN ('parent', 'spouse') AND person_id <> related_id)$c$),
    ('person_links', 'person_links_ok',
       $c$CHECK (person_a <> person_b)$c$),
    ('tree_members', 'tree_members_role_ok',
       $c$CHECK (role IN ('owner', 'editor', 'viewer'))$c$),
    ('invites', 'invites_role_ok',
       $c$CHECK (role IN ('editor', 'viewer'))$c$)
  ) AS t(tbl, name, def)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.name) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s NOT VALID', c.tbl, c.name, c.def);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------- 4. helper functions
-- Kept in a schema the Data API doesn't expose. SECURITY DEFINER lets them read
-- membership rows without tripping over the RLS rules they help to enforce.
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.role_rank(p_role text) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END
$$;

CREATE OR REPLACE FUNCTION private.has_role(p_tree int, p_min text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT private.role_rank(role) FROM tree_members
                    WHERE tree_id = p_tree AND user_id = auth.user_id()), 0)
         >= private.role_rank(p_min)
$$;

CREATE OR REPLACE FUNCTION private.person_tree(p_person int) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT tree_id FROM persons WHERE id = p_person
$$;

CREATE OR REPLACE FUNCTION private.can_edit_person(p_person int) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT private.has_role(private.person_tree(p_person), 'editor')
$$;

-- trees you're a member of, plus every tree joined to them by "same person" links
CREATE OR REPLACE FUNCTION private.visible_tree_ids() RETURNS int[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH RECURSIVE
    edges AS (
      SELECT pa.tree_id AS a, pb.tree_id AS b
        FROM person_links l
        JOIN persons pa ON pa.id = l.person_a
        JOIN persons pb ON pb.id = l.person_b),
    reach(t) AS (
      SELECT tree_id FROM tree_members WHERE user_id = auth.user_id()
      UNION
      SELECT CASE WHEN e.a = r.t THEN e.b ELSE e.a END
        FROM reach r JOIN edges e ON e.a = r.t OR e.b = r.t)
  SELECT coalesce(array_agg(t), '{}') FROM reach
$$;

CREATE OR REPLACE FUNCTION private.my_user() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT to_jsonb(u) FROM neon_auth."user" u WHERE u.id::text = auth.user_id()
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;

-- ---------------------------------------------------------------- 5. integrity triggers
CREATE OR REPLACE FUNCTION private.check_person_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a persons; b persons; group_a int[]; group_b int[];
BEGIN
  SELECT * INTO a FROM persons WHERE id = NEW.person_a;
  SELECT * INTO b FROM persons WHERE id = NEW.person_b;
  IF a.tree_id = b.tree_id THEN
    RAISE EXCEPTION 'Pick someone from a different tree';
  END IF;
  IF a.gender <> b.gender THEN
    RAISE EXCEPTION '% and % have different genders', a.full_name, b.full_name;
  END IF;
  -- everyone already linked to A (in any tree)
  WITH RECURSIVE g(id) AS (
    SELECT NEW.person_a
    UNION
    SELECT CASE WHEN l.person_a = g.id THEN l.person_b ELSE l.person_a END
      FROM g JOIN person_links l ON l.person_a = g.id OR l.person_b = g.id)
  SELECT array_agg(id) INTO group_a FROM g;
  IF NEW.person_b = ANY (group_a) THEN
    RAISE EXCEPTION 'Already linked';
  END IF;
  IF EXISTS (SELECT 1 FROM persons WHERE id = ANY (group_a) AND tree_id = b.tree_id) THEN
    RAISE EXCEPTION '% is already linked to someone in that tree', a.full_name;
  END IF;
  -- ...and the same the other way round (one person can't be two people in a tree)
  WITH RECURSIVE g(id) AS (
    SELECT NEW.person_b
    UNION
    SELECT CASE WHEN l.person_a = g.id THEN l.person_b ELSE l.person_a END
      FROM g JOIN person_links l ON l.person_a = g.id OR l.person_b = g.id)
  SELECT array_agg(id) INTO group_b FROM g;
  IF EXISTS (SELECT 1 FROM persons WHERE id = ANY (group_b) AND tree_id = a.tree_id) THEN
    RAISE EXCEPTION '% is already linked to someone in that tree', b.full_name;
  END IF;
  NEW.status := 'approved';
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS person_links_check ON public.person_links;
CREATE TRIGGER person_links_check BEFORE INSERT ON public.person_links
  FOR EACH ROW EXECUTE FUNCTION private.check_person_link();

-- a tree always keeps at least one owner (unless the whole tree is being deleted)
CREATE OR REPLACE FUNCTION private.keep_an_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role <> 'owner')
     AND EXISTS (SELECT 1 FROM trees WHERE id = OLD.tree_id)
     AND (SELECT count(*) FROM tree_members WHERE tree_id = OLD.tree_id AND role = 'owner') = 1 THEN
    RAISE EXCEPTION 'A tree needs at least one owner. Make someone else owner first.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS tree_members_keep_owner ON public.tree_members;
CREATE TRIGGER tree_members_keep_owner BEFORE UPDATE OR DELETE ON public.tree_members
  FOR EACH ROW EXECUTE FUNCTION private.keep_an_owner();

-- ---------------------------------------------------------------- 6. row level security
ALTER TABLE public.trees         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.persons       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.person_links  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tree_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invites       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings  ENABLE ROW LEVEL SECURITY;   -- no policies = nobody via the API

DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public'
           AND tablename IN ('trees','persons','relationships','person_links','tree_members','invites','app_settings')
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END $$;

-- trees: see your trees and linked families; owners rename/delete. New trees via create_tree().
CREATE POLICY trees_read   ON public.trees FOR SELECT TO authenticated
  USING (id = ANY ((SELECT private.visible_tree_ids())::int[]));
CREATE POLICY trees_rename ON public.trees FOR UPDATE TO authenticated
  USING (private.has_role(id, 'owner')) WITH CHECK (private.has_role(id, 'owner'));
CREATE POLICY trees_delete ON public.trees FOR DELETE TO authenticated
  USING (private.has_role(id, 'owner'));

-- people: viewers read; editors write
CREATE POLICY persons_read   ON public.persons FOR SELECT TO authenticated
  USING (tree_id = ANY ((SELECT private.visible_tree_ids())::int[]));
CREATE POLICY persons_add    ON public.persons FOR INSERT TO authenticated
  WITH CHECK (private.has_role(tree_id, 'editor'));
CREATE POLICY persons_edit   ON public.persons FOR UPDATE TO authenticated
  USING (private.has_role(tree_id, 'editor')) WITH CHECK (private.has_role(tree_id, 'editor'));
CREATE POLICY persons_delete ON public.persons FOR DELETE TO authenticated
  USING (private.has_role(tree_id, 'editor'));

-- parent/spouse links: editors of both people's trees
CREATE POLICY rel_read   ON public.relationships FOR SELECT TO authenticated
  USING (private.person_tree(person_id) = ANY ((SELECT private.visible_tree_ids())::int[])
     AND private.person_tree(related_id) = ANY ((SELECT private.visible_tree_ids())::int[]));
CREATE POLICY rel_add    ON public.relationships FOR INSERT TO authenticated
  WITH CHECK (private.can_edit_person(person_id) AND private.can_edit_person(related_id));
CREATE POLICY rel_delete ON public.relationships FOR DELETE TO authenticated
  USING (private.can_edit_person(person_id) AND private.can_edit_person(related_id));

-- "same person" links: creating one needs editor on both trees (it shares them)
CREATE POLICY links_read   ON public.person_links FOR SELECT TO authenticated
  USING (private.person_tree(person_a) = ANY ((SELECT private.visible_tree_ids())::int[])
      OR private.person_tree(person_b) = ANY ((SELECT private.visible_tree_ids())::int[]));
CREATE POLICY links_add    ON public.person_links FOR INSERT TO authenticated
  WITH CHECK (private.can_edit_person(person_a) AND private.can_edit_person(person_b));
CREATE POLICY links_delete ON public.person_links FOR DELETE TO authenticated
  USING (private.can_edit_person(person_a) OR private.can_edit_person(person_b));

-- members: members see the list; owners change roles and remove; anyone can leave
CREATE POLICY members_read   ON public.tree_members FOR SELECT TO authenticated
  USING (private.has_role(tree_id, 'viewer'));
CREATE POLICY members_role   ON public.tree_members FOR UPDATE TO authenticated
  USING (private.has_role(tree_id, 'owner')) WITH CHECK (private.has_role(tree_id, 'owner'));
CREATE POLICY members_remove ON public.tree_members FOR DELETE TO authenticated
  USING (private.has_role(tree_id, 'owner') OR user_id = auth.user_id());

-- invite links: owners only. Joining goes through accept_invite().
CREATE POLICY invites_read   ON public.invites FOR SELECT TO authenticated
  USING (private.has_role(tree_id, 'owner'));
CREATE POLICY invites_add    ON public.invites FOR INSERT TO authenticated
  WITH CHECK (private.has_role(tree_id, 'owner'));
CREATE POLICY invites_delete ON public.invites FOR DELETE TO authenticated
  USING (private.has_role(tree_id, 'owner'));

-- ---------------------------------------------------------------- 7. table permissions
REVOKE ALL ON public.trees, public.persons, public.relationships, public.person_links,
              public.tree_members, public.invites, public.app_settings
  FROM authenticated, anonymous, PUBLIC;
GRANT SELECT, DELETE ON public.trees TO authenticated;
GRANT UPDATE (name)  ON public.trees TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.persons TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.relationships TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.person_links TO authenticated;
GRANT SELECT, DELETE ON public.tree_members TO authenticated;
GRANT UPDATE (role)  ON public.tree_members TO authenticated;
GRANT SELECT, DELETE ON public.invites TO authenticated;
GRANT INSERT (tree_id, role) ON public.invites TO authenticated;
GRANT USAGE ON SEQUENCE public.persons_id_seq, public.relationships_id_seq,
                        public.person_links_id_seq, public.invites_id_seq TO authenticated;

-- ---------------------------------------------------------------- 8. API functions (called with .rpc())
CREATE OR REPLACE FUNCTION public.create_tree(p_name text) RETURNS public.trees
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t trees;
BEGIN
  IF auth.user_id() IS NULL THEN RAISE EXCEPTION 'Please log in'; END IF;
  IF length(btrim(coalesce(p_name, ''))) = 0 THEN RAISE EXCEPTION 'Give the tree a name'; END IF;
  INSERT INTO trees (name) VALUES (left(btrim(p_name), 120)) RETURNING * INTO t;
  INSERT INTO tree_members (tree_id, user_id, role) VALUES (t.id, auth.user_id(), 'owner');
  RETURN t;
END $$;

-- Trees with no owner (from before logins, or the seed script) go to the
-- account whose verified email matches app_settings.owner_email.
CREATE OR REPLACE FUNCTION public.claim_unowned_trees() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE me jsonb := private.my_user(); owner_email text; n int;
BEGIN
  SELECT lower(value) INTO owner_email FROM app_settings WHERE key = 'owner_email';
  IF me IS NULL OR owner_email IS NULL
     OR lower(me->>'email') <> owner_email
     OR NOT coalesce((me->>'emailVerified')::boolean, (me->>'email_verified')::boolean, false) THEN
    RETURN 0;
  END IF;
  INSERT INTO tree_members (tree_id, user_id, role)
    SELECT t.id, auth.user_id(), 'owner' FROM trees t
     WHERE NOT EXISTS (SELECT 1 FROM tree_members m WHERE m.tree_id = t.id AND m.role = 'owner')
    ON CONFLICT (tree_id, user_id) DO UPDATE SET role = 'owner';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- names come from Neon Auth; only owners see email addresses
CREATE OR REPLACE FUNCTION public.tree_members_list(p_tree int)
RETURNS TABLE (user_id text, name text, email text, role text, is_me boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE is_owner boolean := private.has_role(p_tree, 'owner');
BEGIN
  IF NOT private.has_role(p_tree, 'viewer') THEN
    RAISE EXCEPTION 'You are not a member of this tree';
  END IF;
  RETURN QUERY
    SELECT m.user_id,
           coalesce(nullif(to_jsonb(u)->>'name', ''), split_part(to_jsonb(u)->>'email', '@', 1), 'Unknown')::text,
           CASE WHEN is_owner THEN (to_jsonb(u)->>'email')::text END,
           m.role::text,
           m.user_id = auth.user_id()
      FROM tree_members m
      LEFT JOIN neon_auth."user" u ON u.id::text = m.user_id
     WHERE m.tree_id = p_tree
     ORDER BY 2;
END $$;

-- shown on the join page before accepting
CREATE OR REPLACE FUNCTION public.invite_info(p_token text)
RETURNS TABLE (tree_id int, tree_name text, role text, my_role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.tree_id, t.name::text, i.role::text,
         (SELECT m.role::text FROM tree_members m WHERE m.tree_id = i.tree_id AND m.user_id = auth.user_id())
    FROM invites i JOIN trees t ON t.id = i.tree_id
   WHERE i.token = p_token AND i.expires_at > now()
$$;

CREATE OR REPLACE FUNCTION public.accept_invite(p_token text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE inv invites;
BEGIN
  IF auth.user_id() IS NULL THEN RAISE EXCEPTION 'Please log in'; END IF;
  SELECT * INTO inv FROM invites WHERE token = p_token AND expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This invite link has expired. Ask for a new one.';
  END IF;
  INSERT INTO tree_members (tree_id, user_id, role) VALUES (inv.tree_id, auth.user_id(), inv.role)
  ON CONFLICT (tree_id, user_id) DO UPDATE
    SET role = EXCLUDED.role
    WHERE private.role_rank(EXCLUDED.role) > private.role_rank(tree_members.role);  -- never downgrade
  RETURN inv.tree_id;
END $$;

REVOKE ALL ON FUNCTION public.create_tree(text), public.claim_unowned_trees(),
                       public.tree_members_list(int), public.invite_info(text),
                       public.accept_invite(text) FROM PUBLIC, anonymous;
GRANT EXECUTE ON FUNCTION public.create_tree(text), public.claim_unowned_trees(),
                          public.tree_members_list(int), public.invite_info(text),
                          public.accept_invite(text) TO authenticated;

-- ---------------------------------------------------------------- 9. your email
-- The account with this (Google-verified) email becomes owner of every tree
-- that has no owner yet, e.g. the trees made with the old Flask app.
INSERT INTO public.app_settings (key, value) VALUES ('owner_email', 'CHANGE-ME@gmail.com')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

COMMIT;
