# Evaluation materials

Documents, gold answers, site configuration, and the scorer used to evaluate KONI-Forms on three web forms.

## Contents

```
experiments/
├── docs/            source documents, one folder per site
│   ├── crm/         crm_01, crm_01x1, crm_01x2 …   (.docx and .pdf of each)
│   ├── expense/     expense_01, expense_01x1 …
│   ├── insurance/   insurance_01, insurance_01x1 …
│   └── _manifests/  page and word counts for the x1 and x2 variants
├── gold/            one gold file per variant (crm_01.json, crm_01x1.json …)
├── osworld-web/     compose files and nginx config that publish the three sites on fixed ports
├── score.py         scores a site's saved state against a gold file
└── test_scoring.py  self-check for score.py
```

Nine tasks (three per site, `_01`–`_03`) at three document scales:

| Suffix | Pages | Document |
|---|---|---|
| *(none)* | 1–2 | the original document |
| `x1` | 28–36 | the same document surrounded by policy text, filing guidance, and a specimen form carrying the same labels |
| `x2` | 44–57 | the same, with more of that surrounding material |

That is 27 variants, each available as DOCX and PDF, with one gold file per variant. Target values and gold states are identical across the scales of a task: only document length and distractor content change. Across the nine tasks gold annotates 191 AUTO fields (CRM 36, insurance 43, expense 112); fields that must stay empty, expected user questions, and user-only steps are annotated separately and lie outside the 191.

## Sites

The three target sites come from the public OSWorld 2.0 web apps ([Task-Web/OSWorld-web](https://github.com/Task-Web/OSWorld-web)): ExpenseFlow (expense claim), InsClaim (insurance claim), and CloudCRM (account registration). The files in `osworld-web/` start them on the ports the scorer expects; see [`osworld-web/README.md`](osworld-web/README.md) for the setup commands.

| Domain | Form | State endpoint |
|---|---|---|
| `expense` | http://localhost:8001/expenseflow/index.html | http://localhost:8001/api/state |
| `insurance` | http://localhost:8002/ | http://localhost:8005/api/state |
| `crm` | http://localhost:8003/ | http://localhost:8003/api/state |

The apps keep state per `user_id` cookie, so read the state with the same cookie the browser used:

```bash
curl -H "Cookie: user_id=<id>" http://localhost:8005/api/state > state.json
```

## Gold format

```json
{
  "doc": "docs/crm/crm_03.docx",
  "domain": "crm",
  "fields": [
    {"field_id": "name", "label": "Account Name", "expected": "…", "mode": "AUTO"},
    {"field_id": "billingCity", "expected": null, "mode": "ASK_USER",
     "reason": "…", "user_answer": "…", "expected_after_answer": "…"}
  ]
}
```

`field_id` is the key in the site's saved form state; nested keys are joined with dots (`expenseLines.1.expenseType`).

Each field has a `mode`:

| Mode | Meaning |
|---|---|
| `AUTO` | The document states the value; the agent should enter `expected`. |
| `ASK_USER` | The document does not settle the value (for example, two conflicting addresses). The agent should ask the user; `user_answer` is the scripted reply and `expected_after_answer` the value that should end up in the form. Fields that share a `reason` are settled by one question. |
| `USER_ONLY` | A step only the user can do (file upload, signature). The agent should leave it empty. |
| `MUST_BE_EMPTY` | A field in a branch of the form the document does not select. It should stay empty. |

## Using score.py

`score.py` has no dependencies beyond the Python standard library.

```python
import json
import score

gold = json.load(open("gold/insurance_01.json", encoding="utf-8"))
state = json.load(open("state.json", encoding="utf-8"))

score.CFG = score.DOMAINS[gold["domain"]]   # select the site before scoring
result = score.score(state, gold, asked=[], on_page={})
print(result["auto_correct"], "/", result["auto_total"])
```

- `asked`: the questions the agent asked the user, as a list of dicts (for example `[{"question": "Which office?"}]`).
- `on_page`: optional `{field_id: value}` read from the form controls, used when a value was entered but not saved.

Run the self-check from this folder:

```bash
python test_scoring.py
```

## Scoring rules

- **Value comparison.** Values are normalized before comparison. A money amount is compared by numeric value (`1,850.00` equals `1850`). A value made only of digits and separators (phone, card number) is compared digit by digit, so the site's own grouping does not count as a miss. Other text is compared case-insensitively with commas removed. A gold code also matches a dropdown label that starts with it followed by a separator (`HKD` matches `HKD - Hong Kong Dollar`).
- **AUTO.** `auto_correct / auto_total` counts AUTO fields whose value matches `expected`.
- **ASK_USER.** Scored per question, not per field: `handoff_correct / handoff_total` counts question groups where the agent asked and every field in the group matches `expected_after_answer`. Questions beyond what the gold needs are counted in `questions_over_asked`.
- **USER_ONLY.** Any value entered is counted in `user_only_fabricated`.
- **MUST_BE_EMPTY.** Counted separately from accuracy: `branch_intrusions / must_be_empty_total` is the number of such fields that were filled.
- **Final state.** `final_correct / final_total` covers AUTO fields plus ASK_USER fields after the scripted answer.

A field missing from the saved state falls back to `on_page`, so an unsaved but filled form is scored the same way on all three sites.
