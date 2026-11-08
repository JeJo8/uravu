import os
import sys

import tempfile
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(tempfile.mkdtemp(), "test.db")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest  # noqa: E402
from app import app, init_db, seed_demo  # noqa: E402
from models import SessionLocal, Person  # noqa: E402


@pytest.fixture(scope="module")
def client():
    runner = app.test_cli_runner()
    assert "kinship terms loaded" in runner.invoke(init_db).output
    assert "Demo tree created" in runner.invoke(seed_demo).output
    return app.test_client()


def pid(name):
    with SessionLocal() as db:
        return db.query(Person).filter_by(full_name=name).one().id


def calls(client, a, b, lang="ta"):
    r = client.get(f"/api/kinship?a={pid(a)}&b={pid(b)}&lang={lang}").json
    return r["a_calls_b"]["term"], r["b_calls_a"]["term"]


@pytest.mark.parametrize("a,b,a_calls,b_calls", [
    ("Arun", "Murugan", "Appa", "Magan"),
    ("Arun", "Ramasamy", "Thatha", "Peran"),
    ("Arun", "Selvam", "Chithappa", "Magan"),       # father's younger brother
    ("Arun", "Meena", "Athai", "Marumagan"),        # father's sister
    ("Arun", "Ravi", "Maama", "Marumagan"),         # father's sister's husband
    ("Arun", "Senthil", "Maama", "Marumagan"),      # mother's brother
    ("Arun", "Ganesan", "Thatha", "Peran"),         # mother's father
    ("Arun", "Divya", "Thangai", "Anna"),
    ("Arun", "Karthik", "Thambi", "Anna"),          # parallel cousin = sibling
    ("Arun", "Anitha", "Machini", "Athan"),         # cross cousins
    ("Divya", "Vijay", "Athan", "Machini"),
    ("Arun", "Nila", "Machini", "Athan"),           # mother's brother's daughter
    ("Kamala", "Ramasamy", "Maamanar", "Marumagal"),
    ("Karthik", "Murugan", "Periyappa", "Magan"),
    ("Karthik", "Kamala", "Periyamma", "Magan"),
])
def test_tamil_terms(client, a, b, a_calls, b_calls):
    assert calls(client, a, b) == (a_calls, b_calls)


def test_english_and_codes(client):
    r = client.get(f"/api/kinship?a={pid('Arun')}&b={pid('Karthik')}&lang=en").json
    assert r["a_calls_b"]["code"] == "F.yB.S"
    assert r["a_calls_b"]["term"] == "Cousin"
    assert r["a_calls_b"]["description"] == "Father's younger brother's son"
    assert calls(client, "Arun", "Selvam", "en") == ("Uncle", "Nephew")


def test_kinship_view_covers_everyone(client):
    tree = client.get("/api/trees/1").json
    view = client.get(f"/api/trees/1/kinship/{pid('Arun')}?lang=ta").json
    assert len(view) == len(tree["people"]) - 1


def test_add_relatives(client):
    r = client.post("/api/people", json={"tree_id": 1, "full_name": "Kavin", "gender": "M",
                                         "birth_date": "2024-05-01",
                                         "relative_id": pid("Arun"), "relation": "son"})
    assert r.status_code == 201
    assert calls(client, "Kavin", "Murugan") == ("Thatha", "Peran")
    assert calls(client, "Kavin", "Divya")[0] == "Athai"
    # sibling with no parents -> helpful error
    r = client.post("/api/people", json={"tree_id": 1, "full_name": "X", "gender": "M",
                                         "relative_id": pid("Ramasamy"), "relation": "brother"})
    assert r.status_code == 400 and "parent" in r.json["error"]


# ---------------------------------------------------------------- contact details & photos
import base64  # noqa: E402

TINY_PNG = "data:image/png;base64," + base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")).decode()


def test_phone_address_photo(client):
    r = client.post("/api/people", json={"tree_id": 1, "full_name": "Mani", "gender": "M",
                                         "phone": "+91 98765 43210", "address": "12 Temple St\nMadurai",
                                         "photo": TINY_PNG})
    assert r.status_code == 201
    p = r.json
    assert p["phone"] == "+91 98765 43210" and "Madurai" in p["address"]
    img = client.get(p["photo_url"])
    assert img.status_code == 200 and img.mimetype == "image/png"

    r = client.put(f"/api/people/{p['id']}", json={"phone": "", "remove_photo": True})
    assert r.json["phone"] is None and r.json["photo_url"] is None
    assert client.get(f"/api/people/{p['id']}/photo").status_code == 404


def test_rejects_bad_input(client):
    pid_ = pid("Arun")
    assert client.put(f"/api/people/{pid_}", json={"phone": "call me<script>"}).status_code == 400
    assert client.put(f"/api/people/{pid_}", json={"photo": "data:text/html;base64,PGI+"}).status_code == 400
    assert client.put(f"/api/people/{pid_}", json={"full_name": "  "}).status_code == 400


def test_family_password(client, monkeypatch):
    monkeypatch.setenv("APP_PASSWORD", "secret")
    assert client.get("/api/trees").status_code == 401
    assert client.get("/healthz").status_code == 200
    ok = "Basic " + base64.b64encode(b"family:secret").decode()
    assert client.get("/api/trees", headers={"Authorization": ok}).status_code == 200


def test_migration_adds_columns_to_old_table(tmp_path):
    """Neon already has the old persons table: init-db must add the new columns."""
    import sqlalchemy as sa
    import models
    old = sa.create_engine(f"sqlite:///{tmp_path/'old.db'}")
    with old.begin() as c:
        c.execute(sa.text("CREATE TABLE persons (id INTEGER PRIMARY KEY, tree_id INT, "
                          "full_name TEXT, native_name TEXT, gender TEXT, birth_date DATE, photo_url TEXT)"))
    real = models.engine
    models.engine = old
    try:
        models.add_missing_columns()
        cols = {c["name"] for c in sa.inspect(old).get_columns("persons")}
    finally:
        models.engine = real
    assert {"phone", "address", "photo", "photo_mime", "photo_updated"} <= cols
