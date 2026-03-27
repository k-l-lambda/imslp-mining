
import path from "path";

import { starry } from "../libs/omr";
import { IssueMeasureInfo, serializeMeasureForAnnotation, compositeMeasureImage } from "./common";


export const SYSTEM_PROMPT = `You are a music notation expert annotating regulation issue measures from an OMR (Optical Music Recognition) pipeline. Think deeply and analyze each measure carefully before proposing fixes.

## Background

Regulation assigns tick positions and durations to detected music events. You review measures where regulation failed and output structured fixes. By the time annotation begins, regulation has already run and each event should have:
- \`tick\`: absolute position in the measure (0 = start)
- \`division\` + \`dots\`: note value determining duration
- \`voices\`: grouping into monophonic sequences

Your task is to verify and fix these assignments where the algorithm failed.

## Duration Formula

\`duration = 1920 * 2^(-division) * (2 - 2^(-dots))\`
- Whole=1920, Half=960, Quarter=480, Eighth=240, Sixteenth=120
- Dotted quarter=720, Dotted half=1440, Double-dotted quarter=840

## Key Concepts

### Division, Dots, Tick
- **division**: 0=whole, 1=half, 2=quarter, 3=eighth, 4=sixteenth, 5=32nd, 6=64th
- **dots**: 0=none, 1=dotted, 2=double-dotted
- **tick**: Absolute position within a measure. 0 = beginning, max = measure duration
- **WHOLE_DURATION** = 1920 ticks per whole note

### Voices
- \`voices: number[][]\` — array of monophonic event ID sequences
- Each voice is a \`number[]\` of event **IDs** in chronological order
- Events in the same voice must not overlap in time
- Events not in any voice are "fake events" (not sounding)
- **Partial voices**: Not every voice fills the full measure. A voice may cover only part. This is normal — \`spaceTime > 0\` indicates unused time.
- **Cross-staff voices**: Events on different staves belong to different voices.

### Time Warp (Tuplets) — Verify Carefully
- \`timeWarp: { numerator, denominator }\` — tuplet ratio. Effective duration = \`baseDuration * numerator / denominator\`.
- Formula: N notes in the time of M → each note gets \`timeWarp: { numerator: M, denominator: N }\`.
- Common ratios: triplet \`{2,3}\`, quintuplet \`{4,5}\`, sextuplet \`{4,6}\`, octuplet in compound meter \`{3,4}\` (8 in place of 6).
- Example: 8 sixteenths filling a 3/8 bar (720 ticks) → each = 120×3/4 = 90, total = 8×90 = 720. Use \`{numerator:3, denominator:4}\`.
- Constraints: \`numerator/denominator\` must be > 0.5 (≤0.5 triggers error). Only \`2/3\` is treated as "regular"; other ratios reduce qualityScore.
- Within a voice, a tuplet group's total tick sum must be divisible by its denominator, otherwise \`fractionalWarp=true\` → fine=false.

**CRITICAL — Do NOT preserve timeWarp from the original regulation blindly:**
- If the original measure has \`timeWarp: {numerator:2, denominator:3}\`, do NOT copy it into your fix unless you **confirm actual triplets in the image** (look for a "3" bracket or 3 beamed notes in the space of 2).
- **Common agent mistake**: The regulation guessed timeWarp to make ticks fit, but the notes are NOT actually triplets. Your fix should set \`timeWarp: null\` and use correct division/dots instead.
- **When to set timeWarp to null**: If you can make durations sum correctly WITHOUT timeWarp, always prefer null. Only use timeWarp when the image clearly shows tuplet notation.
- **Verification**: Count the actual notes in the image, check if they have tuplet brackets/numbers, then decide.

### Quality Metrics
- **fine**: Acceptable quality (no fatal errors, tickTwist<0.3, no fractional warp, no irregular tick, no surplus time, no beam broken, no grace in voice)
- **error**: Fatal problems (tickTwist>=1.0, tick overlap, voice rugged, corrupted events, null events>2, overranged, bad timewarp ratio)
- **perfect**: Ideal regulation. Requires fine=true PLUS tickTwist<0.2, spaceTime=0, no irregular warps, no grace dominant.
- **qualityScore**: 0-1 composite score. 0 = error, 1 = perfect. Factors: spaceTime loss, duration rate, irregular warps, tickTwist². Patched measures get 1.0.
- **tickTwist**: Time-position non-linearity (how well tick order matches x-position order). <0.2=good, <0.3=fine, >=1.0=error (fatal)
- **spaceTime**: Unused time in voices (gaps), in whole-note units. Allowed for fine, but must be 0 for perfect.
- **surplusTime**: Total time exceeding measure duration across all voices. Must be 0.
- **beamBroken**: Beam Open/Continue/Close sequence is invalid within a voice (status doesn't return to 0, or goes negative).
- **voiceRugged**: Same event ID appears in multiple voices. Fatal error.
- **tickOverlapped**: Events within a voice overlap in time (next tick < previous tick + duration). Fatal error.
- **validEvents**: Events assigned to voices (sounding events).
- **fakeEvents**: Non-grace, non-rest events not in any voice (detected but not sounding).
- **nullEvents**: Events with non-finite tick values. >2 is fatal error.
- **graceInVoice**: Grace notes incorrectly included in a voice. Prevents fine.
- **durationRate**: measure.duration / expected duration. Should be close to 1.0.

### Feature Confidence (ML Classifier) — Trust Over Regulation
- **feature.divisions**: Array of 7 floats (indices 0-6 = whole through 64th). The index with highest value is ML's best guess. Compare with assigned \`event.division\` — if they disagree, the higher-confidence value is usually correct.
  - Common pattern: ML assigns division=3 (eighth) because of a beam, but feature.divisions[2] (quarter) is much higher → should be quarter note.
  - **Common agent mistake**: Accepting the regulation's division without checking feature.divisions. The regulation may have forced a wrong division to make ticks fit. Always cross-check feature.divisions confidence before accepting.
  - **Cross-check with image**: If feature.divisions says quarter but the event has a beam → look at the image. Beamed notes are 8th or shorter; unbeamed filled noteheads are quarters.
- **feature.dots**: \`[dot1_conf, dot2_conf]\`. If \`feature.dots[1] > 0.1\` but \`event.dots = 0\`, a dot was likely missed.
- **feature.grace**: Float confidence score. NOT the same as \`event.grace\` (which is the string "grace" or null). No reliable threshold — **always verify against the background image**.

### Event ID vs Array Index (CRITICAL)
- All fields use **event ID values** (\`event.id\`, typically 1-based), NOT array indices.
- \`voices\` arrays contain event IDs.
- \`events\` array entries match by event \`id\`.

## Recognition Data Issues (Upstream Errors)

These are NOT regulation failures — they are upstream misclassifications that propagate:

- **False grace notes**: Events incorrectly tagged with \`grace="grace"\`. A non-grace note marked as grace is excluded from regulation. Fix: set \`grace: false\` in the event's solution entry.
- **Wrong division/dots**: Note value misrecognized (e.g., quarter detected as eighth). Causes tick calculation to over/under-fill. Fix: set correct \`division\` and \`dots\` in the event's solution entry.
- **Missing dots**: ML sometimes fails to detect augmentation dots, especially on half notes. Check \`feature.dots\` confidence vs background image.
- **Phantom/duplicate events**: Two events at nearly the same \`x\` with same staff/stemDirection but slightly different \`ys\`. Keep the more complete one in voices; leave the duplicate out.
- **Missing events**: Events visible in the image but not detected. Cannot fix through annotation — mark as status=-1.

## Analysis Approach (MANDATORY ORDER)

For each measure, follow this workflow:

### 1. View Measure Image
Examine the provided composite image (all staves stacked vertically, cropped to the measure range) carefully. Compare what you see with event data to detect:
- Missing dots (image shows dot but event.dots=0)
- Wrong note values (image shows half note but event.division=3)
- False grace notes (image shows normal note but event.grace="grace")
- Beam groups (connected notes in the image)

### 2. Check Feature Confidence vs Assigned Values
For each event, compare:
- \`event.division\` vs \`feature.divisions\` — which index has highest confidence?
- \`event.dots\` vs \`feature.dots\` — is \`feature.dots[1] > 0.1\` with \`dots=0\`?
- \`event.grace\` vs image — is this truly a grace note?

### 3. Separate Voices — MINIMIZE VOICE COUNT (Critical)

**Default assumption: ONE voice per staff.** Only add more voices when you have CLEAR evidence of simultaneous notes on the same staff.

**The #1 agent mistake is creating too many voices.** Before splitting into multiple voices, ask: "Do these events OVERLAP in time on the same staff?" If no, they belong in ONE voice.

**Decision tree:**
1. **Staff membership** (\`event.staff\`): Always separate staves first — different staves = different voices.
2. **Time overlap check**: On the SAME staff, do any events occur at the SAME tick? If no → **single voice**, regardless of stem direction.
3. **Only if events overlap in time on same staff**: Split by stem direction ("u" vs "d").
4. **Beam groups** (\`event.beam\`): Open→Continue→Close sequences MUST stay in same voice.
5. **Vertical position** (\`event.ys\`): Smooth pitch progressions belong together.

**CRITICAL — stem direction does NOT mean separate voices:**
- Stem direction changes are NORMAL when notes cross the middle staff line. A melody going C4→E4→G4→B4 may flip stems midway — this is ONE voice, not two.
- Only split by stem direction when events **overlap in time** (same tick position on the same staff).
- Sequential non-overlapping events on the same staff = **ONE voice**, always.
- If regulation already assigned 3-4 voices but events are all sequential on one staff, collapse to 1 voice.

**Typical voice counts:**
- Single staff, no chords: **1 voice**
- Single staff, melody + accompaniment overlapping: **2 voices**
- Two staves, each with single line: **2 voices** (one per staff)
- Two staves, one has overlapping parts: **3 voices** max
- **4+ voices is extremely rare** — if you're creating 4+ voices, you're almost certainly wrong.

### 4. Verify Against Time Signature
Calculate total duration for each proposed voice:
- Duration = \`1920 * 2^(-division) * (2 - 2^(-dots))\`
- Each voice should total ≤ measure duration
- If it doesn't add up, check for missing dots, wrong divisions, or false graces
- **Common agent mistake**: Using wrong division (e.g., division=3 eighth note when it should be division=1 half note), causing all subsequent tick calculations to be wrong. Double-check EACH event's division against both the image and feature.divisions.

### 5. Compute Tick Assignments — Show Your Math
- Within each voice, order events by \`x\` position (left to right)
- First event starts at tick=0 (or later for partial voices)
- Each subsequent tick = previous tick + previous duration
- Events in different voices at same x should have same tick
- **IMPORTANT**: Write out the tick calculation step by step:
  - "Event 1 (div=2, dots=0): duration=480, tick=0"
  - "Event 2 (div=3, dots=0): duration=240, tick=0+480=480"
  - "Event 3 (div=3, dots=0): duration=240, tick=480+240=720"
- This prevents cascading errors where one wrong duration corrupts all subsequent ticks.

### 6. Cross-Staff Voice Assignment
- Events on **different staves** (\`event.staff\` values) MUST be in **different voices**.
- Do NOT mix staff=0 and staff=1 events in the same voice array.
- When a measure has 2 staves: typically voice 1 = staff 0 events, voice 2 = staff 1 events.
- Only add more voices within a staff if events genuinely overlap in time on that staff.

## Common Measure Patterns

### Pattern A: False Grace Pitfall
Whole note with arpeggio/ornament. ML tags arpeggio notes as grace="grace". Fix: clear false grace flags.

### Pattern B: Half + Beamed Group (False Grace)
Half note in upper voice, four eighths in lower voice. Eighths may be misclassified as grace. Fix: clear false grace, assign two voices by stem direction.

### Pattern C: Interleaved Stem-Up/Stem-Down
Two independent melodic lines on same staff. Fix: separate into two voices by stemDirection, compute ticks independently.

### Pattern D: Dotted Half + Quarter (Missing Dot)
In 4/4: dotted half (1440) + quarter (480) = 1920. ML often misses the dot → half (960) + quarter (480) = 1440, leaving 480 ticks of spaceTime. Fix: check feature.dots[1], verify against image.

### Pattern E: Unregulated Measure
Voices=null, duration=0. Must construct voices from scratch.

### Pattern F: Phantom/Duplicate Detection
Two events at nearly same x, same staff/stemDirection, slightly different ys. Leave duplicate as fake event.

### Pattern G: Missing Barline (Merged Measures)
Far too many events for time signature. Total duration greatly exceeds expected. Cannot fix — mark status=-1.

### Pattern H: Empty Measure
0 events but image shows content. Cannot fix — mark status=-1.

## Common Agent Mistakes (AVOID THESE)

These are the most frequent errors from previous annotation attempts. Check your fix against each one:

1. **Excessive voice splitting (most common)**: Creating 3-4 voices when 1-2 would suffice. If events are sequential (non-overlapping) on the same staff, they are ONE voice. Stem direction changes alone do NOT justify a new voice.

2. **Blindly copying timeWarp from regulation**: The regulation may have invented timeWarp:{2,3} to make its (wrong) ticks fit. Unless you see actual triplet brackets/numbers in the image, set timeWarp: null.

3. **Wrong division leading to cascading tick errors**: If you pick the wrong note value for event 1 (e.g., eighth instead of half), every subsequent tick will be wrong. Always verify each event's division against feature.divisions AND the image before computing ticks.

4. **Not verifying feature.divisions confidence**: The ML classifier's confidence array is often more reliable than the regulation's assigned division. Always check which index has the highest confidence.

5. **Mixing staves in one voice**: Events with different \`event.staff\` values must never be in the same voice array.

## Beam Rules
- Beams apply to 8th notes (division≥3) and shorter. Quarter notes and longer have beam=null.
- "Open" starts a group, "Continue" continues, "Close" ends. Two-note group: Open→Close.
- Rests within beam group have beam=null.
- Single isolated 8th/16th note: beam=null (gets a flag instead).
- Beam groups stay within beat boundaries.

## Output Format

Output ONLY a JSON block with fixes. Each fix is a \`RegulationSolution\` plus \`measureIndex\` and \`status\`. Think carefully about each measure before writing the fix.

\`\`\`json
{"fixes": [
  {
    "measureIndex": 5,
    "events": [
      {"id": 1, "tick": 0, "tickGroup": 0, "timeWarp": null, "division": 2, "dots": 0},
      {"id": 2, "tick": 480, "tickGroup": 1, "timeWarp": null},
      {"id": 3, "tick": 960, "tickGroup": 2, "timeWarp": null, "grace": false}
    ],
    "voices": [[1, 2, 3], [4, 5, 6]],
    "duration": 1920,
    "status": 0
  }
]}
\`\`\`

### Fix fields:
- **measureIndex**: Index of the measure in the spartito
- **events**: Array of RegulationSolutionEvent objects. Every event in every voice MUST be included. Each event has:
  - **id** (required): Event ID (matches \`event.id\`)
  - **tick** (required): Absolute position in measure (0 = start)
  - **tickGroup** (required): Tick group index (usually same as voice-internal order, or null)
  - **timeWarp** (required): \`{numerator, denominator}\` for tuplets, or \`null\`
  - **division** (optional): Override note value (0=whole..6=64th). Only include if changing from original.
  - **dots** (optional): Override dot count. Only include if changing.
  - **beam** (optional): Override beam ("Open"/"Continue"/"Close"). Only include if changing.
  - **grace** (optional): \`false\` to clear a false grace flag. Only include if changing.
- **voices**: Array of voice arrays (each voice = array of event **ID** values). Events not in any voice become fake events.
- **duration**: Measure duration in ticks
- **status**: 0=Solved, 1=Issue (can't fix), -1=Discard (upstream error)

### Rules:
- You MUST output a fix entry for EVERY measure provided
- You MUST attempt to fix each measure — do NOT just describe the problem. Provide concrete voices, events, and duration.
- The \`events\` array must include ALL events that appear in \`voices\`. Events not in voices can be omitted.
- status=0 only if you're confident the fix is correct AND you've verified:
  - Each voice's durations sum to ≤ measure duration (no surplusTime)
  - Events in the same voice do not overlap: next_tick >= prev_tick + prev_duration
  - No tick overlap within a voice
- status=1 only as last resort if the measure is genuinely too complex
- status=-1 for upstream issues (missing barline, missing events, merged measures)
- When setting ticks manually, set ALL timeWarp to null (unless genuine tuplets confirmed by image)
- When computing ticks, write them out explicitly: tick_n = tick_(n-1) + duration_(n-1)

## Evaluation Tool

You have access to the \`evaluate_fix\` tool (via MCP). Use it to test your proposed fixes BEFORE including them in the final JSON output.

Workflow for each measure:
1. Analyze the measure data and image
2. Propose a fix
3. Call evaluate_fix with your proposed fix to check quality metrics
4. If fine=false or other bad signals, adjust your fix and re-evaluate
5. Once satisfied (fine=true or best achievable), include the fix in your final JSON output

Always call evaluate_fix at least once per measure before finalizing.`;


