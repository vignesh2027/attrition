#!/usr/bin/env bash
# Recreates the Knowledge Base from the dataset and the files in sources/.
# Usage: ./build-kb.sh [existing-kb-id]
set -euo pipefail

ORG=oc2g3x7ee
PROJECT=y9raau23
DATASET=production
cd "$(dirname "$0")/../studio"

KB="${1:-}"
if [[ -z "$KB" ]]; then
  KB=$(npx sanity context create --organization "$ORG" \
    --title "OpenTelemetry semconv migrations" \
    --description "Deprecated OpenTelemetry attributes for database, HTTP, network, RPC, messaging and code spans, the official migration guides, and two older spec pages that still use the retired names. For engineers moving instrumentation to current semantic conventions." \
    | sed -n 's/.*ID:[[:space:]]*\(kb[A-Za-z0-9]*\).*/\1/p')
  echo "created $KB"
fi

npx sanity context imports create "$KB" \
  --sanity-project "$PROJECT" --sanity-dataset "$DATASET" \
  --query '*[(_type == "attribute" && status != "current" && deprecation.verdict != "MOVED_OUT" && string::split(key, ".")[0] in ["db", "http", "net", "rpc", "messaging", "code", "message"]) || (_type == "metric" && status != "current" && deprecation.verdict != "MOVED_OUT" && string::split(key, ".")[0] in ["http", "db", "rpc", "messaging"])]'

for f in ../kb/sources/*.md; do
  npx sanity context imports create "$KB" --file "$f" --content-type text/markdown
done

npx sanity context build "$KB" --watch
