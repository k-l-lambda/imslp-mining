import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import fetch from 'isomorphic-fetch';
import sharp from 'sharp';
import { MIDI } from '@k-l-lambda/music-widgets';
import YAML from 'yaml';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

import '../../env';
import { ANNOTATION_API_KEY, ANNOTATION_BASE_URL, ANNOTATION_MODEL as DEFAULT_ANNOTATION_MODEL, IMAGE_BED } from '../libs/constants';
import { starry } from '../libs/omr';
import { extractSpartitoEvents, midiToOnset, type NoteOnPoint, type SpartitoEventPoint } from './common';


type BoundaryMethod = 'matched-notehead' | 'estimated-beat-spacing' | 'mixed' | 'uncertain';

type PromptOnset = {
	index: number;
	pitch: number;
	tick: number;
	tau: number;
};

type PromptSpartitoPoint = {
	eventId?: number | string;
	staff?: number;
	pivotX?: number;
	y?: number;
	pitch: number;
	pitchSource?: unknown;
	tick: number;
};

type BoundaryAnnotation = {
	measureIndex: number;
	endTick: number;
	confidence: number;
	method: BoundaryMethod;
	reason: string;
	remainingOnsetStartIndexBefore: number;
	remainingOnsetStartIndexAfter: number;
	promptLog?: string;
	rawResponseLog?: string;
	stderrLog?: string;
	contextLog?: string;
	trajectoryLog?: string;
	resultLog?: string;
	sessionId?: string;
	usage?: unknown;
	totalCostUsd?: number;
	createdAt: string;
};

type SegmentationOutput = {
	version: 1;
	kind: 'formal-midi-segmentation';
	scoreDir: string;
	spartitoPath: string;
	midiPath: string;
	model: string;
	createdAt: string;
	updatedAt: string;
	spartitoMeasureCount: number;
	onsetCount: number;
	boundaries: BoundaryAnnotation[];
};

type SegmentationYamlEntry = {
	measureIndex: number;
	tick: number;
	duration: number;
	confidence: number;
};

type ParsedArgs = {
	scoreDir?: string;
	spartito?: string;
	midi?: string;
	output?: string;
	annotationModel?: string;
	fromMeasure?: number;
	toMeasure?: number;
	maxRounds?: number;
	remainingWindow: number;
	maxRemainingWindow: number;
	logDir?: string;
	force: boolean;
	dryRun: boolean;
};

type PageTurnContext = {
	pageIndex: number;
	startMeasureIndex: number;
	seconds: number;
	tick: number;
	measuresUntilPageTurn: number;
};

type RoundContext = {
	measureIndex: number;
	nextMeasureIndex: number;
	previousBoundaryTick: number | null;
	remainingOnsetStartIndex: number;
	remainingWindow: number;
	currentMeasureSpartitoPoints: PromptSpartitoPoint[];
	nextMeasureSpartitoPoints: PromptSpartitoPoint[];
	remainingOnsets: PromptOnset[];
	currentMeasureImage: string | null;
	nextMeasureImage: string | null;
	currentScoreTickRange: { start: number | null; end: number | null };
	nextScoreTickRange: { start: number | null; end: number | null };
	nextPageTurn: PageTurnContext | null;
};

type ClaudeRun = {
	stdout: string;
	stderr: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	args: string[];
};

type ClaudeJsonResult = {
	textOutput: string;
	sessionId?: string;
	usage?: unknown;
	totalCostUsd?: number;
};


const METHODS = new Set<BoundaryMethod>(['matched-notehead', 'estimated-beat-spacing', 'mixed', 'uncertain']);
const IMAGE_API_BASE = process.env.IMAGE_API_BASE;
const MEASURE_IMAGE_PADDING = 2;

const resolveImageSource = (url: string): { type: 'local'; path: string } | { type: 'remote'; url: string } | null => {
	if (!url)
		return null;
	const match = url.match(/^(\w+):(.*)/);
	if (match?.[1] === 'md5') {
		const filename = match[2];
		if (filename.includes('/') || filename.includes('\\') || filename.includes('..'))
			return null;
		if (IMAGE_BED) {
			const localPath = path.join(IMAGE_BED, filename);
			if (fs.existsSync(localPath))
				return { type: 'local', path: localPath };
		}
		if (IMAGE_API_BASE)
			return { type: 'remote', url: `${IMAGE_API_BASE}/${filename}` };
		return null;
	}
	if (fs.existsSync(url))
		return { type: 'local', path: url };
	return null;
};

