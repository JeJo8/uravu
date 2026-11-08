import os
from sqlalchemy import (create_engine, Column, Integer, String, Date, Text,
                        ForeignKey, CheckConstraint)
from sqlalchemy.orm import declarative_base, sessionmaker


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
    photo_url = Column(Text)
    __table_args__ = (CheckConstraint("gender IN ('M','F')"),)

    def to_dict(self):
        return {"id": self.id, "tree_id": self.tree_id, "full_name": self.full_name,
                "native_name": self.native_name, "gender": self.gender,
                "birth_date": self.birth_date.isoformat() if self.birth_date else None,
                "photo_url": self.photo_url}


class Relationship(Base):
    __tablename__ = "relationships"
    id = Column(Integer, primary_key=True)
    person_id = Column(Integer, ForeignKey("persons.id", ondelete="CASCADE"), nullable=False)
    related_id = Column(Integer, ForeignKey("persons.id", ondelete="CASCADE"), nullable=False)
    type = Column(String(10), nullable=False)  # 'parent' = person_id is parent of related_id
    __table_args__ = (CheckConstraint("type IN ('parent','spouse')"),)


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
