
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import fetch from "isomorphic-fetch";
import sharp from "sharp";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../env";

import { ANNOTATION_API_KEY, ANNOTATION_BASE_URL, ANNOTATION_MAX_TOKENS, ANNOTATION_MODEL as DEFAULT_ANNOTATION_MODEL, BEAD_PICKER_URL, IMAGE_BED, OMR_API_BASE, ORT_SESSION_OPTIONS } from "./libs/constants";
import { starry, regulateWithBeadSolver } from "./libs/omr";
import OnnxBeadPicker from "./libs/onnxBeadPicker";
import remoteSolutionStore from "./libs/remoteSolutionStore";



const argv = yargs(hideBin(process.argv))
	.command(
		"$0 <input> [options]",
		"Regulate and annotate a single spartito file.",
		yargs => yargs
			.positional("input", { type: "string", demandOption: true, describe: "Path to .spartito.json file" })
			.option("output", { alias: "o", type: "string", describe: "Output path (no file written if omitted)" })
			.option("fetch-server", { type: "boolean", default: false, describe: "Fetch existing server annotations before annotating" })
			.option("logger", { alias: "l", type: "boolean", describe: "Enable verbose logging" })
			.option("skip-annotation", { type: "boolean", describe: "Skip the annotation step" })
			.option("force-regulate", { type: "boolean", describe: "Force re-regulation even if already regulated" })
			.option("annotation-model", { type: "string", describe: "Model for annotation (overrides ANNOTATION_MODEL env)" })
			.option("max-rounds", { type: "number", default: 3, describe: "Max annotation rounds" })
		,
	).help().argv;


const PICKER_SEQS = [32, 64, 128, 512];

// Annotation config — CLI --annotation-model overrides env
const ANNOTATION_MODEL = argv.annotationModel || DEFAULT_ANNOTATION_MODEL;

// Image API for fetching staff images when local IMAGE_BED is unavailable
const IMAGE_API_BASE = process.env.IMAGE_API_BASE;

// API integration
const API_BASE = OMR_API_BASE;

/** Fetch JSON from the OMR service API. */
const apiFetch = async (endpoint: string, options: RequestInit = {}): Promise<any> => {
	const url = `${API_BASE}${endpoint}`;
	const res = await fetch(url, {
		...options,
		headers: { "Content-Type": "application/json", ...options.headers as Record<string, string> },
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`API ${options.method ?? "GET"} ${endpoint} → ${res.status}: ${text.substring(0, 200)}`);
	}
	const json: any = await res.json();
	// Unwrap { code, data } envelope if present
	return json?.data !== undefined ? json.data : json;
};


// ── Image helpers ───────────────────────────────────────────────────────────

const resolveImageSource = (url: string): { type: "local"; path: string } | { type: "remote"; url: string } | null => {
	if (!url)
		return null;
	const match = url.match(/^(\w+):(.*)/);
	if (match?.[1] === "md5") {
		const filename = match[2];
		// Try local IMAGE_BED first
		if (IMAGE_BED) {
			const localPath = path.join(IMAGE_BED, filename);
			if (fs.existsSync(localPath))
				return { type: "local", path: localPath };
		}
		// Fallback to remote API
		if (IMAGE_API_BASE)
			return { type: "remote", url: `${IMAGE_API_BASE}/${filename}` };
		return null;
	}
	if (fs.existsSync(url))
		return { type: "local", path: url };
	return null;
};


/** Download a remote image to a local file. Returns null if already local. */
const downloadImageToFile = async (
	source: { type: "local"; path: string } | { type: "remote"; url: string },
	destPath: string,
): Promise<string | null> => {
	if (source.type === "local")
		return source.path;
	try {
		const resp = await fetch(source.url);
		if (!resp.ok)
			return null;
		const buf = Buffer.from(await resp.arrayBuffer());
		fs.writeFileSync(destPath, buf);
		return destPath;
	}
	catch {
		return null;
	}
};


/** Composite a single focused measure image from all staff backgrounds.
 *  Crops each staff image to the measure's horizontal range (+ padding),
 *  then stacks them vertically. Returns the output path. */
const MEASURE_IMAGE_PADDING = 2; // interval units on each side

/** Fetch image buffer from local path or remote URL, with retry for transient errors. */
const FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY = 500; // ms

