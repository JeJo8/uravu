-- Uravu schema for Neon (Postgres). `flask --app app init-db` does this for you;
-- this file is for reference or pasting into the Neon SQL editor.

CREATE TABLE kinship_terms (
	id SERIAL NOT NULL, 
	language VARCHAR(10) NOT NULL, 
	path_code VARCHAR(40) NOT NULL, 
	speaker_gender VARCHAR(3) NOT NULL, 
	target_age VARCHAR(10) NOT NULL, 
	term VARCHAR(80) NOT NULL, 
	term_native VARCHAR(80), 
	PRIMARY KEY (id)
);

CREATE TABLE trees (
	id SERIAL NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE users (
	id SERIAL NOT NULL, 
	name VARCHAR(80) NOT NULL, 
	email VARCHAR(254) NOT NULL, 
	password_hash VARCHAR(255) NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (email)
);

CREATE TABLE invites (
	id SERIAL NOT NULL, 
	token VARCHAR(64) NOT NULL, 
	tree_id INTEGER NOT NULL, 
	role VARCHAR(10) NOT NULL, 
	created_by INTEGER, 
	expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	CHECK (role IN ('editor','viewer')), 
	UNIQUE (token), 
	FOREIGN KEY(tree_id) REFERENCES trees (id) ON DELETE CASCADE, 
	FOREIGN KEY(created_by) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE persons (
	id SERIAL NOT NULL, 
	tree_id INTEGER NOT NULL, 
	full_name VARCHAR(120) NOT NULL, 
	native_name VARCHAR(120), 
	gender VARCHAR(1) NOT NULL, 
	birth_date DATE, 
	photo_url TEXT, 
	phone VARCHAR(30), 
	address TEXT, 
	photo BYTEA, 
	photo_mime VARCHAR(20), 
	photo_updated TIMESTAMP WITHOUT TIME ZONE, 
	PRIMARY KEY (id), 
	CHECK (gender IN ('M','F')), 
	FOREIGN KEY(tree_id) REFERENCES trees (id) ON DELETE CASCADE
);

CREATE TABLE tree_members (
	id SERIAL NOT NULL, 
	tree_id INTEGER NOT NULL, 
	user_id INTEGER NOT NULL, 
	role VARCHAR(10) NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (tree_id, user_id), 
	CHECK (role IN ('owner','editor','viewer')), 
	FOREIGN KEY(tree_id) REFERENCES trees (id) ON DELETE CASCADE, 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE person_links (
	id SERIAL NOT NULL, 
	person_a INTEGER NOT NULL, 
	person_b INTEGER NOT NULL, 
	status VARCHAR(10) NOT NULL, 
	PRIMARY KEY (id), 
	CHECK (person_a <> person_b), 
	FOREIGN KEY(person_a) REFERENCES persons (id) ON DELETE CASCADE, 
	FOREIGN KEY(person_b) REFERENCES persons (id) ON DELETE CASCADE
);

CREATE TABLE relationships (
	id SERIAL NOT NULL, 
	person_id INTEGER NOT NULL, 
	related_id INTEGER NOT NULL, 
	type VARCHAR(10) NOT NULL, 
	PRIMARY KEY (id), 
	CHECK (type IN ('parent','spouse')), 
	FOREIGN KEY(person_id) REFERENCES persons (id) ON DELETE CASCADE, 
	FOREIGN KEY(related_id) REFERENCES persons (id) ON DELETE CASCADE
);

CREATE INDEX ix_rel_person ON relationships(person_id);
CREATE INDEX ix_rel_related ON relationships(related_id);
CREATE INDEX ix_terms_lookup ON kinship_terms(language, path_code);
CREATE INDEX ix_members_user ON tree_members(user_id);
