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