const fetchImageBuffer = async (source: { type: 'local'; path: string } | { type: 'remote'; url: string }): Promise<Buffer | null> => {
	if (source.type === 'local')
		return fs.readFileSync(source.path);
	const resp = await fetch(source.url);
	if (!resp.ok)
		return null;
	return Buffer.from(await resp.arrayBuffer());
};

const compositeMeasureImage = async (measure: any, destPath: string): Promise<string | null> => {
	if (!measure.backgroundImages?.length || !measure.position)
		return null;

	const pos = measure.position;
	const cropLeftUnit = pos.left - MEASURE_IMAGE_PADDING;
	const cropRightUnit = pos.right + MEASURE_IMAGE_PADDING;
	const crops: { buffer: Buffer; width: number; height: number; yUnit: number; ppuY: number }[] = [];

	for (const bgImg of measure.backgroundImages) {
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
		const leftPx = Math.max(0, Math.round((cropLeftUnit - bgImg.position.x) * imgPpu));
		const rightPx = Math.min(meta.width, Math.round((cropRightUnit - bgImg.position.x) * imgPpu));
		const width = rightPx - leftPx;
		if (width <= 0)
			continue;
		const cropped = await sharp(buf).extract({ left: leftPx, top: 0, width, height: meta.height }).toBuffer();
		const ppuY = meta.height / bgImg.position.height;
		crops.push({ buffer: cropped, width, height: meta.height, yUnit: bgImg.position.y, ppuY });
	}

	if (!crops.length)
		return null;

	const minY = Math.min(...crops.map(c => c.yUnit));
	const ppuY = crops[0].ppuY;
	const totalWidth = Math.max(...crops.map(c => c.width));
	const totalHeight = Math.round(Math.max(...crops.map(c => (c.yUnit - minY) * ppuY + c.height)));
	await sharp({ create: { width: totalWidth, height: totalHeight, channels: 3, background: { r: 255, g: 255, b: 255 } } })
		.composite(crops.map(c => ({ input: c.buffer, left: 0, top: Math.round((c.yUnit - minY) * ppuY) })))
		.webp({ quality: 90 })
		.toFile(destPath);
	return destPath;
};

const MIDI_SEGMENTATION_SYSTEM_PROMPT = `You are a careful music-data annotation agent for formal MIDI measure segmentation.

Your job is to determine exactly one boundary per request: the end tick of the current measure and the start tick of the next measure in the target MIDI.

Use the current/next measure background images, score-side spartito points, and remaining MIDI onsets provided by the user. The data is noisy:
- Spartito pitches and approximate ticks come from model prediction and may be wrong.
- The MIDI can contain extra notes, missing notes, arpeggios, ornaments, tremolos, rolled chords, free sustain, expressive timing, and other exceptions.
- Do not require exact one-to-one correspondence between score noteheads and MIDI onsets.
- Match flexibly by pitch, contour, chord shape, relative order, visual notehead grouping, and local timing patterns.

Tau semantics:
- tau is a softened MIDI chord index.
- Performance timing is imprecise, so tau uses tanh to saturate large time gaps while preserving small time gaps.
- This keeps near-simultaneous notes grouped into chords and prevents long rests or expressive pauses from dominating the index scale.

If the next measure starts with visible/matched noteheads, prefer their matched MIDI tick as the boundary. If the measure boundary has no notehead event, estimate the boundary tick from nearby matched notes and local beat spacing.

The user may provide nextPageTurn context. This is the next score page start converted from the video page-change time into MIDI ticks using the MIDI tempo map, plus how many measure boundaries remain before that page turn. Treat it as useful global timing guidance, but still prioritize local notehead/onset evidence when they conflict.

Available tool:
- get_onsets(offset, count): query target MIDI onset elements by absolute onset index. Use it if the default onset context is insufficient.

Return only a single JSON object with exactly these five fields:
- measureIndex
- endTick
- confidence
- method: matched-notehead | estimated-beat-spacing | mixed | uncertain
- reason

Do not include markdown. Do not annotate more than one boundary.`;


