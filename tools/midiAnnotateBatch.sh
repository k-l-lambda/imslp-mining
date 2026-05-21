#!/bin/bash
# Usage: ./tools/midiAnnotateBatch.sh <scores-dir> [--jobs N] [--include-hard-failed] [extra claude.ts args...]
# Runs tools/midi-annotator/claude.ts concurrently on score directories containing spartito.json and transkun.mid.

set -euo pipefail

if [ $# -lt 1 ]; then
	echo "Usage: $0 <scores-dir> [--jobs N] [--include-hard-failed] [extra claude.ts args...]"
	exit 1
fi

DIR="$1"
shift

if [ ! -d "$DIR" ]; then
	echo "Directory not found: $DIR"
	exit 1
fi

JOBS=1
INCLUDE_HARD_FAILED=0
EXTRA_ARGS=()
while [ $# -gt 0 ]; do
	case "$1" in
		--jobs|-j)
			if [ $# -lt 2 ]; then
				echo "Missing value for $1"
				exit 1
			fi
			JOBS="$2"
			shift 2
			;;
		--include-hard-failed)
			INCLUDE_HARD_FAILED=1
			shift
			;;
		*)
			EXTRA_ARGS+=("$1")
			shift
			;;
	esac
done

if ! [[ "$JOBS" =~ ^[0-9]+$ ]] || [ "$JOBS" -lt 1 ]; then
	echo "--jobs must be a positive integer: $JOBS"
	exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_ROOT="${MIDI_ANNOTATOR_BATCH_LOG_DIR:-$DIR/.midi-annotator-batch-$(date +%Y%m%d_%H%M%S)}"
STATUS_ROOT="$LOG_ROOT/.status"
mkdir -p "$LOG_ROOT" "$STATUS_ROOT"

is_hard_failed() {
	local score_dir="$1"
	local segmentation="$score_dir/.measures/midi-segmentation.json"
	[ -f "$segmentation" ] || return 1
	node - "$segmentation" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const boundaries = Array.isArray(data.boundaries) ? data.boundaries : [];
const sorted = boundaries
	.filter(boundary => Number.isFinite(Number(boundary.measureIndex)))
	.sort((a, b) => Number(a.measureIndex) - Number(b.measureIndex));
for (let i = 1; i < sorted.length; ++i) {
	const previous = sorted[i - 1];
	const current = sorted[i];
	if (Number(current.measureIndex) !== Number(previous.measureIndex) + 1)
		continue;
	if (Number(previous.matchScore ?? 1) < 0.4 && Number(current.matchScore ?? 1) < 0.4)
		process.exit(0);
}
process.exit(1);
NODE
}

run_one() {
	local score_dir="$1"
	local status_file="$2"
	local name
	local log_file
	name="$(basename "$score_dir")"
	log_file="$LOG_ROOT/$name.log"

	{
		echo "[$(date -Is)] START $score_dir"
		cd "$PROJECT_DIR"
		npx tsx tools/midi-annotator/claude.ts "$score_dir" "${EXTRA_ARGS[@]}"
		npx tsx tools/midi-annotator/visualize.ts "$score_dir"
		echo "[$(date -Is)] DONE $score_dir"
	} > "$log_file" 2>&1
	local status="$?"
	printf '%s\n' "$status" > "$status_file"
	return "$status"
}

running=0
total=0
started=0
success=0
fail=0
pids=()
names=()
logs=()
statuses=()
score_dirs=()

for score_dir in "$DIR"/*; do
	[ -d "$score_dir" ] || continue
	[ -f "$score_dir/spartito.json" ] || continue
	[ -f "$score_dir/transkun.mid" ] || continue
	if [ "$INCLUDE_HARD_FAILED" -eq 0 ] && is_hard_failed "$score_dir"; then
		echo "SKIP hard-failed: $(basename "$score_dir")"
		continue
	fi
	score_dirs+=("$score_dir")
done

total="${#score_dirs[@]}"

reap_finished() {
	local i
	for i in "${!pids[@]}"; do
		if kill -0 "${pids[$i]}" 2>/dev/null; then
			continue
		fi

		local name="${names[$i]}"
		local log_file="${logs[$i]}"
		local status_file="${statuses[$i]}"
		local status=1
		wait "${pids[$i]}" || true
		if [ -f "$status_file" ]; then
			status="$(cat "$status_file")"
		fi
		if [ "$status" -eq 0 ]; then
			success=$((success + 1))
			echo "OK: $name"
		else
			fail=$((fail + 1))
			echo "FAILED: $name (log: $log_file)"
		fi
		running=$((running - 1))
		unset 'pids[i]' 'names[i]' 'logs[i]' 'statuses[i]'
		pids=("${pids[@]}")
		names=("${names[@]}")
		logs=("${logs[@]}")
		statuses=("${statuses[@]}")
		return 0
	done
	return 1
}

start_next() {
	local score_dir="$1"
	local name
	local log_file
	local status_file
	name="$(basename "$score_dir")"
	log_file="$LOG_ROOT/$name.log"
	status_file="$STATUS_ROOT/$name.status"
	rm -f "$status_file"
	started=$((started + 1))
	echo "=== [$started] $name ==="
	run_one "$score_dir" "$status_file" &
	pids+=("$!")
	names+=("$name")
	logs+=("$log_file")
	statuses+=("$status_file")
	running=$((running + 1))
}

next=0
while [ "$next" -lt "$total" ] || [ "$running" -gt 0 ]; do
	while [ "$running" -lt "$JOBS" ] && [ "$next" -lt "$total" ]; do
		start_next "${score_dirs[$next]}"
		next=$((next + 1))
	done

	if [ "$running" -gt 0 ]; then
		wait -n || true
		while reap_finished; do :; done
	fi
done

echo "=== Summary ==="
echo "Total: $total  Success: $success  Failed: $fail"
echo "Logs: $LOG_ROOT"

if [ "$fail" -gt 0 ]; then
	exit 1
fi
