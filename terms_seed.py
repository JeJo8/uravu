"""
Starter kinship terms. Add a new language by adding rows — no code changes.

Columns: (language, path_code, speaker_gender, target_age, term, term_native)
  speaker_gender: 'M', 'F' or 'any'  (Tamil cousin/nephew terms depend on it)
  target_age:     'elder', 'younger' or 'any'  (relative vs the speaker)
  path_code:      see kinship.py — e.g. F.eB = father's elder brother.
                  Codes without e/y (F.B) are used when age-specific rows don't match.

Tamil terms: please review — usage varies by region and family.
"""

A = "any"

TAMIL = [
    # parents & grandparents
    ("ta", "F", A, A, "Appa", "அப்பா"),
    ("ta", "M", A, A, "Amma", "அம்மா"),
    ("ta", "F.F", A, A, "Thatha", "தாத்தா"),
    ("ta", "M.F", A, A, "Thatha", "தாத்தா"),
    ("ta", "F.M", A, A, "Paati", "பாட்டி"),
    ("ta", "M.M", A, A, "Paati", "பாட்டி"),
    # siblings
    ("ta", "eB", A, A, "Anna", "அண்ணா"),
    ("ta", "yB", A, A, "Thambi", "தம்பி"),
    ("ta", "eZ", A, A, "Akka", "அக்கா"),
    ("ta", "yZ", A, A, "Thangai", "தங்கை"),
    # spouse & children
    ("ta", "H", A, A, "Kanavar", "கணவர்"),
    ("ta", "W", A, A, "Manaivi", "மனைவி"),
    ("ta", "S", A, A, "Magan", "மகன்"),
    ("ta", "D", A, A, "Magal", "மகள்"),
    ("ta", "S.S", A, A, "Peran", "பேரன்"),
    ("ta", "D.S", A, A, "Peran", "பேரன்"),
    ("ta", "S.D", A, A, "Pethi", "பேத்தி"),
    ("ta", "D.D", A, A, "Pethi", "பேத்தி"),
    ("ta", "S.W", A, A, "Marumagal", "மருமகள்"),
    ("ta", "D.H", A, A, "Marumagan", "மருமகன்"),
    # father's side
    ("ta", "F.eB", A, A, "Periyappa", "பெரியப்பா"),
    ("ta", "F.yB", A, A, "Chithappa", "சித்தப்பா"),
    ("ta", "F.eB.W", A, A, "Periyamma", "பெரியம்மா"),
    ("ta", "F.yB.W", A, A, "Chithi", "சித்தி"),
    ("ta", "F.Z", A, A, "Athai", "அத்தை"),
    ("ta", "F.Z.H", A, A, "Maama", "மாமா"),
    # mother's side
    ("ta", "M.B", A, A, "Maama", "மாமா"),
    ("ta", "M.B.W", A, A, "Maami", "மாமி"),
    ("ta", "M.eZ", A, A, "Periyamma", "பெரியம்மா"),
    ("ta", "M.yZ", A, A, "Chithi", "சித்தி"),
    ("ta", "M.eZ.H", A, A, "Periyappa", "பெரியப்பா"),
    ("ta", "M.yZ.H", A, A, "Chithappa", "சித்தப்பா"),
    # parallel cousins = treated as siblings
    *[("ta", c, A, "elder", "Anna", "அண்ணா") for c in ("F.B.S", "M.Z.S")],
    *[("ta", c, A, "younger", "Thambi", "தம்பி") for c in ("F.B.S", "M.Z.S")],
    *[("ta", c, A, "elder", "Akka", "அக்கா") for c in ("F.B.D", "M.Z.D")],
    *[("ta", c, A, "younger", "Thangai", "தங்கை") for c in ("F.B.D", "M.Z.D")],
    # cross cousins (depends on who is speaking)
    *[("ta", c, "M", A, "Machan", "மச்சான்") for c in ("F.Z.S", "M.B.S")],
    *[("ta", c, "F", A, "Athan", "அத்தான்") for c in ("F.Z.S", "M.B.S")],
    *[("ta", c, "M", A, "Machini", "மச்சினி") for c in ("F.Z.D", "M.B.D")],
    *[("ta", c, "F", "elder", "Anni", "அண்ணி") for c in ("F.Z.D", "M.B.D")],
    # nephews / nieces: same-sex sibling's child = own child, else maru-
    ("ta", "B.S", "M", A, "Magan", "மகன்"),
    ("ta", "B.D", "M", A, "Magal", "மகள்"),
    ("ta", "Z.S", "F", A, "Magan", "மகன்"),
    ("ta", "Z.D", "F", A, "Magal", "மகள்"),
    ("ta", "B.S", "F", A, "Marumagan", "மருமகன்"),
    ("ta", "B.D", "F", A, "Marumagal", "மருமகள்"),
    ("ta", "Z.S", "M", A, "Marumagan", "மருமகன்"),
    ("ta", "Z.D", "M", A, "Marumagal", "மருமகள்"),
    # spouse's nephews/nieces follow the spouse's side
    *[("ta", c, A, A, "Magan", "மகன்") for c in ("H.B.S", "W.Z.S")],
    *[("ta", c, A, A, "Magal", "மகள்") for c in ("H.B.D", "W.Z.D")],
    *[("ta", c, A, A, "Marumagan", "மருமகன்") for c in ("W.B.S", "H.Z.S")],
    *[("ta", c, A, A, "Marumagal", "மருமகள்") for c in ("W.B.D", "H.Z.D")],
    # in-laws
    ("ta", "W.F", A, A, "Maamanar", "மாமனார்"),
    ("ta", "H.F", A, A, "Maamanar", "மாமனார்"),
    ("ta", "W.M", A, A, "Maamiyar", "மாமியார்"),
    ("ta", "H.M", A, A, "Maamiyar", "மாமியார்"),
    ("ta", "eB.W", A, A, "Anni", "அண்ணி"),
    ("ta", "eZ.H", A, A, "Athan", "அத்தான்"),
    ("ta", "yZ.H", A, A, "Machan", "மச்சான்"),
    ("ta", "W.B", A, A, "Machan", "மச்சான்"),
    ("ta", "W.yZ", A, A, "Kozhundhiyal", "கொழுந்தியாள்"),
    ("ta", "H.yB", A, A, "Kozhundhan", "கொழுந்தன்"),
    ("ta", "H.Z", A, A, "Naathanaar", "நாத்தனார்"),
]