const parseArgs = (): ParsedArgs => {
	const argv = yargs(hideBin(process.argv))
		.command(
			'$0 [scoreDir]',
			'Annotate target MIDI measure boundaries using Claude.',
			yargs => yargs
				.positional('scoreDir', { type: 'string', describe: 'Score directory containing spartito.json and transkun.mid' })
				.option('spartito', { type: 'string', describe: 'Path to spartito.json' })
				.option('midi', { type: 'string', describe: 'Path to target MIDI, default <scoreDir>/transkun.mid' })
				.option('output', { alias: 'o', type: 'string', describe: 'Output segmentation JSON path' })
				.option('annotation-model', { type: 'string', describe: 'Model for annotation, overrides ANNOTATION_MODEL' })
				.option('from-measure', { type: 'number', describe: 'First current measure index to annotate' })
				.option('to-measure', { type: 'number', describe: 'Last current measure index to annotate' })
				.option('max-rounds', { type: 'number', describe: 'Maximum boundaries to annotate in this run' })
				.option('remaining-window', { type: 'number', default: 160, describe: 'Initial remaining onset window size' })
				.option('max-remaining-window', { type: 'number', default: 1000, describe: 'Maximum onset window when retrying' })
				.option('log-dir', { type: 'string', describe: 'Directory for prompts, raw outputs, images, and trajectories' })
				.option('force', { type: 'boolean', default: false, describe: 'Re-annotate existing boundaries in the selected range' })
				.option('dry-run', { type: 'boolean', default: false, describe: 'Build first prompt/context without calling Claude' }),
		).help().argv as any;

	return argv as ParsedArgs;
};


const padMeasure = (measureIndex: number) => `m${String(measureIndex).padStart(3, '0')}`;

const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

const ensureDir = (dir: string) => {
	fs.mkdirSync(dir, { recursive: true });
};

const writeJson = (filePath: string, data: unknown) => {
	fs.writeFileSync(filePath, `${JSON.stringify(data, null, '\t')}\n`);
};

const saveOutputAtomic = (outputPath: string, output: SegmentationOutput) => {
	const tmpPath = `${outputPath}.tmp-${process.pid}`;
	writeJson(tmpPath, output);
	fs.renameSync(tmpPath, outputPath);
};

const segmentationYamlPath = (scoreDir: string, midiPath: string) => path.join(scoreDir, `${path.basename(midiPath, path.extname(midiPath))}-segmentation.yaml`);

const buildSegmentationYaml = (output: SegmentationOutput, onsets: NoteOnPoint[]): SegmentationYamlEntry[] => {
	const firstTick = onsets[0]?.[1] ?? 0;
	const boundaries = [...output.boundaries].sort((a, b) => a.measureIndex - b.measureIndex);
	return boundaries.map((boundary, index) => {
		const tick = index === 0 ? firstTick : boundaries[index - 1].endTick;
		return {
			measureIndex: boundary.measureIndex,
			tick,
			duration: boundary.endTick - tick,
			confidence: boundary.confidence,
		};
	});
};

const saveSegmentationYaml = (filePath: string, output: SegmentationOutput, onsets: NoteOnPoint[]) => {
	const entries = buildSegmentationYaml(output, onsets);
	fs.writeFileSync(filePath, YAML.stringify(entries, { indent: 2, lineWidth: 0 }));
};


const parseClaudeCliJson = (rawOutput: string): ClaudeJsonResult => {
	try {
		const jsonResult = JSON.parse(rawOutput);
		const item = Array.isArray(jsonResult) ? jsonResult[jsonResult.length - 1] : jsonResult;
		return {
			textOutput: item?.result || '',
			sessionId: item?.session_id,
			usage: item?.usage,
			totalCostUsd: item?.total_cost_usd,
		};
	}
	catch {
		return { textOutput: rawOutput };
	}
};


const recoverTruncatedJsonObject = (output: string): any | null => {
	const source = output.slice(Math.max(0, output.indexOf('{')));
	const numberField = (field: string) => {
		const match = source.match(new RegExp(`"${field}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
		return match ? Number(match[1]) : undefined;
	};
	const stringField = (field: string) => {
		const match = source.match(new RegExp(`"${field}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)`));
		if (!match)
			return undefined;
		try {
			return JSON.parse(`"${match[1]}"`);
		}
		catch {
			return match[1];
		}
	};

	const measureIndex = numberField('measureIndex');
	const endTick = numberField('endTick');
	const confidence = numberField('confidence') ?? stringField('confidence');
	const method = stringField('method');
	if (measureIndex === undefined || endTick === undefined || confidence === undefined || !method)
		return null;

	return {
		measureIndex,
		endTick,
		confidence,
		method,
		reason: stringField('reason') ?? 'Recovered from truncated Claude JSON output; see raw response log.',
	};
};


const extractJsonObject = (output: string): any => {
	const trimmed = output.trim();
	try {
		return JSON.parse(trimmed);
	}
	catch {}

	const fence = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fence) {
		try {
			return JSON.parse(fence[1]);
		}
		catch {}
	}

	const start = output.indexOf('{');
	const end = output.lastIndexOf('}');
	if (start >= 0 && end > start) {
		try {
			return JSON.parse(output.slice(start, end + 1));
		}
		catch {}
	}

	const recovered = recoverTruncatedJsonObject(output);
	if (recovered)
		return recovered;

	throw new Error('Claude result did not contain a JSON object');
};


const confidenceValue = (value: unknown): number => {
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (normalized === 'high')
			return 0.9;
		if (normalized === 'medium')
			return 0.6;
		if (normalized === 'low')
			return 0.3;
	}
	return Number(value);
};