const fetchImageBuffer = async (
	source: { type: "local"; path: string } | { type: "remote"; url: string },
): Promise<Buffer | null> => {
	if (source.type === "local")
		return fs.readFileSync(source.path);
	for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
		try {
			const resp = await fetch(source.url);
			if (!resp.ok) {
				console.warn(`    fetch failed (${resp.status}): ${source.url} [attempt ${attempt}/${FETCH_RETRIES}]`);
				if (attempt < FETCH_RETRIES)
					await new Promise(r => setTimeout(r, FETCH_RETRY_DELAY * attempt));
				continue;
			}
			return Buffer.from(await resp.arrayBuffer());
		}
		catch (err: any) {
			console.warn(`    fetch error: ${source.url} — ${err.message} [attempt ${attempt}/${FETCH_RETRIES}]`);
			if (attempt < FETCH_RETRIES)
				await new Promise(r => setTimeout(r, FETCH_RETRY_DELAY * attempt));
		}
	}
	return null;
};

const compositeMeasureImage = async (
	measure: starry.SpartitoMeasure,
	destPath: string,
): Promise<string | null> => {
	if (!measure.backgroundImages?.length || !measure.position)
		return null;

	const pos = measure.position;
	const bgImgs = measure.backgroundImages;

	// Measure crop range in unit coords
	const padUnits = MEASURE_IMAGE_PADDING;
	const cropLeftUnit = pos.left - padUnits;
	const cropRightUnit = pos.right + padUnits;

	// Process each staff image: crop to measure range
	const crops: { buffer: Buffer; width: number; height: number }[] = [];
	const GAP = 4; // pixels gap between staves in composite

	for (const bgImg of bgImgs) {
		const source = resolveImageSource(bgImg.url);
		if (!source)
			continue;

		const buf = await fetchImageBuffer(source);
		if (!buf)
			continue;

		const meta = await sharp(buf).metadata();
		if (!meta.width || !meta.height)
			continue;

		const imgPpu = meta.width / bgImg.position.width;

		// Crop coordinates in pixels (relative to this image)
		const leftPx = Math.max(0, Math.round((cropLeftUnit - bgImg.position.x) * imgPpu));
		const rightPx = Math.min(meta.width, Math.round((cropRightUnit - bgImg.position.x) * imgPpu));
		const w = rightPx - leftPx;
		if (w <= 0)
			continue;

		const cropped = await sharp(buf)
			.extract({ left: leftPx, top: 0, width: w, height: meta.height })
			.toBuffer();

		crops.push({ buffer: cropped, width: w, height: meta.height });
	}

	if (crops.length === 0)
		return null;

	// Stack vertically with small gap
	const totalWidth = Math.max(...crops.map(c => c.width));
	const totalHeight = crops.reduce((sum, c) => sum + c.height, 0) + GAP * (crops.length - 1);

	const compositeInputs: sharp.OverlayOptions[] = [];
	let y = 0;
	for (const crop of crops) {
		compositeInputs.push({ input: crop.buffer, left: 0, top: y });
		y += crop.height + GAP;
	}

	await sharp({
		create: { width: totalWidth, height: totalHeight, channels: 3, background: { r: 255, g: 255, b: 255 } },
	})
		.composite(compositeInputs)
		.webp({ quality: 90 })
		.toFile(destPath);

	return destPath;
};


// ── Measure data serialization ──────────────────────────────────────────────

const serializeMeasureForAnnotation = (measure: starry.SpartitoMeasure) => {
	const events = measure.events.map((e, i) => ({
		index: i,
		id: e.id,
		staff: e.staff,
		x: e.x,
		ys: e.ys,
		rest: e.rest,
		division: e.division,
		dots: e.dots,
		grace: e.grace,
		beam: e.beam,
		stemDirection: e.stemDirection,
		tick: e.tick,
		timeWarp: e.timeWarp,
		tremolo: e.tremolo,
		tremoloLink: e.tremoloLink,
		feature: e.feature ? {
			divisions: e.feature.divisions,
			dots: e.feature.dots,
			grace: e.feature.grace,
			beams: e.feature.beams,
		} : undefined,
	}));

	const evaluation = measure.regulated ? starry.evaluateMeasure(measure) : undefined;

	return {
		measureIndex: measure.measureIndex,
		staffMask: measure.staffMask,
		timeSignature: measure.timeSignature,
		duration: measure.duration,
		voices: measure.voices,
		events,
		evaluation,
	};
};


// ── Annotation logic ────────────────────────────────────────────────────────

interface IssueMeasureInfo {
	measureIndex: number;
	status: number;
	measure: starry.SpartitoMeasure;
}


