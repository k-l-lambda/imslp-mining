
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import fetch from "isomorphic-fetch";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../env";

import { BEAD_PICKER_URL, IMAGE_BED, ORT_SESSION_OPTIONS } from "./libs/constants";
import { starry, regulateWithBeadSolver } from "./libs/omr";
import OnnxBeadPicker from "./libs/onnxBeadPicker";
import remoteSolutionStore from "./libs/remoteSolutionStore";



const argv = yargs(hideBin(process.argv))
	.command(
		"$0 <input> [options]",
		"Regulate and annotate a single spartito file.",
		yargs => yargs
			.positional("input", { type: "string", demandOption: true, describe: "Path to .spartito.json file" })
			.option("output", { alias: "o", type: "string", describe: "Output path (default: overwrite input)" })
			.option("logger", { alias: "l", type: "boolean", describe: "Enable verbose logging" })
			.option("skip-annotation", { type: "boolean", describe: "Skip the annotation step" })
			.option("annotation-model", { type: "string", describe: "Model for annotation (overrides ANNOTATION_MODEL env)" })
			.option("max-rounds", { type: "number", default: 3, describe: "Max annotation rounds" })
		,
	).help().argv;


const PICKER_SEQS = [32, 64, 128, 512];

// Annotation config (Anthropic-compatible, used via claude -p)
const ANNOTATION_BASE_URL = process.env.ANNOTATION_BASE_URL || "https://api.ppinfra.com/anthropic/";
const ANNOTATION_API_KEY = process.env.ANNOTATION_API_KEY;
const ANNOTATION_MODEL = argv.annotationModel || process.env.ANNOTATION_MODEL || "moonshotai/kimi-k2.5";
const ANNOTATION_MAX_TOKENS = Number(process.env.ANNOTATION_MAX_TOKENS) || 200000;

// Image API for fetching staff images when local IMAGE_BED is unavailable
const IMAGE_API_BASE = process.env.IMAGE_API_BASE;


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
- **tickTwist**: Time-position non-linearity. <0.2=good, >=1.0=error (fatal)
- **fine**: Acceptable quality (no fatal errors, tickTwist<0.3, no beam broken, no surplus time)
- **error**: Fatal problems (tickTwist>=1.0, tick overlap, voice rugged, etc.)
- **spaceTime**: Unused time in voices (gaps). Allowed for fine, but must be 0 for perfect.
- **surplusTime**: Time exceeding measure duration. Must be 0.
- **beamBroken**: Beam Open/Continue/Close sequence split across voices.

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

### 1. View Staff Images
Examine the provided staff background images carefully. Compare what you see with event data to detect:
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
- When computing ticks, write them out explicitly: tick_n = tick_(n-1) + duration_(n-1)`;


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
	lines.push(`${sorted.length} measures need annotation. For each measure, I provide the event data JSON and staff background image file paths.`);
	lines.push(`View each staff image file with the Read tool to see the actual sheet music before analyzing.\n`);

	let imageCount = 0;

	for (const issue of sorted) {
		const measure = issue.measure;
		const mi = issue.measureIndex;
		const measureData = serializeMeasureForAnnotation(measure);

		lines.push(`--- Measure ${mi} (status=${issue.status}, error=${measureData.evaluation?.error}, fine=${measureData.evaluation?.fine}, tickTwist=${measureData.evaluation?.tickTwist?.toFixed(3)}) ---`);
		lines.push("```json");
		lines.push(JSON.stringify(measureData, null, 2));
		lines.push("```");

		// Resolve staff images to local file paths
		if (measure.backgroundImages?.length) {
			for (let si = 0; si < measure.backgroundImages.length; si++) {
				const bgImg = measure.backgroundImages[si];
				const source = resolveImageSource(bgImg.url);
				if (source) {
					const ext = bgImg.url.match(/\.(\w+)$/)?.[1] || "webp";
					const destPath = path.join(tmpDir, `m${mi}_s${si}.${ext}`);
					const imgPath = await downloadImageToFile(source, destPath);
					if (imgPath) {
						lines.push(`Staff ${si} image: ${imgPath}`);
						imageCount++;
					}
				}
			}
		}

		lines.push("");
	}

	lines.push("Read each staff image file listed above to view the actual sheet music. Analyze each measure (check images against event data, look for false graces, wrong divisions, missing dots, voice separation issues). Output ONLY the JSON fixes block.");

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

		applied++;

		const evaluation = starry.evaluateMeasure(measure);
		const statusLabel = fix.status === 0 ? "Solved" : fix.status === -1 ? "Discard" : "Issue";
		console.log(`  m${mi}: ${statusLabel}, fine=${evaluation?.fine}, error=${evaluation?.error}, tickTwist=${evaluation?.tickTwist?.toFixed(3)}`);
	}

	return applied;
};


