
import fs from "fs";
import YAML from "yaml";
import { MIDI } from "@k-l-lambda/music-widgets";

import { starry } from "../libs/omr";


export type NoteOnPoint = [number, number, number];

export interface MidiSegmentationEntry {
	measureIndex: number;
	tick: number;
	duration: number;
	confidence?: number;
	matchScore?: number;
}

export interface PreprocessMidiOnsetGroup {
	tick: number;
	relativeTick: number;
	tau: number;
	pitches: number[];
	onsets: [number, number][];
}

export interface PreprocessMidiMeasureContext {
	segmentation: MidiSegmentationEntry;
	onsets: { index: number; pitch: number; tick: number; tau: number }[];
}

export interface PreprocessPatch {
	measureIndex: number;
	reason?: string;
	events?: PreprocessEventPatch[];
	contexts?: PreprocessContextPatch[];
	basics?: PreprocessBasicsPatch;
	status?: number;
}

export interface PreprocessEventPatch {
	id: number;
	pitches?: starry.TermPitch[];
	accessories?: AccessoryPatch;
	grace?: false | "grace" | null;
	beam?: "Open" | "Continue" | "Close" | null;
}

export interface AccessoryPatch {
	add?: PreprocessAccessory[];
	remove?: PreprocessAccessorySelector[];
	replace?: PreprocessAccessory[];
}

export interface PreprocessAccessory {
	type: string;
	direction?: "^" | "_" | "-" | null;
	x?: number;
	parenthesized?: boolean;
}

export interface PreprocessAccessorySelector {
	type: string;
	id?: string;
}

export interface PreprocessContextPatch {
	action: "add" | "remove" | "replace";
	staff: number;
	index?: number;
	match?: { tokenType?: string; tick?: number; y?: number };
	term?: {
		tokenType: string;
		y: number;
		tick?: number;
		staff?: number;
		x?: number;
	};
}

export interface PreprocessBasicsPatch {
	timeSignature?: { numerator: number; denominator: number };
	timeSigNumeric?: boolean;
	keySignature?: number;
	doubtfulTimesig?: boolean;
}

export interface PreprocessApplyResult {
	measureIndex: number;
	applied: boolean;
	warnings: string[];
}

const ACCESSORY_PREFIXES = [
	"scripts-",
	"pedal-",
	"arpeggio",
	"fermata",
	"wedge",
	"accidentals-",
	"dynamics-",
	"clefs-",
	"octave-",
	"|slur",
	"|tie",
];

const ACCESSORY_EXACT = new Set(["f", "p", "m", "r", "s", "z"]);
const CONTEXT_PREFIXES = ["clefs-", "accidentals-", "octave-", "timesig-"];
const CONTEXT_EXACT = new Set(["zero|timesig0", "one|timesig1", "two|timesig2", "three|timesig3", "four|timesig4", "five|timesig5", "six|timesig6", "seven|timesig7", "eight|timesig8", "nine|timesig9"]);