const validateBoundary = (
	parsed: any,
	context: RoundContext,
	onsets: NoteOnPoint[],
	previousBoundaryTick: number | null,
): BoundaryAnnotation | { needsMoreOnsets: true; requestedRemainingWindow: number; reason?: string } => {
	if (parsed?.needsMoreOnsets) {
		const requestedRemainingWindow = Number(parsed.requestedRemainingWindow ?? context.remainingWindow * 2);
		return {
			needsMoreOnsets: true,
			requestedRemainingWindow: Number.isFinite(requestedRemainingWindow) ? requestedRemainingWindow : context.remainingWindow * 2,
			reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
		};
	}

	const method = parsed.method as BoundaryMethod;
	const endTick = Number(parsed.endTick);
	const confidence = confidenceValue(parsed.confidence);

	if (parsed.measureIndex !== context.measureIndex)
		throw new Error(`measureIndex mismatch: expected ${context.measureIndex}, got ${parsed.measureIndex}`);
	if (!Number.isFinite(endTick))
		throw new Error('endTick must be a finite number');
	if (previousBoundaryTick !== null && endTick < previousBoundaryTick)
		throw new Error(`boundary tick moved backwards: previous=${previousBoundaryTick}, end=${endTick}`);
	if (!METHODS.has(method))
		throw new Error(`invalid method: ${parsed.method}`);
	if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
		throw new Error('confidence must be within [0, 1]');
	if (typeof parsed.reason !== 'string' || !parsed.reason.trim())
		throw new Error('reason must be a non-empty string');

	const remainingOnsetStartIndexAfter = onsets.findIndex(([, tick], index) => index >= context.remainingOnsetStartIndex && tick >= endTick);
	const cursorAfter = remainingOnsetStartIndexAfter >= 0 ? remainingOnsetStartIndexAfter : onsets.length;

	return {
		measureIndex: context.measureIndex,
		endTick,
		confidence,
		method,
		reason: parsed.reason,
		remainingOnsetStartIndexBefore: context.remainingOnsetStartIndex,
		remainingOnsetStartIndexAfter: cursorAfter,
		createdAt: new Date().toISOString(),
	};
};


const spawnClaude = (args: string[], input: string, env: Record<string, string>, timeoutMs: number): Promise<ClaudeRun> => {
	return new Promise((resolve) => {
		const started = Date.now();
		const child = spawn('claude', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let timedOut = false;

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (d: string) => { stdout += d; });
		child.stderr.on('data', (d: string) => { stderr += d; });
		child.on('error', err => { stderr += `\nspawn error: ${err.message}`; });

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
			setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
		}, timeoutMs);

		child.on('close', (code, signal) => {
			clearTimeout(timer);
			const finished = Date.now();
			resolve({
				stdout,
				stderr,
				code,
				signal,
				timedOut,
				startedAt: new Date(started).toISOString(),
				finishedAt: new Date(finished).toISOString(),
				durationMs: finished - started,
				args,
			});
		});

		child.stdin.end(input);
	});
};


const getScoreTickRange = (points: SpartitoEventPoint[]) => {
	if (!points.length)
		return { start: null, end: null };
	return {
		start: Math.min(...points.map(p => p.tick)),
		end: Math.max(...points.map(p => p.tick)),
	};
};


const tau1 = (tau: number) => Number(tau.toFixed(1));

const pitchSourceName = (pitchSource: any): string | undefined => {
	if (!pitchSource || typeof pitchSource.note !== 'number' || typeof pitchSource.alter !== 'number')
		return undefined;
	const letters = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
	const note = pitchSource.note;
	const alter = pitchSource.alter;
	const group = Math.floor(note / 7);
	const name = letters[((note % 7) + 7) % 7];
	const octave = 4 + group + (pitchSource.octaveShift ?? 0);
	const accidental = alter > 0 ? '#'.repeat(alter) : alter < 0 ? 'b'.repeat(-alter) : '';
	return `${name}${octave}${accidental}`;
};

