#!/usr/bin/env bash
# Scans each repository in repos.txt at its pinned commit with the Go CLI and
# writes one JSON report per repository to results/.
set -euo pipefail
cd "$(dirname "$0")"
WORK="${WORK:-$(mktemp -d)}"
mkdir -p results
(cd ../cli && go build -o "$WORK/attrition" .)

grep -v '^#' repos.txt | while read -r repo commit; do
  dir="$WORK/${repo//\//_}"
  if [[ ! -d "$dir" ]]; then
    git clone -q --filter=blob:none "https://github.com/$repo" "$dir"
  fi
  git -C "$dir" checkout -q "$commit"
  (cd "$dir" && "$WORK/attrition" -json -workers 6 .) > "results/${repo//\//_}.json"
  echo "scanned $repo@$commit"
done
python3 summarize.py > RESULTS.md
