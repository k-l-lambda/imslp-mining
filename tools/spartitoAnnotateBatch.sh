#!/bin/bash
# Usage: ./tools/spartitoAnnotateBatch.sh <dir> [--logger]
# Runs spartitoAnnotate.ts on all *.spartito.json files in <dir>.

set -e

DIR="$1"
shift || { echo "Usage: $0 <dir> [--logger]"; exit 1; }

if [ ! -d "$DIR" ]; then
	echo "Directory not found: $DIR"
	exit 1
fi

EXTRA_ARGS="$@"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

total=0
success=0
fail=0

for f in "$DIR"/*.spartito.json; do
	[ -f "$f" ] || continue
	total=$((total + 1))
	echo "=== [$total] $(basename "$f") ==="
	if (cd "$PROJECT_DIR" && npx tsx tools/spartitoAnnotate.ts "$f" $EXTRA_ARGS); then
		success=$((success + 1))
	else
		fail=$((fail + 1))
		echo "FAILED: $f"
	fi
	echo
done

echo "=== Summary ==="
echo "Total: $total  Success: $success  Failed: $fail"
