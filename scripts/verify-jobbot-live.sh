#!/usr/bin/env bash
# Verify the live JobBot API against the real deployed Railway instance.
#
# Usage:
#   BASE_URL="https://YOUR-APP.up.railway.app" \
#   JOBBOT_API_KEY="the-key-set-in-railway" \
#   INTERNAL_API_KEY="the-general-key" \      # optional: proves it's rejected
#   JOB="Field Engineer" \                     # a real job title/slug in your DB
#   bash scripts/verify-jobbot-live.sh
set -u

: "${BASE_URL:?set BASE_URL to the deployed app URL}"
: "${JOBBOT_API_KEY:?set JOBBOT_API_KEY to the key configured in Railway}"
JOB="${JOB:-}"

pass=0; fail=0
check() { # description  expected_status  actual_status
  if [ "$2" = "$3" ]; then echo "  PASS  $1 (HTTP $3)"; pass=$((pass+1));
  else echo "  FAIL  $1 (expected $2, got $3)"; fail=$((fail+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
body() { curl -s "$@"; }

echo "== Auth =="
check "no key -> 401"            401 "$(code "$BASE_URL/api/jobbot/jobs")"
check "bad key -> 401"           401 "$(code -H 'x-api-key: definitely-wrong' "$BASE_URL/api/jobbot/jobs")"
check "global-faq no key -> 401" 401 "$(code "$BASE_URL/api/jobbot/global-faq")"
if [ -n "${INTERNAL_API_KEY:-}" ]; then
  check "INTERNAL key rejected -> 401" 401 "$(code -H "x-api-key: $INTERNAL_API_KEY" "$BASE_URL/api/jobbot/jobs")"
fi
check "JOBBOT key accepted -> 200" 200 "$(code -H "x-api-key: $JOBBOT_API_KEY" "$BASE_URL/api/jobbot/jobs")"

echo "== Payloads =="
check "list -> 200"       200 "$(code -H "x-api-key: $JOBBOT_API_KEY" "$BASE_URL/api/jobbot/jobs")"
check "general -> 200"    200 "$(code -H "x-api-key: $JOBBOT_API_KEY" "$BASE_URL/api/jobbot/jobs/general")"
check "global-faq -> 200" 200 "$(code -H "x-api-key: $JOBBOT_API_KEY" "$BASE_URL/api/jobbot/global-faq")"
check "unknown -> 404"    404 "$(code -H "x-api-key: $JOBBOT_API_KEY" "$BASE_URL/api/jobbot/jobs/__no_such_job__")"

echo "== Sample bodies =="
echo "  /jobbot/jobs:"         ; body -H "x-api-key: $JOBBOT_API_KEY" "$BASE_URL/api/jobbot/jobs"
echo "  /jobbot/jobs/general:" ; body -H "x-api-key: $JOBBOT_API_KEY" "$BASE_URL/api/jobbot/jobs/general"
echo "  /jobbot/global-faq:"   ; body -H "x-api-key: $JOBBOT_API_KEY" "$BASE_URL/api/jobbot/global-faq"

if [ -n "$JOB" ]; then
  enc=$(printf '%s' "$JOB" | sed 's/ /%20/g')
  check "lookup '$JOB' -> 200" 200 "$(code -H "x-api-key: $JOBBOT_API_KEY" "$BASE_URL/api/jobbot/jobs/$enc")"
  echo "  /jobbot/jobs/$JOB (should show generalFactsMerged:true):"
  body -H "x-api-key: $JOBBOT_API_KEY" "$BASE_URL/api/jobbot/jobs/$enc"
else
  echo "  (set JOB=<a real title/slug> to also test the merged single-job lookup)"
fi

echo
echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