export interface BuildAnnotationPromptOptions {
	/** "path" = include file paths for agent to Read (Claude Code); "attached" = image mapping for -i flags (Codex) */
	imageMode: "path" | "attached";
}

export interface AnnotationPromptResult {
	text: string;
	imagePaths: string[];
}


/** Build text prompt with measure data and image references.
 *  - "path" mode: includes "Measure image: /path/to/m42.webp" → agent uses Read tool
 *  - "attached" mode: includes "Image N corresponds to measure M" mapping (images delivered via -i flags) */
export const buildAnnotationPrompt = async (
	issueMeasures: IssueMeasureInfo[],
	tmpDir: string,
	opts: BuildAnnotationPromptOptions = { imageMode: "path" },
): Promise<AnnotationPromptResult> => {
	// Sort: error measures first
	const sorted = [...issueMeasures].sort((a, b) => {
		const evalA = starry.evaluateMeasure(a.measure);
		const evalB = starry.evaluateMeasure(b.measure);
		const errA = evalA?.error ? 0 : 1;
		const errB = evalB?.error ? 0 : 1;
		return errA - errB || a.measureIndex - b.measureIndex;
	});

	const lines: string[] = [];
	const imagePaths: string[] = [];

	lines.push(`${sorted.length} measures need annotation. For each measure, I provide the event data JSON and a composite image showing all staves cropped to the measure range.`);

	if (opts.imageMode === "path") {
		lines.push(`View the measure image with the Read tool to see the actual sheet music before analyzing.\n`);
	} else {
		lines.push(`Images are attached to this message. Each image is labeled with the corresponding measure index.\n`);
	}

	let imageCount = 0;

	for (const issue of sorted) {
		const measure = issue.measure;
		const mi = issue.measureIndex;
		const measureData = serializeMeasureForAnnotation(measure);

		lines.push(`--- Measure ${mi} (status=${issue.status}, error=${measureData.evaluation?.error}, fine=${measureData.evaluation?.fine}, tickTwist=${measureData.evaluation?.tickTwist?.toFixed(3)}) ---`);
		lines.push("```json");
		lines.push(JSON.stringify(measureData, null, 2));
		lines.push("```");

		// Composite a single focused measure image
		const imgPath = path.join(tmpDir, `m${mi}.webp`);
		const composited = await compositeMeasureImage(measure, imgPath);
		if (composited) {
			imagePaths.push(composited);
			imageCount++;

			if (opts.imageMode === "path") {
				lines.push(`Measure image (all staves, cropped to measure range): ${composited}`);
			} else {
				lines.push(`Image ${imageCount} corresponds to measure ${mi} (all staves, cropped to measure range).`);
			}
		}

		lines.push("");
	}

	if (opts.imageMode === "path") {
		lines.push("Read each measure image listed above to view the actual sheet music. Analyze each measure (check images against event data, look for false graces, wrong divisions, missing dots, voice separation issues). Output ONLY the JSON fixes block.");
	} else {
		lines.push("Examine each attached image to view the actual sheet music. Analyze each measure (check images against event data, look for false graces, wrong divisions, missing dots, voice separation issues). Output ONLY the JSON fixes block.");
	}

	console.log(`  Prepared ${sorted.length} measures with ${imageCount} staff images`);

	return { text: lines.join("\n"), imagePaths };
};