const SYSTEM_PROMPT = `You are a music notation expert annotating regulation issue measures from an OMR (Optical Music Recognition) pipeline. Think deeply and analyze each measure carefully before proposing fixes.

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

### Time Warp (Tuplets)
- \`timeWarp: { numerator, denominator }\` — tuplet ratio
- Triplets: \`{ numerator: 2, denominator: 3 }\` (3 notes in the time of 2)

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

### Feature Confidence (ML Classifier)
- **feature.divisions**: Array of 7 floats (indices 0-6 = whole through 64th). The index with highest value is ML's best guess. Compare with assigned \`event.division\` — if they disagree, the higher-confidence value is usually correct.
  - Common pattern: ML assigns division=3 (eighth) because of a beam, but feature.divisions[2] (quarter) is much higher → should be quarter note.
- **feature.dots**: \`[no_dot_conf, dot_conf]\`. If \`feature.dots[1] > 0.1\` but \`event.dots = 0\`, a dot was likely missed.
- **feature.grace**: Float confidence score. NOT the same as \`event.grace\` (which is the string "grace" or null). No reliable threshold — **always verify against the background image**.

### Event ID vs Array Index (CRITICAL)
- \`clearGrace\` and \`setDivision\` use **0-based array indices** into \`measure.events[]\`
- \`voices\` arrays contain **event ID values** (\`event.id\`, typically 1-based)
- \`events\` patches match by event **id**
- **These are DIFFERENT numbering systems!**

## Recognition Data Issues (Upstream Errors)

These are NOT regulation failures — they are upstream misclassifications that propagate:

- **False grace notes**: Events incorrectly tagged with \`grace="grace"\`. A non-grace note marked as grace is excluded from regulation. Fix: clear the grace flag via \`clearGrace\` (array indices).
- **Wrong division/dots**: Note value misrecognized (e.g., quarter detected as eighth). Causes tick calculation to over/under-fill. Fix: correct via \`setDivision\` (array indices) or \`events\` patches (by ID).
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

### 3. Separate Voices (in order of reliability)
1. **Staff membership** (\`event.staff\`): Always separate staves first.
2. **Stem direction** (\`event.stemDirection\`): Within same staff, "u"=upper voice, "d"=lower voice.
3. **Beam groups** (\`event.beam\`): Open→Continue→Close sequences MUST stay in same voice.
4. **X-position**: Events at same x but different stems → different voices.
5. **Vertical position** (\`event.ys\`): Smooth pitch progressions belong together.

**IMPORTANT — stem direction does NOT always mean separate voices:**
- Only split by stem direction when events **overlap in time** (same or overlapping tick positions on the same staff).
- Sequential non-overlapping events on the same staff should stay in **one voice** even if stem direction changes partway through. Stem flips are normal when notes cross the middle staff line — this does NOT indicate a new voice.
- When in doubt, prefer **fewer voices** (merge) over more voices (split).

### 4. Verify Against Time Signature
Calculate total duration for each proposed voice:
- Duration = \`1920 * 2^(-division) * (2 - 2^(-dots))\`
- Each voice should total ≤ measure duration
- If it doesn't add up, check for missing dots, wrong divisions, or false graces

### 5. Compute Tick Assignments
- Within each voice, order events by \`x\` position (left to right)
- First event starts at tick=0 (or later for partial voices)
- Each subsequent tick = previous tick + previous duration
- Events in different voices at same x should have same tick

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

## Beam Rules
- Beams apply to 8th notes (division≥3) and shorter. Quarter notes and longer have beam=null.
- "Open" starts a group, "Continue" continues, "Close" ends. Two-note group: Open→Close.
- Rests within beam group have beam=null.
- Single isolated 8th/16th note: beam=null (gets a flag instead).
- Beam groups stay within beat boundaries.

## Output Format

Output ONLY a JSON block with fixes. Think carefully about each measure before writing the fix.

\`\`\`json
{"fixes": [
  {
    "measureIndex": 5,
    "clearGrace": [2, 3],
    "setDivision": {"2": {"division": 2, "dots": 0}},
    "voices": [[1, 2, 3], [4, 5, 6]],
    "events": [{"id": 1, "tick": 0, "division": 2, "dots": 0, "timeWarp": null}],
    "duration": 1920,
    "status": 0
  }
]}
\`\`\`

### Fix fields (all optional per measure):
- **clearGrace**: 0-based event **array indices** to clear grace flag
- **setDivision**: map of 0-based event **array index** → {division, dots}
- **voices**: array of voice arrays (each voice = array of event **ID** values, NOT indices)
- **events**: partial event patches matched by event **id** (tick/division/dots/timeWarp/beam)
- **duration**: corrected measure duration
- **status**: 0=Solved, 1=Issue (can't fix), -1=Discard (upstream error)

### Rules:
- You MUST output a fix entry for EVERY measure provided
- You MUST attempt to fix each measure — do NOT just describe the problem. Provide concrete voices, events, and division corrections.
- status=0 only if you're confident the fix is correct AND you've verified:
  - Each voice's durations sum to ≤ measure duration (no surplusTime)
  - Events in the same voice do not overlap: next_tick >= prev_tick + prev_duration
  - No tick overlap within a voice
- status=1 only as last resort if the measure is genuinely too complex
- status=-1 for upstream issues (missing barline, missing events, merged measures)
- When setting ticks manually, clear ALL timeWarp to null (unless genuine tuplets confirmed by image)
- voices arrays use event.id values; clearGrace/setDivision use 0-based array indices
- Do NOT include a "comment" field — only the fix fields listed above
- ALWAYS provide voices and events together — voices alone without tick corrections rarely work
- When computing ticks, write them out explicitly: tick_n = tick_(n-1) + duration_(n-1)

## Evaluation Tool

You have access to the \`evaluate_fix\` tool (via MCP). Use it to test your proposed fixes BEFORE including them in the final JSON output.

Workflow for each measure:
1. Analyze the measure data and image
2. Propose a fix
3. Call evaluate_fix with your proposed fix to check quality metrics
4. If fine=false or tickTwist is high, adjust your fix and re-evaluate
5. Once satisfied (fine=true or best achievable), include the fix in your final JSON output

Always call evaluate_fix at least once per measure before finalizing.`;