const simplifySpartitoPoints = (points: SpartitoEventPoint[]): PromptSpartitoPoint[] => points.map(point => ({
	eventId: point.id,
	staff: point.staff,
	pivotX: point.pivotX === undefined ? undefined : Number(point.pivotX.toFixed(2)),
	y: point.y,
	pitch: point.pitch,
	pitchSource: pitchSourceName(point.pitchSource),
	tick: Math.round(point.tick),
}));

const toPromptOnsets = (onsets: NoteOnPoint[], startIndex: number): PromptOnset[] => {
	const first = onsets[startIndex];
	if (!first)
		return [];
	const tau0 = first[2];
	const result: PromptOnset[] = [];
	for (let i = startIndex; i < onsets.length; ++i) {
		const [pitch, tick, tau] = onsets[i];
		if (tau - tau0 > 32)
			break;
		result.push({ index: i, pitch, tick, tau: tau1(tau) });
	}
	return result;
};


const collectTempoMap = (midi: any) => {
	const ticksPerBeat = Number(midi.header?.ticksPerBeat);
	if (!Number.isFinite(ticksPerBeat) || ticksPerBeat <= 0)
		throw new Error('MIDI ticksPerBeat is missing or invalid');
	const tempos: { tick: number; microsecondsPerBeat: number }[] = [];
	for (const track of midi.tracks ?? []) {
		let tick = 0;
		for (const event of track) {
			tick += Number(event.deltaTime ?? 0);
			if (event.type === 'meta' && event.subtype === 'setTempo' && Number.isFinite(Number(event.microsecondsPerBeat)))
				tempos.push({ tick, microsecondsPerBeat: Number(event.microsecondsPerBeat) });
		}
	}
	tempos.sort((a, b) => a.tick - b.tick);
	if (!tempos.length)
		tempos.push({ tick: 0, microsecondsPerBeat: 500000 });
	if (tempos[0].tick !== 0)
		tempos.unshift({ tick: 0, microsecondsPerBeat: tempos[0].microsecondsPerBeat });
	return { ticksPerBeat, tempos };
};


const secondsToTick = (seconds: number, tempoMap: ReturnType<typeof collectTempoMap>) => {
	let elapsedSeconds = 0;
	let previousTick = tempoMap.tempos[0].tick;
	let microsecondsPerBeat = tempoMap.tempos[0].microsecondsPerBeat;
	for (let i = 1; i < tempoMap.tempos.length; ++i) {
		const next = tempoMap.tempos[i];
		const segmentSeconds = (next.tick - previousTick) * microsecondsPerBeat / tempoMap.ticksPerBeat / 1e6;
		if (seconds < elapsedSeconds + segmentSeconds)
			return Math.round(previousTick + (seconds - elapsedSeconds) * tempoMap.ticksPerBeat * 1e6 / microsecondsPerBeat);
		elapsedSeconds += segmentSeconds;
		previousTick = next.tick;
		microsecondsPerBeat = next.microsecondsPerBeat;
	}
	return Math.round(previousTick + (seconds - elapsedSeconds) * tempoMap.ticksPerBeat * 1e6 / microsecondsPerBeat);
};


const buildPageTurnContexts = (scoreDir: string, midi: any): PageTurnContext[] => {
	const metaPath = path.join(scoreDir, 'meta.yaml');
	const scorePath = path.join(scoreDir, 'score.json');
	if (!fs.existsSync(metaPath) || !fs.existsSync(scorePath))
		return [];
	const meta = YAML.parse(fs.readFileSync(metaPath).toString()) as any;
	const score = JSON.parse(fs.readFileSync(scorePath).toString());
	const changes = meta?.shot_detection?.changes ?? [];
	const tempoMap = collectTempoMap(midi);
	let measureIndex = 0;
	const result: PageTurnContext[] = [];
	(score.pages ?? []).forEach((page: any, pageIndex: number) => {
		const seconds = Number(changes[pageIndex]?.seconds);
		if (pageIndex > 0 && Number.isFinite(seconds)) {
			result.push({
				pageIndex,
				startMeasureIndex: measureIndex,
				seconds,
				tick: secondsToTick(seconds, tempoMap),
				measuresUntilPageTurn: 0,
			});
		}
		for (const system of page.systems ?? []) {
			const fallbackMeasureCount = system.staves?.[0]?.measures?.length ?? 0;
			measureIndex += Number(system.measureCount ?? fallbackMeasureCount ?? 0);
		}
	});
	return result;
};


const getNextPageTurn = (pageTurns: PageTurnContext[], measureIndex: number): PageTurnContext | null => {
	const next = pageTurns.find(pageTurn => pageTurn.startMeasureIndex > measureIndex);
	return next ? {
		...next,
		measuresUntilPageTurn: next.startMeasureIndex - measureIndex,
	} : null;
};


