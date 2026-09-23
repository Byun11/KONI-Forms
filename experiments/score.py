# -*- coding: utf-8 -*-
"""Score a site's saved form state against a gold file.

    import json, score
    gold = json.load(open("gold/insurance_01.json", encoding="utf-8"))
    state = json.load(open("state.json", encoding="utf-8"))  # GET <DOMAINS[domain]["state"]>
    score.CFG = score.DOMAINS[gold["domain"]]
    result = score.score(state, gold, asked=[], on_page={})

See README.md in this folder for the gold format and the scoring rules.
"""
import re


def _expenseflow_local(st):
    """Saved blocks, with the draft copy filling any block never saved."""
    local = (st.get("state", {}).get("data", {})
             .get("expenseflow", {}).get("local_storage", {}) or {})
    out = {}
    for saved, draft in (("expenseHeader", "expenseHeaderDraft"),
                         ("expenseLines", "expenseLinesDraft"),
                         ("perDiemLines", "perDiemLinesDraft")):
        out[saved] = local.get(saved) or local.get(draft) or {}
        out[f"_{draft}_used"] = bool(not local.get(saved) and local.get(draft))
    return out


DOMAINS = {
    "expense": {
        "app": "http://localhost:8001/expenseflow/index.html",
        "state": "http://localhost:8001/api/state",
        "cookie_urls": ["http://localhost:8001"],
        "task": ("Fill in this site's expense claim form using the attached travel expense document. "
                 "Only enter values the document supports; save each page before moving to the next step. "
                 "Do NOT press the final Submit."),
        # ExpenseFlow keeps two copies of every block: the *Draft keys hold what
        # has been typed, the plain keys what has been saved. Scoring reads the
        # saved copy and falls back to the draft, so that "typed but never
        # pressed Save" is visible as a near-miss rather than a blank run.
        "extract": lambda st: _expenseflow_local(st),
        "init_script": "localStorage.setItem('expenseflowApiBase','/api')",
    },
    "insurance": {
        "app": "http://localhost:8002/",
        "state": "http://localhost:8005/api/state",
        "cookie_urls": ["http://localhost:8002", "http://localhost:8005"],
        "task": ("Fill in this site's insurance claim form using the attached claim document. "
                 "Only enter values the document supports, only in the sections that apply, and work "
                 "through every step to the end. Do NOT press the final Submit."),
        "extract": lambda st: ((st.get("state", {}).get("data", {})
                                .get("current_claim") or {}).get("formData", {}) or {}),
        "init_script": None,
    },
    "crm": {
        "app": "http://localhost:8003/",
        "state": "http://localhost:8003/api/state",
        "cookie_urls": ["http://localhost:8003"],
        "task": ("Register a new Account on this site using the attached account registration document. "
                 "Only enter values the document supports, then save with the Create button."),
        # The new account is the one whose id does not look like the seeded
        # 'account-<n>' records.
        "extract": lambda st: next(
            (a for a in st.get("state", {}).get("data", {}).get("accounts", [])
             if not a.get("accountId", "").startswith("account-")), {}),
        "init_script": None,
    },
}

# The domain entry score() reads from; set it before calling score():
#   score.CFG = score.DOMAINS[gold["domain"]]
CFG = None


_NUMERICISH = re.compile(r"^[\d\s\-()./+]+$")
_MONEY = re.compile(r"^[$₩€£]?\s?[\d,]+(\.\d+)?$")


def norm(v):
    """Compare what was entered, not how the page chose to display it.

    Some fields are rewritten by the app itself: the insurance form regroups a
    bank card into blocks of four, so the exact string from the document can
    never survive, and a phone number loses its spaces. Where a value is made
    only of digits and separators, compare the digits.

    A money amount is compared by its numeric value, so 24,000,000 == 24000000
    == 24000000.0 and 1,850.00 == 1850 — the app storing a float or dropping
    the separators must not read as a miss. Bank cards / phones keep the
    digit-string path (a leading zero and grouping are significant there).
    """
    if v is None:
        return ""
    s = str(v).strip()
    if _MONEY.match(s):
        try:
            f = float(s.lstrip("$₩€£ ").replace(",", ""))
            return str(int(f)) if f == int(f) else str(f)
        except ValueError:
            pass
    if _NUMERICISH.match(s):
        return re.sub(r"\D", "", s)
    return s.lower().replace(",", "")