const isFiniteInteger = (value: unknown): value is number => Number.isInteger(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isValidAlter = (value: unknown) => isFiniteInteger(value) && value >= -2 && value <= 2;
const isValidOctaveShift = (value: unknown) => value === undefined || (isFiniteInteger(value) && value >= -2 && value <= 2);
const isValidDirection = (value: unknown) => value === undefined || value === null || value === "^" || value === "_" || value === "-";
const isValidBeam = (value: unknown) => value === undefined || value === null || value === "Open" || value === "Continue" || value === "Close";
const isValidAccessoryType = (type: unknown) => typeof type === "string" && (ACCESSORY_EXACT.has(type) || ACCESSORY_PREFIXES.some(prefix => type.startsWith(prefix)));
const isValidContextTokenType = (type: unknown) => typeof type === "string" && (CONTEXT_EXACT.has(type) || CONTEXT_PREFIXES.some(prefix => type.startsWith(prefix)));

const cloneMeasure = (measure: starry.SpartitoMeasure): starry.SpartitoMeasure =>
	starry.recoverJSON<starry.SpartitoMeasure>(JSON.parse(JSON.stringify(measure.toJSON())), starry);

const restoreMeasure = (target: starry.SpartitoMeasure, snapshot: starry.SpartitoMeasure) => {
	const restored = cloneMeasure(snapshot);
	Object.keys(target).forEach(key => delete (target as any)[key]);
	Object.assign(target, restored);
};

const normalizePitch = (pitch: any): starry.TermPitch | null => {
	if (!pitch || !isFiniteInteger(pitch.note) || !isValidAlter(pitch.alter))
		return null;
	if (!isValidOctaveShift(pitch.octaveShift))
		return null;
	const result: starry.TermPitch = {
		note: pitch.note,
		alter: pitch.alter,
	};
	if (pitch.octaveShift !== undefined) result.octaveShift = pitch.octaveShift;
	if (pitch.tying !== undefined) result.tying = !!pitch.tying;
	if (pitch.tied !== undefined) result.tied = !!pitch.tied;
	if (pitch.parenthesized !== undefined) result.parenthesized = !!pitch.parenthesized;
	return result;
};

const normalizeAccessory = (accessory: PreprocessAccessory, warnings: string[]): starry.Accessory | null => {
	if (!isValidAccessoryType(accessory?.type)) {
		warnings.push(`invalid accessory type: ${accessory?.type}`);
		return null;
	}
	if (!isValidDirection(accessory.direction)) {
		warnings.push(`invalid accessory direction: ${accessory.direction}`);
		return null;
	}
	return {
		type: accessory.type as starry.TokenType,
		direction: accessory.direction === null ? undefined : accessory.direction as any,
		x: isFiniteNumber(accessory.x) ? accessory.x : 0,
		parenthesized: accessory.parenthesized || undefined,
	};
};

const contextIndexByPatch = (contexts: starry.ContextedTerm[], patch: PreprocessContextPatch): number => {
	if (isFiniteInteger(patch.index)) return patch.index;
	if (!patch.match) return -1;
	return contexts.findIndex(term => {
		if (patch.match?.tokenType !== undefined && term.tokenType !== patch.match.tokenType) return false;
		if (patch.match?.tick !== undefined && term.tick !== patch.match.tick) return false;
		if (patch.match?.y !== undefined && term.y !== patch.match.y) return false;
		return true;
	});
};

const createContextTerm = (term: PreprocessContextPatch["term"], staff: number, warnings: string[]): starry.ContextedTerm | null => {
	if (!term || !isValidContextTokenType(term.tokenType) || !isFiniteNumber(term.y)) {
		warnings.push(`invalid context term: ${JSON.stringify(term)}`);
		return null;
	}
	return new starry.ContextedTerm({
		tokenType: term.tokenType,
		y: term.y,
		tick: isFiniteNumber(term.tick) ? term.tick : 0,
		staff: isFiniteInteger(term.staff) ? term.staff : staff,
		x: isFiniteNumber(term.x) ? term.x : undefined,
	});
};

const NOTE_STEPS = ["C", "D", "E", "F", "G", "A", "B"];
const GROUP_N_TO_PITCH = [0, 2, 4, 5, 7, 9, 11];
const MIDDLE_C = 60;
const mod = (x: number, n: number) => {
	let y = x % n;
	while (y < 0) y += n;
	return y;
};

export const termPitchToMidi = (pitch: { note: number; alter: number; octaveShift?: number }): number => {
	const group = Math.floor(pitch.note / 7);
	const gn = mod(pitch.note, 7);
	return MIDDLE_C + group * 12 + GROUP_N_TO_PITCH[gn] + pitch.alter;
};

export const termPitchName = (pitch: { note: number; alter: number; octaveShift?: number }): string => {
	const group = Math.floor(pitch.note / 7);
	const gn = mod(pitch.note, 7);
	const alter = pitch.alter > 0 ? "#".repeat(pitch.alter) : pitch.alter < 0 ? "b".repeat(-pitch.alter) : "";
	const octave = group + 4;
	return `${NOTE_STEPS[gn]}${alter}${octave}`;
};

const serializePitch = (pitch: starry.TermPitch) => ({
	...pitch,
	midiPitch: termPitchToMidi(pitch),
	pitchName: termPitchName(pitch),
});

const groupMidiOnsets = (onsets: PreprocessMidiMeasureContext["onsets"], measureStartTick: number): PreprocessMidiOnsetGroup[] => {
	const groups: PreprocessMidiOnsetGroup[] = [];
	for (const onset of onsets) {
		const relativeTick = onset.tick - measureStartTick;
		const last = groups[groups.length - 1];
		if (last && Math.abs(onset.tick - last.tick) <= 24) {
			const count = last.onsets.length + 1;
			last.pitches.push(onset.pitch);
			last.onsets.push([onset.pitch, relativeTick]);
			last.tick = Math.round((last.tick * (count - 1) + onset.tick) / count);
			last.relativeTick = Math.round((last.relativeTick * (count - 1) + relativeTick) / count);
			last.tau = Math.round(((last.tau * (count - 1) + onset.tau) / count) * 1000) / 1000;
		} else {
			groups.push({
				tick: onset.tick,
				relativeTick,
				tau: Math.round(onset.tau * 1000) / 1000,
				pitches: [onset.pitch],
				onsets: [[onset.pitch, relativeTick]],
			});
		}
	}
	return groups.map(group => ({
		...group,
		pitches: [...group.pitches].sort((a, b) => a - b),
		onsets: [...group.onsets].sort((a, b) => a[1] - b[1] || a[0] - b[0]),
	}));
};

const serializeMidiContext = (midi?: PreprocessMidiMeasureContext) => {
	if (!midi) return undefined;
	return {
		segmentation: midi.segmentation,
		onsetGroups: groupMidiOnsets(midi.onsets, midi.segmentation.tick),
	};
};

export const serializeMeasureForPreprocess = (measure: starry.SpartitoMeasure, midi?: PreprocessMidiMeasureContext) => ({
	measureIndex: measure.measureIndex,
	staffMask: measure.staffMask,
	timeSignature: measure.timeSignature,
	keySignature: measure.keySignature,
	doubtfulTimesig: measure.doubtfulTimesig,
	duration: measure.duration,
	estimatedDuration: measure.estimatedDuration,
	basics: measure.basics,
	contexts: (measure.contexts || []).map((staffContexts, staff) => (staffContexts || []).map((term, index) => ({
		index,
		staff,
		tokenType: term.tokenType,
		type: term.type,
		y: term.y,
		x: term.x,
		tick: term.tick,
		clef: term.clef,
		alter: term.alter,
		octaveShift: term.octaveShift,
	}))),
	events: measure.events.map((e, index) => ({
		index,
		id: e.id,
		staff: e.staff,
		x: e.x,
		pivotX: e.pivotX,
		ys: e.ys,
		pitches: e.pitches?.map(serializePitch),
		accessories: e.accessories,
		rest: e.rest,
		division: e.division,
		dots: e.dots,
		grace: e.grace,
		beam: e.beam,
		stemDirection: e.stemDirection,
		tick: e.tick,
	})),
	evaluation: measure.regulated ? starry.evaluateMeasure(measure) : undefined,
	midi: serializeMidiContext(midi),
});

const extractJsonWithKey = (output: string, key: string): any | null => {
	const fence = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fence) {
		try { return JSON.parse(fence[1]); } catch {}
	}
	try { return JSON.parse(output.trim()); } catch {}
	const match = output.match(new RegExp(`\\{[\\s\\S]*"${key}"\\s*:\\s*\\[[\\s\\S]*?\\]\\s*\\}`));
	if (match) {
		try { return JSON.parse(match[0]); } catch {}
	}
	return null;
};

