#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
COURIER="${COURIER:-mock}"
STAMP="$(date +%s)"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
call() {
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BASE$path" -H 'Content-Type: application/json' -d "$body"
  else
    curl -sS -X "$method" "$BASE$path"
  fi
  echo
}

order_body() {
  cat <<JSON
{
  "courier_partner": "$2",
  "order_id": "$1",
  "payment_mode": "COD",
  "service_level": "SAME_DAY",
  "collectable_amount": 1499,
  "declared_value": 1499,
  "invoice": { "number": "INV-$STAMP", "date": "$(date +%Y-%m-%d)", "value": 1499 },
  "pickup": {
    "name": "Warehouse Gurgaon", "phone": "9425018023", "email": "ops@example.com",
    "line1": "Plot 137 Sector-I Industrial Area", "city": "Gurgaon", "state": "Haryana",
    "pincode": "122017", "country": "INDIA", "type": "SELLER"
  },
  "delivery": {
    "name": "Priya Sharma", "phone": "8320226438",
    "line1": "26 Om Nagar Society", "city": "Gurgaon", "state": "Haryana",
    "pincode": "${3:-122001}", "country": "INDIA", "type": "HOME"
  },
  "package": { "weight_kg": 1.1, "length_cm": 12, "breadth_cm": 10, "height_cm": 10, "pieces": 1 },
  "items": [{ "description": "Paperback books", "quantity": 1 }]
}
JSON
}

say "Supported couriers and their capabilities"
call GET /api/v1/couriers

say "Create a shipment"
ORDER="DEMO-$STAMP"
call POST /api/v1/orders "$(order_body "$ORDER" "$COURIER")"

say "Submit the same order_id again - idempotent replay, no second shipment"
call POST /api/v1/orders "$(order_body "$ORDER" "$COURIER")"

say "Track it - live courier call, append-only history"
call GET "/api/v1/orders/$ORDER/track"

say "Cancel it"
call POST "/api/v1/orders/$ORDER/cancel"

say "Cancel again - rejected, the shipment is already cancelled"
call POST "/api/v1/orders/$ORDER/cancel"

say "Unknown courier - 400 listing what is supported"
call POST /api/v1/orders "$(order_body "DEMO-UNKNOWN-$STAMP" "bluedart")"

say "Bulk submit with deliberate failures mixed in"
ITEMS=""
for i in 0 1 2 3 4; do
  ITEMS="$ITEMS$(order_body "BULK-$STAMP-$i" "$COURIER"),"
done
ITEMS="$ITEMS$(order_body "BULK-$STAMP-0" "$COURIER"),"
ITEMS="$ITEMS{\"courier_partner\":\"$COURIER\",\"order_id\":\"BULK-$STAMP-BAD\"},"
ITEMS="$ITEMS$(order_body "BULK-$STAMP-NOPE" "nonexistent-courier")"

BATCH=$(curl -sS -X POST "$BASE/api/v1/orders/bulk" -H 'Content-Type: application/json' \
  -d "{\"orders\":[$ITEMS]}")
echo "$BATCH"
BATCH_ID=$(echo "$BATCH" | sed -n 's/.*"batch_id":"\([^"]*\)".*/\1/p')

say "Poll the batch until the worker finishes"
for _ in $(seq 1 20); do
  RESULT=$(curl -sS "$BASE/api/v1/batches/$BATCH_ID")
  echo "$RESULT" | grep -q '"status":"PROCESSING"' || break
  sleep 1
done
echo "$RESULT"

say "Failed orders, queryable for reconciliation"
call GET "/api/v1/orders?status=FAILED&limit=5"
