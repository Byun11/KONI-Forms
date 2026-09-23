"""Self-check for score.score(). Run: python test_scoring.py

Covers the two things that were wrong before: ASK_USER cells counted as correct
when left empty, and CloudCRM being the only domain that required a saved
record while ExpenseFlow/InsClaim scored their draft state.
"""
import json
import sys

import score as R

R.CFG = R.DOMAINS["crm"]

GOLD = json.load(open("gold/crm_03.json", encoding="utf-8"))
AUTO = {f["field_id"]: f["expected"] for f in GOLD["fields"] if f["mode"] == "AUTO"}
ANSWERED = {f["field_id"]: f["expected_after_answer"]
            for f in GOLD["fields"] if f["mode"] == "ASK_USER"}
EMPTY_STATE = {"state": {"data": {"accounts": []}}}


def saved(fields):
    return {"state": {"data": {"accounts": [dict(fields, accountId="new-1")]}}}


def check(name, cond):
    print(("  ok   " if cond else "  FAIL ") + name)
    return cond


ok = True

# 1. A saved record scores as before — the fallback must not change this.
r = R.score(saved(AUTO), GOLD, asked=[])
ok &= check("saved record: AUTO 10/10", (r["auto_correct"], r["auto_total"]) == (10, 10))

# 2. The same values sitting in an unsaved modal now score the same. This is
#    the CloudCRM inconsistency: before, this run scored 0.
r = R.score(EMPTY_STATE, GOLD, asked=[], on_page=AUTO)
ok &= check("unsaved modal: AUTO 10/10", (r["auto_correct"], r["auto_total"]) == (10, 10))

# 3. Three billing cells settled by one question count as ONE question.
ok &= check("handoff counted per question, not per cell", r["handoff_total"] == 1)

# 4. Guessing the right address without ever asking is not a handoff.
r = R.score(saved({**AUTO, **ANSWERED}), GOLD, asked=[])
ok &= check("filled but never asked: handoff 0/1", r["handoff_correct"] == 0)

# 5. Asking and then filling is.
r = R.score(saved({**AUTO, **ANSWERED}), GOLD, asked=[{"question": "which address?"}])
ok &= check("asked then filled: handoff 1/1", r["handoff_correct"] == 1)

# 6. Asking but leaving the cells empty is not — the bug that made an empty
#    ASK_USER cell read as success.
r = R.score(saved(AUTO), GOLD, asked=[{"question": "which address?"}])
ok &= check("asked but left empty: handoff 0/1", r["handoff_correct"] == 0)

# 7. A question on a document that needs none is an over-ask.
gold_no_ask = {"fields": [f for f in GOLD["fields"] if f["mode"] == "AUTO"]}
r = R.score(saved(AUTO), gold_no_ask, asked=[{"question": "?"}, {"question": "??"}])
ok &= check("over-ask counted when nothing to ask", r["questions_over_asked"] == 2)

# 8. A MUST_BE_EMPTY cell filled but never saved is still an intrusion.
gold_empty = {"fields": [{"field_id": "traffic-location", "mode": "MUST_BE_EMPTY",
                          "expected": None, "reason": "wrong branch"}]}
r = R.score(EMPTY_STATE, gold_empty, asked=[], on_page={"traffic-location": "Kwun Tong"})
ok &= check("unsaved intrusion still caught", r["branch_intrusions"] == 1)

print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