export const parsePreprocessPatches = (output: string): PreprocessPatch[] => {
	const parsed = extractJsonWithKey(output, "patches");
	if (!parsed || !Array.isArray(parsed.patches)) {
		console.warn("Failed to parse preprocessing patches from output");
		return [];
	}
	return parsed.patches.filter((patch: any) => isFiniteInteger(patch?.measureIndex));
};

export const readMidiMeasureContexts = (midiPath?: string, segmentationPath?: string): Map<number, PreprocessMidiMeasureContext> => {
	const contexts = new Map<number, PreprocessMidiMeasureContext>();
	if (!midiPath || !segmentationPath) return contexts;
	if (!fs.existsSync(midiPath) || !fs.existsSync(segmentationPath)) return contexts;

	const midi = MIDI.parseMidiData(fs.readFileSync(midiPath));
	const onsets = midiToOnset(midi);
	const entries = YAML.parse(fs.readFileSync(segmentationPath).toString()) as MidiSegmentationEntry[];
	if (!Array.isArray(entries)) return contexts;

	entries.forEach(entry => {
		if (!isFiniteInteger(entry.measureIndex) || !isFiniteNumber(entry.tick) || !isFiniteNumber(entry.duration)) return;
		const start = entry.tick;
		const end = entry.tick + entry.duration;
		contexts.set(entry.measureIndex, {
			segmentation: entry,
			onsets: onsets
				.map((point, index) => ({ index, pitch: point[0], tick: point[1], tau: point[2] }))
				.filter(point => point.tick >= start && point.tick < end),
		});
	});

	return contexts;
};