/** Build text prompt with image file paths for claude -p. Downloads remote images to tmpDir. */
const buildAnnotationPrompt = async (
	issueMeasures: IssueMeasureInfo[],
	tmpDir: string,
): Promise<string> => {
	// Sort: error measures first
	const sorted = [...issueMeasures].sort((a, b) => {
		const evalA = starry.evaluateMeasure(a.measure);
		const evalB = starry.evaluateMeasure(b.measure);
		const errA = evalA?.error ? 0 : 1;
		const errB = evalB?.error ? 0 : 1;
		return errA - errB || a.measureIndex - b.measureIndex;
	});

	const lines: string[] = [];
	lines.push(`${sorted.length} measures need annotation. For each measure, I provide the event data JSON and a composite image showing all staves cropped to the measure range.`);
	lines.push(`View the measure image with the Read tool to see the actual sheet music before analyzing.\n`);

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
			lines.push(`Measure image (all staves, cropped to measure range): ${composited}`);
			imageCount++;
		}

		lines.push("");
	}

	lines.push("Read each measure image listed above to view the actual sheet music. Analyze each measure (check images against event data, look for false graces, wrong divisions, missing dots, voice separation issues). Output ONLY the JSON fixes block.");

	console.log(`  Prepared ${sorted.length} measures with ${imageCount} staff images`);

	return lines.join("\n");
};


const parseFixes = (output: string): any[] => {
	// Try to extract JSON block from markdown code fence
	const jsonMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[1]);
			return parsed.fixes || [];
		}
		catch {}
	}

	// Fallback: try to parse the entire output as JSON
	try {
		const parsed = JSON.parse(output.trim());
		return parsed.fixes || [];
	}
	catch {}

	// Fallback: find first { ... } that contains "fixes"
	const braceMatch = output.match(/\{[\s\S]*"fixes"\s*:\s*\[[\s\S]*\]\s*\}/);
	if (braceMatch) {
		try {
			const parsed = JSON.parse(braceMatch[0]);
			return parsed.fixes || [];
		}
		catch {}
	}

	// Fallback for truncated output: extract individual fix objects
	const fixObjects: any[] = [];
	const fixPattern = /\{\s*"measureIndex"\s*:\s*\d+[\s\S]*?"status"\s*:\s*-?\d+\s*\}/g;
	let match;
	while ((match = fixPattern.exec(output)) !== null) {
		try {
			fixObjects.push(JSON.parse(match[0]));
		}
		catch {}
	}
	if (fixObjects.length > 0) {
		console.log(`  Parsed ${fixObjects.length} fixes from truncated output`);
		return fixObjects;
	}

	console.warn("Failed to parse annotation fixes from output");
	return [];
};


