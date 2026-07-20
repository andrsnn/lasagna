#!/usr/bin/env bash
# Orchestrate the declared-data e2e test: mock backends + real next server +
# Playwright driver. Assumes `npm run build` has already produced .next.
set -uo pipefail
cd "$(dirname "$0")/../.."

REDIS_PORT=8199
LLM_PORT=8198
APP_PORT=3123

node scripts/e2e/mock-backends.mjs $REDIS_PORT $LLM_PORT &
MOCK_PID=$!

UPSTASH_REDIS_REST_URL="http://127.0.0.1:$REDIS_PORT" \
UPSTASH_REDIS_REST_TOKEN="e2e-token" \
RUNPOD_API_BASE="http://127.0.0.1:$LLM_PORT" \
RUNPOD_API_KEY="e2e-key" \
RUNPOD_ENDPOINT_ID="e2e" \
OLLAMA_API_KEY="e2e-dummy" \
TEMP_PASS="e2e-test-pass" \
ADMIN_EMAIL="admin@example.com" \
npx next start -p $APP_PORT &
NEXT_PID=$!

cleanup() { kill $MOCK_PID $NEXT_PID 2>/dev/null; }
trap cleanup EXIT

# Wait for the server to accept connections.
for i in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:$APP_PORT/login" && break
  sleep 1
done

E2E_BASE_URL="http://127.0.0.1:$APP_PORT" \
E2E_LLM_CONTROL="http://127.0.0.1:$LLM_PORT/__control" \
E2E_ADMIN_EMAIL="admin@example.com" \
E2E_TEMP_PASS="e2e-test-pass" \
node scripts/e2e/v2-leave-return.mjs
INTERACTIVE_RC=$?

E2E_BASE_URL="http://127.0.0.1:$APP_PORT" \
E2E_ADMIN_EMAIL="admin@example.com" \
E2E_TEMP_PASS="e2e-test-pass" \
node scripts/e2e/v2-schedule.mjs
SCHEDULE_RC=$?

[ $INTERACTIVE_RC -eq 0 ] && [ $SCHEDULE_RC -eq 0 ]
exit $?