def _en(codes, term):
    return [("en", c, A, A, term, term) for c in codes]


ENGLISH = [
    *_en(["F"], "Father"), *_en(["M"], "Mother"),
    *_en(["F.F", "M.F"], "Grandfather"), *_en(["F.M", "M.M"], "Grandmother"),
    *_en(["B"], "Brother"), *_en(["Z"], "Sister"),
    *_en(["H"], "Husband"), *_en(["W"], "Wife"),
    *_en(["S"], "Son"), *_en(["D"], "Daughter"),
    *_en(["S.S", "D.S"], "Grandson"), *_en(["S.D", "D.D"], "Granddaughter"),
    *_en(["F.B", "M.B", "F.Z.H", "M.Z.H"], "Uncle"),
    *_en(["F.Z", "M.Z", "F.B.W", "M.B.W"], "Aunt"),
    *_en([f"{p}.{s}.{c}" for p in "FM" for s in "BZ" for c in "SD"], "Cousin"),
    *_en(["B.S", "Z.S", "W.B.S", "W.Z.S", "H.B.S", "H.Z.S"], "Nephew"),
    *_en(["B.D", "Z.D", "W.B.D", "W.Z.D", "H.B.D", "H.Z.D"], "Niece"),
    *_en(["W.F", "H.F"], "Father-in-law"), *_en(["W.M", "H.M"], "Mother-in-law"),
    *_en(["S.W"], "Daughter-in-law"), *_en(["D.H"], "Son-in-law"),
    *_en(["W.B", "H.B", "Z.H"], "Brother-in-law"),
    *_en(["W.Z", "H.Z", "B.W"], "Sister-in-law"),
]

ALL_TERMS = [
    dict(zip(["language", "path_code", "speaker_gender", "target_age",
              "term", "term_native"], row))
    for row in TAMIL + ENGLISH
]

LANGUAGES = {"ta": "Tamil", "en": "English"}