export const midiToOnset = (midi: any): NoteOnPoint[] => {
	const tracks = midi.tracks as any[][];
	const points = tracks
		.map(events => {
			let tick = 0;
			return events
				.map(event => {
					tick += event.deltaTime ?? 0;
					return { ...event, tick };
				})
				.filter(event => event.subtype === "noteOn" && (event.velocity ?? 0) > 0)
				.map(event => [event.noteNumber!, event.tick!] as [number, number]);
		})
		.flat(1)
		.sort((p1, p2) => p1[1] - p2[1]);

	if (!points.length) return [];

	const intervals = [0];
	let lastT = points[0][1];
	points.slice(1).forEach(point => {
		const t = point[1];
		if (t > lastT + 24) {
			intervals.push(t - lastT);
			lastT = t;
		}
	});

	const medianT = intervals[Math.floor(intervals.length * 0.62)] || 160;
	const unitT = Math.min(160, medianT);
	let tau = 0;
	return points.map((point, index) => {
		if (index === 0) return [point[0], point[1], tau] as NoteOnPoint;
		tau += Math.tanh((point[1] - points[index - 1][1]) / unitT);
		return [point[0], point[1], tau] as NoteOnPoint;
	});
};

export const applyPreprocessPatchToMeasure = (measure: starry.SpartitoMeasure, patch: PreprocessPatch): PreprocessApplyResult => {
	const warnings: string[] = [];
	if (patch.measureIndex !== measure.measureIndex)
		return { measureIndex: patch.measureIndex, applied: false, warnings: [`measure index mismatch: ${patch.measureIndex} != ${measure.measureIndex}`] };

	const snapshot = cloneMeasure(measure);
	let changed = false;

	try {
		const eventMap = new Map<number, starry.EventTerm>();
		measure.events.forEach(event => {
			if (isFiniteInteger(event.id)) eventMap.set(event.id, event);
		});

		for (const eventPatch of patch.events || []) {
			if (!isFiniteInteger(eventPatch.id)) {
				warnings.push(`invalid event id: ${eventPatch.id}`);
				continue;
			}
			const event = eventMap.get(eventPatch.id);
			if (!event) {
				warnings.push(`event ${eventPatch.id} not found`);
				continue;
			}

			if (eventPatch.pitches !== undefined) {
				if (event.rest) {
					warnings.push(`event ${eventPatch.id} is a rest; skip pitches`);
				} else if (!Array.isArray(eventPatch.pitches)) {
					warnings.push(`event ${eventPatch.id} pitches is not an array`);
				} else {
					const pitches = eventPatch.pitches.map(normalizePitch);
					if (pitches.every(Boolean)) {
						event.pitches = pitches as starry.TermPitch[];
						changed = true;
					} else {
						warnings.push(`event ${eventPatch.id} has invalid pitch patch`);
					}
				}
			}

			if (eventPatch.grace !== undefined) {
				(event as any).grace = eventPatch.grace || undefined;
				changed = true;
			}

			if (eventPatch.beam !== undefined) {
				if (!isValidBeam(eventPatch.beam)) {
					warnings.push(`event ${eventPatch.id} has invalid beam patch: ${eventPatch.beam}`);
				} else {
					(event as any).beam = eventPatch.beam || null;
					changed = true;
				}
			}

			const accessoryPatch = eventPatch.accessories;
			if (accessoryPatch) {
				event.accessories = event.accessories || [];
				if (accessoryPatch.replace) {
					const next = accessoryPatch.replace.map(acc => normalizeAccessory(acc, warnings));
					if (next.every(Boolean)) {
						event.accessories = next as starry.Accessory[];
						changed = true;
					}
				}
				for (const selector of accessoryPatch.remove || []) {
					const before = event.accessories.length;
					event.accessories = event.accessories.filter(acc => selector.id ? acc.id !== selector.id : acc.type !== selector.type);
					if (event.accessories.length !== before) changed = true;
				}
				for (const acc of accessoryPatch.add || []) {
					const normalized = normalizeAccessory(acc, warnings);
					if (normalized) {
						event.accessories.push(normalized);
						changed = true;
					}
				}
			}
		}

		for (const contextPatch of patch.contexts || []) {
			if (!isFiniteInteger(contextPatch.staff) || contextPatch.staff < 0) {
				warnings.push(`invalid context staff: ${contextPatch.staff}`);
				continue;
			}
			measure.contexts = measure.contexts || [];
			measure.contexts[contextPatch.staff] = measure.contexts[contextPatch.staff] || [];
			const contexts = measure.contexts[contextPatch.staff];
			const index = contextIndexByPatch(contexts, contextPatch);

			if (contextPatch.action === "add") {
				const term = createContextTerm(contextPatch.term, contextPatch.staff, warnings);
				if (term) {
					contexts.push(term);
					changed = true;
				}
			} else if (contextPatch.action === "remove") {
				if (index < 0 || index >= contexts.length) warnings.push(`context not found on staff ${contextPatch.staff}`);
				else {
					contexts.splice(index, 1);
					changed = true;
				}
			} else if (contextPatch.action === "replace") {
				if (index < 0 || index >= contexts.length) warnings.push(`context not found on staff ${contextPatch.staff}`);
				else {
					const term = createContextTerm(contextPatch.term, contextPatch.staff, warnings);
					if (term) {
						contexts[index] = term;
						changed = true;
					}
				}
			} else {
				warnings.push(`invalid context action: ${(contextPatch as any).action}`);
			}
		}

		if (patch.basics) {
			if (patch.basics.timeSignature) {
				measure.basics = measure.basics || [];
				measure.basics.forEach((basic: any) => {
					if (basic) basic.timeSignature = patch.basics!.timeSignature;
				});
				changed = true;
			}
			if (patch.basics.timeSigNumeric !== undefined) {
				measure.basics = measure.basics || [];
				measure.basics.forEach((basic: any) => {
					if (basic) basic.timeSigNumeric = patch.basics!.timeSigNumeric;
				});
				changed = true;
			}
			if (patch.basics.doubtfulTimesig !== undefined) {
				measure.basics = measure.basics || [];
				measure.basics.forEach((basic: any) => {
					if (basic) basic.doubtfulTimesig = patch.basics!.doubtfulTimesig;
				});
				changed = true;
			}
			if (patch.basics.keySignature !== undefined) {
				warnings.push("keySignature is derived from key contexts; add/replace key contexts instead");
			}
		}

		if (changed) {
			measure.updateContextTick?.();
			measure.postRegulate?.();
			try { starry.evaluateMeasure(measure); } catch (err: any) { throw new Error(`evaluateMeasure failed: ${err.message}`); }
		}

		return { measureIndex: patch.measureIndex, applied: changed, warnings };
	} catch (err: any) {
		restoreMeasure(measure, snapshot);
		warnings.push(`reverted: ${err.message}`);
		return { measureIndex: patch.measureIndex, applied: false, warnings };
	}
};

export const applyPreprocessPatches = (spartito: starry.Spartito, patches: PreprocessPatch[]): Set<number> => {
	const applied = new Set<number>();
	for (const patch of patches) {
		const measure = spartito.measures[patch.measureIndex];
		if (!measure) {
			console.warn(`  m${patch.measureIndex}: measure not found, skipping preprocessing patch`);
			continue;
		}
		const result = applyPreprocessPatchToMeasure(measure, patch);
		for (const warning of result.warnings) console.warn(`  m${patch.measureIndex}: ${warning}`);
		if (result.applied) {
			applied.add(patch.measureIndex);
			console.log(`  m${patch.measureIndex}: preprocessing patch applied`);
		}
	}
	return applied;
};
