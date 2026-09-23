# The three OSWorld 2.0 web apps, pinned to the ports the evaluation expects

The evaluation talks to ExpenseFlow `:8001`, InsClaim `:8002` (+ its backend on
`:8005`) and CloudCRM `:8003`. Upstream serves every app behind one Caddy
instance routed by hostname (`<app>.$HOST_SUFFIX`), which those fixed
localhost ports do not match, and two of the apps ship a standalone compose
that both claim `:8001`. These three files publish the ports the evaluation wants
instead, without touching the submodules.

```bash
git clone https://github.com/Task-Web/OSWorld-web.git
cd OSWorld-web
# the submodule urls are ssh; rewrite them if you authenticate over https
for r in basesite expenseflow_web insurance_claim_web cloudcrm_web; do
  git submodule set-url "$r" "https://github.com/Task-Web/$r.git"
  git submodule update --init "$r"
done
cp -r /path/to/KONI-Forms/experiments/osworld-web koni
for a in expenseflow cloudcrm insurance; do
  docker compose -p koni-$a -f koni/$a.yml up -d --build
done
```

Each app is `nginx` (the published port) -> `/api*` and `/mcp*` to the backend,
everything else to the frontend. InsClaim also publishes its backend directly
on `:8005`, which is where the scorer reads state while the agent drives
`:8002`; cookies are seeded on both origins.

Verify all six endpoints the evaluation uses:

```bash
for u in localhost:8001/expenseflow/index.html localhost:8001/api/state \
         localhost:8002/ localhost:8005/api/state \
         localhost:8003/ localhost:8003/api/state; do
  printf '%s -> %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' "http://$u")"
done
```