const applyFixes = (spartito: starry.Spartito, fixes: any[]) => {
	let applied = 0;

	for (const fix of fixes) {
		const mi = fix.measureIndex;
		const measure = spartito.measures[mi];
		if (!measure) {
			console.warn(`Measure ${mi} not found, skipping fix`);
			continue;
		}

		// Evaluate before fix
		const evalBefore = starry.evaluateMeasure(measure);
		const twistBefore = evalBefore?.tickTwist ?? Infinity;

		// Save original state for rollback
		const snapshot = JSON.stringify({
			events: measure.events,
			voices: measure.voices,
			duration: measure.duration,
		});

		// Clear grace flags
		if (fix.clearGrace?.length) {
			for (const idx of fix.clearGrace) {
				if (measure.events[idx]) {
					measure.events[idx].grace = null as any;
				}
			}
		}

		// Set division/dots
		if (fix.setDivision) {
			for (const [idx, val] of Object.entries(fix.setDivision)) {
				const event = measure.events[Number(idx)];
				if (event && val) {
					event.division = (val as any).division;
					event.dots = (val as any).dots;
				}
			}
		}

		// Apply corrected event fields (tick, division, dots, timeWarp)
		if (fix.events?.length) {
			const eventMap = new Map(measure.events.map(e => [e.id, e]));
			for (const patch of fix.events) {
				const event = eventMap.get(patch.id);
				if (!event)
					continue;
				if (patch.tick !== undefined) event.tick = patch.tick;
				if (patch.division !== undefined) event.division = patch.division;
				if (patch.dots !== undefined) event.dots = patch.dots;
				if (patch.timeWarp !== undefined) event.timeWarp = patch.timeWarp;
			}
		}

		// Set voices
		if (fix.voices) {
			measure.voices = fix.voices;
		}

		// Set duration
		if (fix.duration !== undefined) {
			measure.duration = fix.duration;
		}

		// Post-regulate to update computed fields
		try {
			measure.postRegulate();
		}
		catch {}

		const evalAfter = starry.evaluateMeasure(measure);
		const twistAfter = evalAfter?.tickTwist ?? Infinity;
		const statusLabel = fix.status === 0 ? "Solved" : fix.status === -1 ? "Discard" : "Issue";

		// Rollback if tickTwist got worse
		if (twistAfter > twistBefore) {
			const saved = JSON.parse(snapshot);
			measure.events = saved.events;
			measure.voices = saved.voices;
			measure.duration = saved.duration;
			try { measure.postRegulate(); } catch {}
			console.log(`  m${mi}: REVERTED (tickTwist ${twistBefore.toFixed(3)} → ${twistAfter.toFixed(3)}, worse)`);
			continue;
		}

		applied++;
		console.log(`  m${mi}: ${statusLabel}, fine=${evalAfter?.fine}, error=${evalAfter?.error}, tickTwist=${twistBefore.toFixed(3)}→${twistAfter.toFixed(3)}`);
	}

	return applied;
};


const BATCH_SIZE = Number(process.env.ANNOTATION_BATCH_SIZE) || 1;

