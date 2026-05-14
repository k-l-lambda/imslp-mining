#!/bin/bash
# Usage: ./tools/midiAnnotateBatch.sh <scores-dir> [--jobs N] [extra claude.ts args...]
# Runs tools/midi-annotator/claude.ts concurrently on score directories containing spartito.json and transkun.mid.

set -euo pipefail

if [ $# -lt 1 ]; then
	echo "Usage: $0 <scores-dir> [--jobs N] [extra claude.ts args...]"
	exit 1
fi

DIR="$1"
shift

if [ ! -d "$DIR" ]; then
	echo "Directory not found: $DIR"
	exit 1
fi

JOBS=1
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
mkdir -p "$LOG_ROOT"

run_one() {
	local score_dir="$1"
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
}

running=0
total=0
success=0
fail=0
pids=()
names=()
logs=()

reap_one() {
	local pid="$1"
	local name="$2"
	local log_file="$3"
	if wait "$pid"; then
		success=$((success + 1))
		echo "OK: $name"
	else
		fail=$((fail + 1))
		echo "FAILED: $name (log: $log_file)"
	fi
	running=$((running - 1))
}

for score_dir in "$DIR"/*; do
	[ -d "$score_dir" ] || continue
	[ -f "$score_dir/spartito.json" ] || continue
	[ -f "$score_dir/transkun.mid" ] || continue

	total=$((total + 1))
	name="$(basename "$score_dir")"
	log_file="$LOG_ROOT/$name.log"
	echo "=== [$total] $name ==="
	run_one "$score_dir" &
	pids+=("$!")
	names+=("$name")
	logs+=("$log_file")
	running=$((running + 1))

	if [ "$running" -ge "$JOBS" ]; then
		reap_one "${pids[0]}" "${names[0]}" "${logs[0]}"
		pids=("${pids[@]:1}")
		names=("${names[@]:1}")
		logs=("${logs[@]:1}")
	fi
done

while [ "${#pids[@]}" -gt 0 ]; do
	reap_one "${pids[0]}" "${names[0]}" "${logs[0]}"
	pids=("${pids[@]:1}")
	names=("${names[@]:1}")
	logs=("${logs[@]:1}")
done

echo "=== Summary ==="
echo "Total: $total  Success: $success  Failed: $fail"
echo "Logs: $LOG_ROOT"

if [ "$fail" -gt 0 ]; then
	exit 1
fi
