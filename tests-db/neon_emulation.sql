-- Imitates what Neon creates when you enable Neon Auth + the Data API,
-- so db/setup.sql can be tested on a plain local Postgres.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anonymous') THEN CREATE ROLE anonymous NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT; END IF;
END $$;
GRANT authenticated, anonymous TO authenticator;
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO authenticated, anonymous;
-- Neon's auth.user_id() returns the JWT "sub" claim
CREATE OR REPLACE FUNCTION auth.user_id() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub' $$;
CREATE SCHEMA IF NOT EXISTS neon_auth;
CREATE TABLE IF NOT EXISTS neon_auth."user" (
  id text PRIMARY KEY, name text, email text UNIQUE, "emailVerified" boolean DEFAULT false);