const BATCH_SIZE = Number(process.env.ANNOTATION_BATCH_SIZE) || 2;

const callAnnotationClaude = async (
	issueMeasures: IssueMeasureInfo[],
	roundNum: number,
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

			if (argv.logger)
				console.log(`  Prompt length: ${prompt.length} chars`);

			const env: Record<string, string> = {
				...process.env as Record<string, string>,
				ANTHROPIC_BASE_URL: ANNOTATION_BASE_URL,
				ANTHROPIC_AUTH_TOKEN: ANNOTATION_API_KEY!,
				ANTHROPIC_MODEL: ANNOTATION_MODEL,
				ANTHROPIC_SMALL_FAST_MODEL: ANNOTATION_MODEL,
			};

			const args = [
				"-p",
				"--append-system-prompt", SYSTEM_PROMPT,
				"--allowedTools", "Read",
				"--dangerously-skip-permissions",
				"--effort", "max",
			];

			const result = spawnSync("claude", args, {
				input: prompt,
				env,
				encoding: "utf-8",
				maxBuffer: 50 * 1024 * 1024,
				timeout: 15 * 60 * 1000,
			});

			const output = result.stdout || "";
			const stderr = result.stderr || "";

			console.log("  ────────────────────────────────────────");

			if (result.error) {
				console.warn(`  spawn error: ${result.error.message}`);
				continue;
			}

			if (result.status !== 0) {
				console.warn(`  claude -p exited with code ${result.status}`);
				if (stderr)
					console.warn(`  stderr: ${stderr.slice(0, 1000)}`);
				if (output)
					console.warn(`  stdout: ${output.slice(0, 1000)}`);
				// Still try to parse output - claude may have produced partial results
				if (output) {
					const fixes = parseFixes(output);
					allFixes.push(...fixes);
				}
				continue;
			}

			console.log(`  Output: ${output.length} chars`);

			if (argv.logger)
				console.log("  Raw output:\n", output);

			allFixes.push(...parseFixes(output));
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
	const outputPath = argv.output ? path.resolve(argv.output) : inputPath;

	if (!fs.existsSync(inputPath)) {
		console.error("Input file not found:", inputPath);
		process.exit(1);
	}

	// Load bead picker models
	const loadings = [] as Promise<void>[];
	const pickers = PICKER_SEQS.map(n_seq => new OnnxBeadPicker(BEAD_PICKER_URL.replace(/seq\d+/, `seq${n_seq}`), {
		n_seq,
		usePivotX: true,
		onLoad: promise => loadings.push(promise.catch(err => console.warn("error to load BeadPicker:", err))),
		sessionOptions: ORT_SESSION_OPTIONS,
	}));

	await Promise.all(loadings);

	// Read and deserialize spartito
	const content = fs.readFileSync(inputPath).toString();
	const spartito = starry.recoverJSON<starry.Spartito>(content, starry);

	console.log("Input:", inputPath);
	console.log("Measures:", spartito.measures.length);

	// Collect issue measures during regulation
	const issueMeasures: IssueMeasureInfo[] = [];

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

	// ── Annotation phase ────────────────────────────────────────────────────

	if (!argv.skipAnnotation && issueMeasures.length > 0) {
		console.log(`\n--- Annotation Phase ---`);
		console.log(`${issueMeasures.length} issue measures to annotate`);
		console.log(`Model: ${ANNOTATION_MODEL}`);

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
			const fixes = await callAnnotationClaude(currentIssues, round);

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

	// Write output
	fs.writeFileSync(outputPath, JSON.stringify(spartito));
	console.log("\nOutput:", outputPath);
};


main();