const yaml = (data: unknown) => YAML.stringify(data, { indent: 2, lineWidth: 0 }).trim();

const buildPrompt = (context: RoundContext) => `Boundary annotation input for measure ${context.measureIndex} -> ${context.nextMeasureIndex}.

Measure images:
- Current measure image: ${context.currentMeasureImage ?? 'null'}
- Next measure image: ${context.nextMeasureImage ?? 'null'}

Previous state:
${yaml({
	previousBoundaryTick: context.previousBoundaryTick,
	remainingOnsetStartIndex: context.remainingOnsetStartIndex,
	defaultOnsetsRule: 'provided onsets stop when tau - firstTau > 32',
})}

Score-side approximate tick ranges, not authoritative:
${yaml({
	currentMeasure: context.currentScoreTickRange,
	nextMeasure: context.nextScoreTickRange,
})}

Next page-turn timing guidance:
${yaml(context.nextPageTurn ?? { nextPageTurn: null })}

Current measure spartitoPoints:
${yaml(context.currentMeasureSpartitoPoints)}

Next measure spartitoPoints:
${yaml(context.nextMeasureSpartitoPoints)}

Remaining MIDI onsets:
${yaml(context.remainingOnsets)}

Return the JSON object for this one boundary only.`;


const loadExistingOutput = (outputPath: string, legacyOutputPath: string) => {
	const sourcePath = fs.existsSync(outputPath) ? outputPath : legacyOutputPath;
	return fs.existsSync(sourcePath) ? JSON.parse(fs.readFileSync(sourcePath).toString()) as SegmentationOutput : undefined;
};


const loadOrCreateOutput = (
	outputPath: string,
	legacyOutputPath: string,
	scoreDir: string,
	spartitoPath: string,
	midiPath: string,
	model: string,
	spartitoMeasureCount: number,
	onsetCount: number,
): SegmentationOutput => {
	const existing = loadExistingOutput(outputPath, legacyOutputPath);
	if (existing) {
		if (existing.kind !== 'formal-midi-segmentation' || existing.version !== 1)
			throw new Error(`unsupported segmentation output: ${fs.existsSync(outputPath) ? outputPath : legacyOutputPath}`);
		return existing;
	}

	const now = new Date().toISOString();
	return {
		version: 1,
		kind: 'formal-midi-segmentation',
		scoreDir,
		spartitoPath,
		midiPath,
		model,
		createdAt: now,
		updatedAt: now,
		spartitoMeasureCount,
		onsetCount,
		boundaries: [],
	};
};


const upsertBoundary = (output: SegmentationOutput, boundary: BoundaryAnnotation) => {
	output.boundaries = output.boundaries.filter(b => b.measureIndex !== boundary.measureIndex);
	output.boundaries.push(boundary);
	output.boundaries.sort((a, b) => a.measureIndex - b.measureIndex);
	output.updatedAt = new Date().toISOString();
};


const getPreviousBoundary = (output: SegmentationOutput, measureIndex: number) => output.boundaries
	.filter(b => b.measureIndex < measureIndex)
	.sort((a, b) => b.measureIndex - a.measureIndex)[0];


const prepareMeasureImage = async (measure: any, destPath: string) => {
	if (fs.existsSync(destPath))
		return destPath;

	try {
		return await compositeMeasureImage(measure, destPath);
	}
	catch (err: any) {
		console.warn(`image generation failed for measure ${measure?.measureIndex}: ${err.message}`);
		return null;
	}
};


