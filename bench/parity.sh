#!/usr/bin/env bash
# Checks that the Rust offline scanner and the web scanner (through the Go CLI
# results in results/) report the same number of deprecated usages per repo.
set -euo pipefail
cd "$(dirname "$0")"
WORK="${WORK:?set WORK to the directory run.sh cloned into}"
(cd ../rust && cargo build --release -q && ./target/release/attrition-offline snapshot >/dev/null)
bin="$(cd ../rust && pwd)/target/release/attrition-offline"
snap="$(cd ../rust && pwd)/.attrition/snapshot.json"
grep -v '^#' repos.txt | while read -r repo commit; do
  dir="$WORK/${repo//\//_}"
  mkdir -p "$dir/.attrition" && cp "$snap" "$dir/.attrition/"
  (cd "$dir" && "$bin" scan --json .) > /tmp/attrition-rust.json
  python3 - "$repo" "results/${repo//\//_}.json" <<'PY'
import json, sys
rust = json.load(open("/tmp/attrition-rust.json"))
web = json.load(open(sys.argv[2]))
same = rust["deprecatedInCode"] == web["deprecatedUsages"] and rust["deprecatedInComments"] == web.get("deprecatedInComments", 0)
print(f'{sys.argv[1]:<34} rust {rust["deprecatedInCode"]:>3}/{rust["deprecatedInComments"]}  web {web["deprecatedUsages"]:>3}/{web.get("deprecatedInComments", 0)}  {rust["millis"]:>4} ms  {"match" if same else "DIFFERENT"}')
PY
done