const callAnnotationClaude = async (
	issueMeasures: IssueMeasureInfo[],
	spartito: starry.Spartito,
	roundNum: number,
	logDir?: string,
): Promise<any[]> => {
	if (!ANNOTATION_API_KEY) {
		console.warn("ANNOTATION_API_KEY not set, skipping annotation.");
		return [];
	}

	// Split into batches to stay within token limits
	const allFixes: any[] = [];
	const batches: IssueMeasureInfo[][] = [];
	for (let i = 0; i < issueMeasures.length; i += BATCH_SIZE)
		batches.push(issueMeasures.slice(i, i + BATCH_SIZE));

	for (let bi = 0; bi < batches.length; bi++) {
		const batch = batches[bi];
		console.log(`\n  Batch ${bi + 1}/${batches.length} (${batch.length} measures, round ${roundNum})...`);
		console.log("  ────────────────────────────────────────");

		// Prepare temp dir for downloaded images
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spartito-annotate-"));

		try {
			// Build text prompt with image file paths
			const prompt = await buildAnnotationPrompt(batch, tmpDir);

			// Save prompt to log
			if (logDir) {
				const promptFile = path.join(logDir, `r${roundNum}_b${bi + 1}_prompt.txt`);
				fs.writeFileSync(promptFile, prompt);
			}

			if (argv.logger)
				console.log(`  Prompt length: ${prompt.length} chars`);

			// Write current spartito to temp file for MCP server
			const spartitoTmpPath = path.join(tmpDir, "spartito.json");
			fs.writeFileSync(spartitoTmpPath, JSON.stringify(spartito));

			// Write MCP config pointing to measureQualityMcp.ts
			const mcpConfig = {
				mcpServers: {
					"measure-quality": {
						command: "npx",
						args: ["tsx", path.resolve(__dirname, "measureQualityMcp.ts")],
						env: { SPARTITO_PATH: spartitoTmpPath },
					},
				},
			};
			const mcpConfigPath = path.join(tmpDir, "mcp.json");
			fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

			const env: Record<string, string> = {
				...process.env as Record<string, string>,
				ANTHROPIC_BASE_URL: ANNOTATION_BASE_URL,
				ANTHROPIC_AUTH_TOKEN: ANNOTATION_API_KEY!,
				ANTHROPIC_MODEL: ANNOTATION_MODEL as string,
				ANTHROPIC_SMALL_FAST_MODEL: ANNOTATION_MODEL as string,
			};

			const args = [
				"-p",
				"--output-format", "json",
				"--append-system-prompt", SYSTEM_PROMPT,
				"--allowedTools", "Read,mcp__measure-quality__evaluate_fix",
				"--mcp-config", mcpConfigPath,
				"--effort", "max",
				"--verbose",
			];

			const result = spawnSync("claude", args, {
				input: prompt,
				env,
				encoding: "utf-8",
				maxBuffer: 50 * 1024 * 1024,
				timeout: 15 * 60 * 1000,
			});

			const rawOutput = result.stdout || "";
			const stderr = result.stderr || "";

			// Save full JSON output to log file
			if (logDir) {
				const logFile = path.join(logDir, `r${roundNum}_b${bi + 1}.json`);
				fs.writeFileSync(logFile, rawOutput);
				if (stderr) {
					const stderrFile = path.join(logDir, `r${roundNum}_b${bi + 1}.stderr.txt`);
					fs.writeFileSync(stderrFile, stderr);
				}
				console.log(`  Log saved: ${logFile}`);
			}

			console.log("  ────────────────────────────────────────");

			if (result.error) {
				console.warn(`  spawn error: ${result.error.message}`);
				continue;
			}

			// Parse JSON output format (stream-json: array of events; json: single object)
			let textOutput = "";
			try {
				const jsonResult = JSON.parse(rawOutput);

				if (Array.isArray(jsonResult)) {
					// stream-json format: array of event objects
					const lastItem = jsonResult[jsonResult.length - 1];
					textOutput = lastItem?.result || "";

					// Log usage stats from last item
					if (lastItem?.usage) {
						const u = lastItem.usage;
						console.log(`  Tokens: ${u.input_tokens || 0} in / ${u.output_tokens || 0} out`);
					}
					if (lastItem?.total_cost_usd !== undefined) {
						console.log(`  Cost: $${lastItem.total_cost_usd.toFixed(4)}`);
					}

					// Log tool calls and thinking from message events
					if (argv.logger) {
						for (const item of jsonResult) {
							const msg = item.message;
							if (msg?.role === "assistant" && Array.isArray(msg.content)) {
								for (const block of msg.content) {
									if (block.type === "tool_use")
										console.log(`  [tool_use] ${block.name}: ${JSON.stringify(block.input).slice(0, 200)}`);
									if (block.type === "thinking")
										console.log(`  [thinking] ${(block.thinking || "").slice(0, 300)}`);
								}
							}
						}
					}
				}
				else {
					// Single object format
					textOutput = jsonResult.result || "";
					if (jsonResult.usage) {
						const u = jsonResult.usage;
						console.log(`  Tokens: ${u.input_tokens || 0} in / ${u.output_tokens || 0} out`);
					}
					if (jsonResult.cost_usd !== undefined) {
						console.log(`  Cost: $${jsonResult.cost_usd.toFixed(4)}`);
					}
				}
			}
			catch {
				// Fallback: treat as plain text
				textOutput = rawOutput;
			}

			if (result.status !== 0) {
				console.warn(`  claude -p exited with code ${result.status}`);
				if (stderr)
					console.warn(`  stderr: ${stderr.slice(0, 1000)}`);
				if (textOutput) {
					const fixes = parseFixes(textOutput);
					allFixes.push(...fixes);
				}
				continue;
			}

			console.log(`  Result text: ${textOutput.length} chars`);

			if (argv.logger)
				console.log("  Raw result:\n", textOutput);

			allFixes.push(...parseFixes(textOutput));
		}
		catch (err: any) {
			console.warn("  claude -p failed:", err.message?.slice(0, 200));
		}
		finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}

	return allFixes;
};