const run = async () => {
	const argv = parseArgs();
	const scoreDir = path.resolve(argv.scoreDir ?? path.dirname(path.resolve(argv.spartito ?? '.')));
	const measuresDir = path.join(scoreDir, '.measures');
	const spartitoPath = path.resolve(argv.spartito ?? path.join(scoreDir, 'spartito.json'));
	const midiPath = path.resolve(argv.midi ?? path.join(scoreDir, 'transkun.mid'));
	const outputPath = path.resolve(argv.output ?? path.join(measuresDir, 'midi-segmentation.json'));
	const segmentationYaml = segmentationYamlPath(scoreDir, midiPath);
	const annotationModel = argv.annotationModel || DEFAULT_ANNOTATION_MODEL;

	if (!annotationModel)
		throw new Error('ANNOTATION_MODEL is not set. Use .env or --annotation-model.');
	if (!argv.dryRun && !ANNOTATION_API_KEY)
		throw new Error('ANNOTATION_API_KEY is not set.');

	const rawSpartito = JSON.parse(fs.readFileSync(spartitoPath).toString());
	const spartito = starry.recoverJSON<starry.Spartito>(JSON.stringify(rawSpartito), starry);
	const midi = MIDI.parseMidiData(fs.readFileSync(midiPath));
	const pageTurns = buildPageTurnContexts(scoreDir, midi);
	const spartitoPoints = extractSpartitoEvents(rawSpartito);
	const onsets = midiToOnset(midi);
	const measureCount = rawSpartito.measures.length;
	const toMeasure = Math.min(argv.toMeasure ?? measureCount - 2, measureCount - 2);
	const logDir = path.resolve(argv.logDir ?? path.join(scoreDir, `.midi-annotator-${timestamp()}`));

	ensureDir(measuresDir);
	ensureDir(path.dirname(outputPath));
	ensureDir(logDir);
	const measureImageDir = measuresDir;
	ensureDir(measureImageDir);

	const output = loadOrCreateOutput(outputPath, path.join(scoreDir, 'midi-segmentation.json'), scoreDir, spartitoPath, midiPath, annotationModel, measureCount, onsets.length);
	const existing = new Set(output.boundaries.map(b => b.measureIndex));
	let rounds = 0;
	let measureIndex = argv.fromMeasure ?? 0;

	if (!argv.force && argv.fromMeasure === undefined) {
		while (measureIndex <= toMeasure && existing.has(measureIndex))
			++measureIndex;
	}

	while (measureIndex <= toMeasure) {
		if (!argv.force && existing.has(measureIndex)) {
			++measureIndex;
			continue;
		}
		if (argv.maxRounds !== undefined && rounds >= argv.maxRounds)
			break;

		let remainingWindow = argv.remainingWindow;
		let accepted = false;

		while (!accepted) {
			const previous = getPreviousBoundary(output, measureIndex);
			const remainingOnsetStartIndex = previous?.remainingOnsetStartIndexAfter ?? 0;
			const previousBoundaryTick = previous?.endTick ?? null;
			const currentMeasureRawPoints = spartitoPoints.filter(p => p.measureIndex === measureIndex);
			const nextMeasureRawPoints = spartitoPoints.filter(p => p.measureIndex === measureIndex + 1);
			const prefix = `${padMeasure(measureIndex)}_w${remainingWindow}`;
			const currentImagePath = path.join(measureImageDir, `${padMeasure(measureIndex)}.webp`);
			const nextImagePath = path.join(measureImageDir, `${padMeasure(measureIndex + 1)}.webp`);
			const currentMeasureImage = await prepareMeasureImage(spartito.measures[measureIndex], currentImagePath);
			const nextMeasureImage = await prepareMeasureImage(spartito.measures[measureIndex + 1], nextImagePath);
			const context: RoundContext = {
				measureIndex,
				nextMeasureIndex: measureIndex + 1,
				previousBoundaryTick,
				remainingOnsetStartIndex,
				remainingWindow,
				currentMeasureSpartitoPoints: simplifySpartitoPoints(currentMeasureRawPoints),
				nextMeasureSpartitoPoints: simplifySpartitoPoints(nextMeasureRawPoints),
				remainingOnsets: toPromptOnsets(onsets, remainingOnsetStartIndex),
				currentMeasureImage,
				nextMeasureImage,
				currentScoreTickRange: getScoreTickRange(currentMeasureRawPoints),
				nextScoreTickRange: getScoreTickRange(nextMeasureRawPoints),
				nextPageTurn: getNextPageTurn(pageTurns, measureIndex),
			};

			const prompt = buildPrompt(context);
			const promptLog = path.join(logDir, `${prefix}_prompt.txt`);
			const contextLog = path.join(logDir, `${prefix}_context.json`);
			fs.writeFileSync(promptLog, prompt);
			writeJson(contextLog, context);

			console.log(`measure ${measureIndex}/${toMeasure}, onsets ${remainingOnsetStartIndex}+${context.remainingOnsets.length} (tau window <=32)`);

			if (argv.dryRun) {
				console.log('dry run prompt:', promptLog);
				console.log('dry run context:', contextLog);
				console.log('segmentation json:', outputPath);
				console.log('segmentation yaml:', segmentationYaml);
				return;
			}

			const onsetsPath = path.join(logDir, 'onsets.json');
			if (!fs.existsSync(onsetsPath))
				writeJson(onsetsPath, onsets);
			const mcpConfig = {
				mcpServers: {
					'midi-onsets': {
						command: 'npx',
						args: [
							'tsx',
							path.resolve(__dirname, 'onsetsMcp.ts'),
						],
						env: { ONSETS_PATH: onsetsPath },
					},
				},
			};
			const mcpConfigPath = path.join(logDir, 'mcp.json');
			writeJson(mcpConfigPath, mcpConfig);
			const claudeArgs = [
				'-p',
				'--output-format', 'json',
				'--append-system-prompt', MIDI_SEGMENTATION_SYSTEM_PROMPT,
				'--allowedTools', 'Read,mcp__midi-onsets__get_onsets',
				'--mcp-config', mcpConfigPath,
				'--effort', 'max',
				'--verbose',
			];
			const env: Record<string, string> = {
				...process.env as Record<string, string>,
				ANTHROPIC_BASE_URL: ANNOTATION_BASE_URL ?? '',
				ANTHROPIC_AUTH_TOKEN: ANNOTATION_API_KEY!,
				ANTHROPIC_MODEL: annotationModel,
				ANTHROPIC_SMALL_FAST_MODEL: annotationModel,
			};
			let runResult!: ClaudeRun;
			let cliResult!: ClaudeJsonResult;
			let validated!: ReturnType<typeof validateBoundary>;
			const stdoutLog = path.join(logDir, `${prefix}_stdout.json`);
			const stderrLog = path.join(logDir, `${prefix}_stderr.txt`);
			const trajectoryLog = path.join(logDir, `${prefix}_trajectory.json`);
			for (let attempt = 1; attempt <= 2; ++attempt) {
				runResult = await spawnClaude(claudeArgs, prompt, env, 20 * 60 * 1000);
				fs.writeFileSync(stdoutLog, runResult.stdout);
				if (runResult.stderr)
					fs.writeFileSync(stderrLog, runResult.stderr);

				try {
					if (runResult.stdout.includes('usage limit') || runResult.stderr.includes('usage limit'))
						throw new Error('API usage limit hit');
					if (runResult.timedOut)
						throw new Error(`Claude timed out for measure ${measureIndex}`);
					if (runResult.signal)
						throw new Error(`Claude killed by signal ${runResult.signal}`);

					cliResult = parseClaudeCliJson(runResult.stdout);
					if (runResult.code !== 0 && !cliResult.textOutput)
						throw new Error(`Claude exited with code ${runResult.code}: ${runResult.stderr.slice(0, 500)}`);

					const parsed = extractJsonObject(cliResult.textOutput);
					validated = validateBoundary(parsed, context, onsets, previousBoundaryTick);
					break;
				}
				catch (err: any) {
					if (err?.message === 'API usage limit hit' || attempt >= 2)
						throw err;
					console.warn(`Claude attempt ${attempt} failed for measure ${measureIndex}: ${err.message}; retrying once`);
				}
			}

			writeJson(trajectoryLog, {
				measureIndex,
				model: annotationModel,
				args: claudeArgs,
				run: runResult,
				cliResult,
				promptLog,
				stdoutLog,
				stderrLog: runResult.stderr ? stderrLog : null,
				contextLog,
			});

			if ('needsMoreOnsets' in validated) {
				const requested = Math.ceil(validated.requestedRemainingWindow);
				const nextWindow = Math.min(argv.maxRemainingWindow, Math.max(remainingWindow * 2, requested));
				if (nextWindow <= remainingWindow)
					throw new Error(`Claude requested more onsets but max window reached: ${validated.reason ?? ''}`);
				remainingWindow = nextWindow;
				continue;
			}

			const resultLog = path.join(logDir, `${prefix}_result.json`);
			validated.promptLog = promptLog;
			validated.rawResponseLog = stdoutLog;
			validated.stderrLog = runResult.stderr ? stderrLog : undefined;
			validated.contextLog = contextLog;
			validated.trajectoryLog = trajectoryLog;
			validated.resultLog = resultLog;
			validated.sessionId = cliResult.sessionId;
			validated.usage = cliResult.usage;
			validated.totalCostUsd = cliResult.totalCostUsd;
			writeJson(resultLog, validated);
			upsertBoundary(output, validated);
			saveOutputAtomic(outputPath, output);
			saveSegmentationYaml(segmentationYaml, output, onsets);
			console.log(`saved boundary m${measureIndex}: ${validated.endTick} (${validated.method}, confidence=${validated.confidence})`);
			accepted = true;
		}

		++rounds;
		++measureIndex;
	}

	saveSegmentationYaml(segmentationYaml, output, onsets);
	console.log('done:', outputPath, `boundaries=${output.boundaries.length}`);
	console.log('yaml saved:', segmentationYaml);
};


run().catch(err => {
	console.error(err);
	process.exit(1);
});