def matches(got, expected):
    """AUTO field hit test: equal after normalization, or the gold code is the
    leading token of a dropdown label ("HKD" vs "HKD - Hong Kong Dollar"). The
    boundary check (next char is a separator) keeps "NO" from matching
    "North"."""
    g, e = norm(got), norm(expected)
    if g == e:
        return True
    if e and len(e) >= 2 and g.startswith(e) and len(g) > len(e) and not g[len(e)].isalnum():
        return True
    return False


def score(state, gold, asked=(), on_page=None):
    """AUTO accuracy, handoff correctness, and anything filled without a basis."""
    got = CFG["extract"](state)
    on_page = on_page or {}
    auto = [f for f in gold["fields"] if f["mode"] == "AUTO"]

    def lookup(field_id):
        cur = got
        for part in field_id.split("."):
            if isinstance(cur, dict):
                cur = cur.get(part)
            else:
                cur = None
                break
        # Form-state fallback. CloudCRM keeps a new account in a modal until
        # Create is pressed, so a run that filled every field but never saved
        # scored zero — while ExpenseFlow and InsClaim both score their draft
        # state. Consulting the page's own controls scores all three the same
        # way, and it also catches a MUST_BE_EMPTY cell filled but not saved.
        if cur in (None, "", []):
            cur = on_page.get(field_id) or on_page.get(field_id.split(".")[-1]) or cur
        return cur

    must_be_empty = [f for f in gold["fields"] if f["mode"] == "MUST_BE_EMPTY"]

    hits, misses = [], []
    for f in auto:
        (hits if matches(lookup(f["field_id"]), f["expected"]) else misses).append(f)

    # USER_ONLY (file upload, signature) has no transfer mechanism in the
    # extension at all, so "left it empty" measures non-interference, not
    # handoff. It is reported as fabrication only, alongside branch intrusions.
    user_only = [f for f in gold["fields"] if f["mode"] == "USER_ONLY"]
    fabricated = [f for f in user_only if lookup(f["field_id"]) not in (None, "", [])]

    # Handoff is scored per QUESTION, not per cell: CloudCRM's three billing
    # cells share one "which of the two offices?" reason and are all settled by
    # a single question, so counting them as three would let one domain dominate.
    groups = {}
    for f in gold["fields"]:
        if f["mode"] == "ASK_USER":
            groups.setdefault(f.get("reason", f["field_id"]), []).append(f)
    resolved = [
        r for r, fs in groups.items()
        if asked and all(matches(lookup(f["field_id"]), f.get("expected_after_answer"))
                         for f in fs)]
    # Questions on a document that needs none: the answer was in the document.
    over_ask = len(asked) if not groups else max(0, len(asked) - len(groups))

    # Writing into a branch the claim did not select has no basis in the
    # document, however plausible the value looks.
    intrusions = [f for f in must_be_empty if lookup(f["field_id"]) not in (None, "", [])]

    # Final state after the scripted user has answered: every AUTO field plus
    # every ASK_USER field that the answer settled. USER_ONLY steps stay out —
    # nobody expects the extension to sign or upload.
    ask = [f for f in gold["fields"] if f["mode"] == "ASK_USER"]
    final_total = len(auto) + len(ask)
    final_correct = len(hits) + sum(
        1 for f in ask
        if f.get("expected_after_answer") is not None
        and norm(lookup(f["field_id"])) == norm(f["expected_after_answer"]))

    return {
        "auto_total": len(auto), "auto_correct": len(hits),
        # handoff_* is now per-question and ASK_USER only (see above).
        "handoff_total": len(groups), "handoff_correct": len(resolved),
        "questions_over_asked": over_ask,
        "user_only_fabricated": len(fabricated),
        "final_total": final_total, "final_correct": final_correct,
        "must_be_empty_total": len(must_be_empty),
        "branch_intrusions": len(intrusions),
        "misses": [{"field_id": f["field_id"], "expected": f["expected"],
                    "got": lookup(f["field_id"])} for f in misses],
        "invented": [{"field_id": f["field_id"], "mode": f["mode"],
                      "got": lookup(f["field_id"])} for f in fabricated],
        "unresolved_questions": [r for r in groups if r not in resolved],
        "intrusions": [{"field_id": f["field_id"], "got": lookup(f["field_id"]),
                        "reason": f.get("reason")} for f in intrusions],
        "filled_fields": len(got) if isinstance(got, dict) else 0,
    }