// ── Main ────────────────────────────────────────────────────────────────────

const main = async () => {
	const inputPath = path.resolve(argv.input!);
	const outputPath = argv.output ? path.resolve(argv.output) : null;
	const scoreId = path.basename(inputPath).replace(/\.spartito\.json$/i, "").replace(/\.json$/i, "");

	if (!fs.existsSync(inputPath)) {
		console.error("Input file not found:", inputPath);
		process.exit(1);
	}

	// Read and deserialize spartito
	const content = fs.readFileSync(inputPath).toString();
	const spartito = starry.recoverJSON<starry.Spartito>(content, starry);

	console.log("Input:", inputPath);
	console.log("Measures:", spartito.measures.length);

	// Check if already regulated
	const alreadyRegulated = spartito.measures.some(m => m.regulated);

	// Collect issue measures
	const issueMeasures: IssueMeasureInfo[] = [];

	if (!alreadyRegulated || argv.forceRegulate) {
		if (alreadyRegulated)
			console.log("Force re-regulation requested.");

		// Load bead picker models
		const loadings = [] as Promise<void>[];
		const pickers = PICKER_SEQS.map(n_seq => new OnnxBeadPicker(BEAD_PICKER_URL.replace(/seq\d+/, `seq${n_seq}`), {
			n_seq,
			usePivotX: true,
			onLoad: promise => loadings.push(promise.catch(err => console.warn("error to load BeadPicker:", err))),
			sessionOptions: ORT_SESSION_OPTIONS,
		}));

		await Promise.all(loadings);

		// Create dummy score wrapper
		const dummyScore = {
			assemble () {},
			makeSpartito () { return spartito },
			assignBackgroundForMeasure (_: starry.SpartitoMeasure) {},
		} as starry.Score;

		// Run regulation
		const stat = await regulateWithBeadSolver(dummyScore, {
			logger: argv.logger ? console : undefined,
			pickers,
			solutionStore: remoteSolutionStore,
			onSaveIssueMeasure: (data) => {
				issueMeasures.push({
					measureIndex: data.measureIndex,
					status: data.status,
					measure: data.measure,
				});
			},
		});

		// Print regulation stats
		console.log("\n--- Regulation Stats ---");
		console.log("measures:", `(${stat.measures.cached})${stat.measures.simple}->${stat.measures.solved}->${stat.measures.issue}->${stat.measures.fatal}/${spartito.measures.length}`);
		console.log("qualityScore:", spartito.qualityScore);
		console.log("totalCost:", stat.totalCost, "ms");
		console.log("pickerCost:", stat.pickerCost, "ms");
	}
	else {
		console.log("Spartito already regulated, skipping regulation (use --force-regulate to override).");

		// Collect issue measures from existing regulation
		for (const m of spartito.measures) {
			if (!m.regulated || m.events.length === 0)
				continue;
			const ev = starry.evaluateMeasure(m);
			if (ev && !ev.fine) {
				issueMeasures.push({
					measureIndex: m.measureIndex,
					status: ev.error ? 2 : 1,
					measure: m,
				});
			}
		}

		console.log(`\n--- Existing Regulation ---`);
		const solved = spartito.measures.filter(m => m.regulated && m.events.length > 0 && starry.evaluateMeasure(m)?.fine).length;
		console.log(`Solved: ${solved}, Issue: ${issueMeasures.filter(m => m.status === 1).length}, Fatal: ${issueMeasures.filter(m => m.status === 2).length}`);
	}

	// ── Pre-annotation: fetch existing server annotations ────────────────────
	if (API_BASE && argv.fetchServer) {
		const hashes = spartito.measures
			.filter(m => m.regulated && m.regulationHash0)
			.map(m => m.regulationHash0!);

		if (hashes.length > 0) {
			try {
				const fetched: any[] = await apiFetch("/issueMeasures/batchGet", {
					method: "POST",
					body: JSON.stringify({ hashes }),
				});

				let serverResolved = 0;
				if (fetched?.length) {
					for (const remote of fetched) {
						if (!remote.hash || !remote.measure) continue;

						// Find the local measure by hash
						const localIdx = spartito.measures.findIndex(m => m.regulationHash0 === remote.hash);
						if (localIdx < 0) continue;

						if (remote.status === 0) {
							// Server says solved — replace local measure with server's corrected version
							const serverMeasure = starry.recoverJSON(remote.measure, starry);
							spartito.measures[localIdx] = new starry.SpartitoMeasure(serverMeasure);
							serverResolved++;

							// Remove from issue list if present
							const issueIdx = issueMeasures.findIndex(im => im.measureIndex === spartito.measures[localIdx].measureIndex);
							if (issueIdx >= 0) issueMeasures.splice(issueIdx, 1);
						}
					}
					console.log(`\nServer: ${fetched.length} records fetched, ${serverResolved} solved measures applied`);
					if (serverResolved > 0)
						console.log(`Remaining issues: ${issueMeasures.length}`);
				}
			} catch (err: any) {
				console.warn("Failed to fetch server annotations:", err.message);
			}
		}
	}

	// ── Annotation phase ────────────────────────────────────────────────────

	if (!argv.skipAnnotation && issueMeasures.length > 0) {
		console.log(`\n--- Annotation Phase ---`);
		console.log(`${issueMeasures.length} issue measures to annotate`);
		console.log(`Model: ${ANNOTATION_MODEL}`);

		// Create log directory for this run
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const inputBasename = path.basename(inputPath, ".spartito.json");
		const runLogDir = path.join(__dirname, "..", "logs", `${timestamp}_${inputBasename}`);
		fs.mkdirSync(runLogDir, { recursive: true });
		console.log(`Log dir: ${runLogDir}`);

		const maxRounds = argv.maxRounds!;

		for (let round = 1; round <= maxRounds; round++) {
			// Re-evaluate which measures still need annotation
			const currentIssues = round === 1
				? issueMeasures
				: spartito.measures
					.filter(m => {
						if (!m.regulated || m.events.length === 0)
							return false;
						const ev = starry.evaluateMeasure(m);
						return ev && !ev.fine;
					})
					.map(m => ({ measureIndex: m.measureIndex, status: 1, measure: m }));

			if (currentIssues.length === 0) {
				console.log("All issue measures resolved!");
				break;
			}

			console.log(`\nRound ${round}/${maxRounds}: ${currentIssues.length} measures to annotate`);

			// Call claude -p for annotation
			const fixes = await callAnnotationClaude(currentIssues, spartito, round, runLogDir);

			if (fixes.length === 0) {
				console.log("No fixes returned, stopping annotation.");
				break;
			}

			// Apply fixes
			console.log(`\nApplying ${fixes.length} fixes:`);
			const applied = applyFixes(spartito, fixes);
			console.log(`Applied ${applied} fixes.`);
		}

		// Final evaluation
		let solved = 0, issue = 0, fatal = 0;
		for (const m of spartito.measures) {
			if (m.events.length === 0)
				continue;
			const ev = starry.evaluateMeasure(m);
			if (!ev)
				continue;
			if (ev.error) fatal++;
			else if (!ev.fine) issue++;
			else solved++;
		}
		console.log(`\n--- Post-Annotation Stats ---`);
		console.log(`Solved: ${solved}, Issue: ${issue}, Fatal: ${fatal}`);
	}
	else if (issueMeasures.length === 0) {
		console.log("\nNo issue measures found, skipping annotation.");
	}
	else {
		console.log(`\nSkipping annotation (${issueMeasures.length} issue measures).`);
	}

	// ── Post-annotation: save all regulated measures to API ──────────────────
	if (API_BASE) {
		console.log(`\n--- Saving to API (scoreId=${scoreId}) ---`);
		let saved = 0, errors = 0;
		for (const m of spartito.measures) {
			if (!m.regulated || !m.events?.length) continue;
			const ev = starry.evaluateMeasure(m);
			const status = !ev ? 1 : ev.error ? 2 : ev.fine ? 0 : 1;
			try {
				await apiFetch(`/scores/${scoreId}/issueMeasures`, {
					method: "PUT",
					body: JSON.stringify({
						measureIndex: m.measureIndex,
						measure: m.toJSON(),
						status,
						annotator: ANNOTATION_MODEL,
					}),
				});
				saved++;
			} catch (err: any) {
				console.warn(`  Failed to save measure ${m.measureIndex}: ${err.message}`);
				errors++;
			}
		}
		console.log(`Saved: ${saved} measures${errors > 0 ? ` (${errors} errors)` : ""}`);
	}

	// Write output (optional)
	if (outputPath) {
		fs.writeFileSync(outputPath, JSON.stringify(spartito));
		console.log("\nOutput:", outputPath);
	}
};


main();
