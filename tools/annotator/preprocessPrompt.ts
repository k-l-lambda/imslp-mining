
import fs from "fs";
import path from "path";

import { IssueMeasureInfo, compositeMeasureImage } from "./common";
import { PreprocessMidiMeasureContext, serializeMeasureForPreprocess } from "./preprocess";


export const PREPROCESS_SYSTEM_PROMPT = `You are a music notation expert correcting upstream OMR recognition metadata before rhythm/voice annotation.

Your task is NOT to fix rhythm regulation. Do not change ticks, voices, duration, division, dots, beams, or timeWarp. Only output sparse patches for objects and fields that are visibly wrong or strongly contradicted by the notation context.

Patchable issues:
- Event pitches, including accidentals and missing octave shift effects.
- Measure/context basics such as clef, key signature, local accidentals, and octave shift tokens.
- Event accessories such as scripts-trill, scripts-turn, staccato/tenuto/accent/fermata, dynamics, slurs/ties, pedal marks.

MIDI/onsets may be provided as optional supporting evidence for performed pitches and ornaments. If MIDI conflicts with the rendered measure image, trust the image and produce patches that match the image.

Important STARRY pitch rule:
- Event pitches are objects like {"note": number, "alter": number, "octaveShift"?: number}.
- "note" is NOT a 12-semitone pitch class. It is a diatonic note index: mod 7 maps to C,D,E,F,G,A,B.
- MIDI conversion is:
  group = floor(note / 7)
  gn = note mod 7
  midiPitch = 60 + group * 12 + [0,2,4,5,7,9,11][gn] + alter + octaveShift * 12
- Serialized input includes "midiPitch" and "pitchName" for each current pitch. Use those fields instead of guessing from note numbers.
- Existing correct pitch fields may be omitted from the patch. Patch objects are sparse: include only problematic events/contexts/fields.
- If replacing an event's pitches, include the complete corrected pitches array for that event only.
- Be careful with octave shift: STARRY may store octaveShift in the pitch object and also use octave-shift context terms. Do not double-shift; patch only what is needed to make the measure data match the image.

Pitch examples:
- {"note": 14, "alter": 0, "octaveShift": 0} = C6 = MIDI 84. Do NOT call it D.
- {"note": 13, "alter": -1, "octaveShift": 0} = Bb5 = MIDI 82. Do NOT call it C natural.
- {"note": 12, "alter": -1, "octaveShift": 0} = Ab5 = MIDI 80.
- {"note": 7, "alter": 0, "octaveShift": 0} = C5 = MIDI 72.

Before changing any pitch, verify all three:
1. current "pitchName"/"midiPitch",
2. matching MIDI onset pitch if MIDI is present,
3. image evidence.
If current pitch already matches MIDI and the image is not clearly contradictory, output no pitch patch.

Output ONLY JSON:
{"patches":[
  {
    "measureIndex": 7,
    "reason": "trill missing on first upper-staff note",
    "events": [
      {"id": 1, "accessories": {"add": [{"type": "scripts-trill", "direction": "^", "x": 0.75}]}}
    ]
  }
]}

Allowed sparse patch fields:
- measureIndex: number
- reason: short explanation
- events: [{ id, pitches?, accessories?, grace? }]
- accessories: { add?, remove?, replace? }
- contexts: [{ action: "add"|"remove"|"replace", staff, index?, match?, term? }]
- basics: { timeSignature?, timeSigNumeric?, keySignature?, doubtfulTimesig? }

Do not output unchanged events. Do not invent missing note events. If unsure, output no patch for that item.`;

export interface BuildPreprocessPromptOptions {
	imageMode?: "path" | "attached";
	midiContexts?: Map<number, PreprocessMidiMeasureContext>;
	measureImagesDir?: string;
}

export interface PreprocessPromptResult {
	text: string;
	imagePaths: string[];
}

export const buildPreprocessPrompt = async (
	issues: IssueMeasureInfo[],
	tmpDir: string,
	options: BuildPreprocessPromptOptions = {},
): Promise<PreprocessPromptResult> => {
	const imagePaths: string[] = [];
	const sections: string[] = [];

	for (const issue of issues) {
		const measure = issue.measure;
		const renderedImagePath = path.join(tmpDir, `pre_m${measure.measureIndex}.webp`);
		const existingImagePath = options.measureImagesDir ? path.join(options.measureImagesDir, `m${String(measure.measureIndex).padStart(3, "0")}.webp`) : null;
		const imagePath = existingImagePath && fs.existsSync(existingImagePath) ? existingImagePath : renderedImagePath;
		if (imagePath === renderedImagePath)
			await compositeMeasureImage(measure, imagePath);
		imagePaths.push(imagePath);

		const serialized = serializeMeasureForPreprocess(measure, options.midiContexts?.get(measure.measureIndex));
		sections.push([
			`## Measure ${measure.measureIndex}`,
			`Image: ${options.imageMode === "attached" ? path.basename(imagePath) : imagePath}`,
			"Data:",
			"```json",
			JSON.stringify(serialized, null, "\t"),
			"```",
		].join("\n"));
	}

	return {
		text: [
			"Review the following measures for upstream recognition metadata problems.",
			"Read each image before deciding. MIDI data, when present, is supporting evidence only; image wins on conflicts.",
			"Return sparse JSON patches only for incorrect objects/fields.",
			"",
			...sections,
		].join("\n"),
		imagePaths,
	};
};
