import os
from sqlalchemy import (create_engine, Column, Integer, String, Date, Text,
                        ForeignKey, CheckConstraint, LargeBinary, DateTime,
                        UniqueConstraint, inspect, text)
from sqlalchemy.orm import declarative_base, sessionmaker, deferred


def _db_url():
    # Neon gives postgresql://... ; SQLAlchemy + psycopg3 wants postgresql+psycopg://
    url = os.environ.get("DATABASE_URL", "sqlite:///uravu.db")
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


engine = create_engine(_db_url(), pool_pre_ping=True)  # pre_ping: Neon sleeps idle connections
SessionLocal = sessionmaker(bind=engine)
Base = declarative_base()


class Tree(Base):
    __tablename__ = "trees"
    id = Column(Integer, primary_key=True)
    name = Column(String(120), nullable=False)


class Person(Base):
    __tablename__ = "persons"
    id = Column(Integer, primary_key=True)
    tree_id = Column(Integer, ForeignKey("trees.id", ondelete="CASCADE"), nullable=False)
    full_name = Column(String(120), nullable=False)
    native_name = Column(String(120))
    gender = Column(String(1), nullable=False)          # 'M' / 'F'
    birth_date = Column(Date)
    photo_url = Column(Text)                            # optional external link
    phone = Column(String(30))
    address = Column(Text)
    # Small resized photo kept in Postgres (Render's disk is wiped on each deploy).
    # deferred = not loaded unless asked for, so tree queries stay fast.
    photo = deferred(Column(LargeBinary))
    photo_mime = Column(String(20))
    photo_updated = Column(DateTime)
    __table_args__ = (CheckConstraint("gender IN ('M','F')"),)

    def to_dict(self):
        if self.photo_updated:
            photo = f"/api/people/{self.id}/photo?v={int(self.photo_updated.timestamp())}"
        else:
            photo = self.photo_url
        return {"id": self.id, "tree_id": self.tree_id, "full_name": self.full_name,
                "native_name": self.native_name, "gender": self.gender,
                "birth_date": self.birth_date.isoformat() if self.birth_date else None,
                "phone": self.phone, "address": self.address, "photo_url": photo}


class Relationship(Base):
    __tablename__ = "relationships"
    id = Column(Integer, primary_key=True)
    person_id = Column(Integer, ForeignKey("persons.id", ondelete="CASCADE"), nullable=False)
    related_id = Column(Integer, ForeignKey("persons.id", ondelete="CASCADE"), nullable=False)
    type = Column(String(10), nullable=False)  # 'parent' = person_id is parent of related_id
    __table_args__ = (CheckConstraint("type IN ('parent','spouse')"),)


class PersonLink(Base):
    """Two cards in different trees that are the same real person
    (e.g. a wife in her husband's tree and in her own family's tree)."""
    __tablename__ = "person_links"
    id = Column(Integer, primary_key=True)
    person_a = Column(Integer, ForeignKey("persons.id", ondelete="CASCADE"), nullable=False)
    person_b = Column(Integer, ForeignKey("persons.id", ondelete="CASCADE"), nullable=False)
    status = Column(String(10), nullable=False, default="approved")  # 'pending' later, with logins
    __table_args__ = (CheckConstraint("person_a <> person_b"),)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String(80), nullable=False)
    email = Column(String(254), nullable=False, unique=True)   # stored lower-case
    password_hash = Column(String(255))        # empty for Google-only accounts
    google_id = Column(String(64))             # Google's permanent user id ("sub")
    created_at = Column(DateTime, nullable=False)

    def to_dict(self):
        return {"id": self.id, "name": self.name, "email": self.email}


class TreeMember(Base):
    __tablename__ = "tree_members"
    id = Column(Integer, primary_key=True)
    tree_id = Column(Integer, ForeignKey("trees.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role = Column(String(10), nullable=False)   # owner / editor / viewer
    __table_args__ = (UniqueConstraint("tree_id", "user_id"),
                      CheckConstraint("role IN ('owner','editor','viewer')"))


class Invite(Base):
    __tablename__ = "invites"
    id = Column(Integer, primary_key=True)
    token = Column(String(64), nullable=False, unique=True)
    tree_id = Column(Integer, ForeignKey("trees.id", ondelete="CASCADE"), nullable=False)
    role = Column(String(10), nullable=False)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    expires_at = Column(DateTime, nullable=False)
    __table_args__ = (CheckConstraint("role IN ('editor','viewer')"),)


class KinshipTerm(Base):
    __tablename__ = "kinship_terms"
    id = Column(Integer, primary_key=True)
    language = Column(String(10), nullable=False)
    path_code = Column(String(40), nullable=False)
    speaker_gender = Column(String(3), nullable=False, default="any")
    target_age = Column(String(10), nullable=False, default="any")
    term = Column(String(80), nullable=False)
    term_native = Column(String(80))

    def to_dict(self):
        return {c: getattr(self, c) for c in
                ("language", "path_code", "speaker_gender", "target_age", "term", "term_native")}


def add_missing_columns():
    """create_all() never alters existing tables, so add new columns by hand.
    Safe to run on every deploy: only adds what's missing."""
    insp = inspect(engine)
    for table in Base.metadata.sorted_tables:
        if not insp.has_table(table.name):
            continue
        existing = {c["name"] for c in insp.get_columns(table.name)}
        for col in table.columns:
            if col.name not in existing:
                ddl = col.type.compile(dialect=engine.dialect)
                with engine.begin() as conn:
                    conn.execute(text(f'ALTER TABLE {table.name} ADD COLUMN {col.name} {ddl}'))

    if engine.dialect.name == "postgresql":
        # columns that became optional (e.g. password for Google-only accounts)
        for table in Base.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            db_cols = {c["name"]: c for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.nullable and col.name in db_cols and not db_cols[col.name]["nullable"]:
                    with engine.begin() as conn:
                        conn.execute(text(f'ALTER TABLE {table.name} ALTER COLUMN {col.name} DROP NOT NULL'))

    if insp.has_table("users"):
        with engine.begin() as conn:
            conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_google_id ON users (google_id)"))
