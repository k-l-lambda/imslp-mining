import fs from 'fs';
import path from 'path';
import { MIDI } from '@k-l-lambda/music-widgets';
import { extractSpartitoEvents, midiToOnset, type NoteOnPoint, type SpartitoEventPoint } from './common';


const escapeXml = (value: unknown) => String(value)
	.replace(/&/g, '&amp;')
	.replace(/</g, '&lt;')
	.replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;');


export const renderSvg = (spartitoPoints: SpartitoEventPoint[], onsets: NoteOnPoint[]) => {
	const width = 1600;
	const height = 900;
	const margin = { left: 80, right: 40, top: 50, bottom: 70 };
	const plotWidth = width - margin.left - margin.right;
	const plotHeight = height - margin.top - margin.bottom;

	const maxTick = Math.max(1, ...spartitoPoints.map(p => p.tick), ...onsets.map(p => p[1]));
	const minPitch = Math.floor(Math.min(...spartitoPoints.map(p => p.pitch), ...onsets.map(p => p[0])) / 12) * 12;
	const maxPitch = Math.ceil(Math.max(...spartitoPoints.map(p => p.pitch), ...onsets.map(p => p[0])) / 12) * 12;

	const sx = (tick: number) => margin.left + tick / maxTick * plotWidth;
	const sy = (pitch: number) => margin.top + (maxPitch - pitch) / Math.max(1, maxPitch - minPitch) * plotHeight;

	const gridY: string[] = [];
	for (let pitch = minPitch; pitch <= maxPitch; pitch += 12) {
		gridY.push(`<line class="grid" x1="${margin.left}" y1="${sy(pitch).toFixed(2)}" x2="${width - margin.right}" y2="${sy(pitch).toFixed(2)}" />`);
		gridY.push(`<text class="axis-label" x="${margin.left - 10}" y="${sy(pitch).toFixed(2)}" text-anchor="end" dominant-baseline="middle">${pitch}</text>`);
	}

	const gridX: string[] = [];
	const tickStep = Math.max(480, Math.ceil(maxTick / 10 / 480) * 480);
	for (let tick = 0; tick <= maxTick; tick += tickStep) {
		gridX.push(`<line class="grid" x1="${sx(tick).toFixed(2)}" y1="${margin.top}" x2="${sx(tick).toFixed(2)}" y2="${height - margin.bottom}" />`);
		gridX.push(`<text class="axis-label" x="${sx(tick).toFixed(2)}" y="${height - margin.bottom + 24}" text-anchor="middle">${tick}</text>`);
	}

	const onsetNodes = onsets.map(([pitch, tick, tau], index) => `
		<circle class="onset" cx="${sx(tick).toFixed(2)}" cy="${sy(pitch).toFixed(2)}" r="3">
			<title>transkun onset #${index}\npitch=${pitch}\ntick=${tick}\ntau=${tau.toFixed(4)}</title>
		</circle>`).join('');

	const spartitoNodes = spartitoPoints.map(point => `
		<circle class="spartito" cx="${sx(point.tick).toFixed(2)}" cy="${sy(point.pitch).toFixed(2)}" r="4">
			<title>spartito event\nmeasure=${point.measureIndex}\nevent=${point.eventIndex}\nid=${escapeXml(point.id)}\nstaff=${point.staff}\npivotX=${point.pivotX}\nintX=${point.intX}\ny=${point.y}\npitch=${point.pitch}\npitchSource=${escapeXml(JSON.stringify(point.pitchSource))}</title>
		</circle>`).join('');

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
	<style>
		.background { fill: #fbfbf8; }
		.grid { stroke: #ddd; stroke-width: 1; }
		.axis { stroke: #333; stroke-width: 1.5; }
		.axis-label { fill: #555; font: 12px sans-serif; }
		.title { fill: #222; font: 20px sans-serif; font-weight: 600; }
		.subtitle { fill: #555; font: 13px sans-serif; }
		.legend { fill: #333; font: 14px sans-serif; }
		.onset { fill: #1f77b4; opacity: 0.48; }
		.spartito { fill: #d62728; opacity: 0.72; stroke: #fff; stroke-width: 1; }
	</style>
	<rect class="background" x="0" y="0" width="${width}" height="${height}" />
	<text class="title" x="${margin.left}" y="28">Spartito events vs transkun MIDI onsets</text>
	<text class="subtitle" x="${margin.left}" y="46">x = tick / estimated spartito tick, y = MIDI pitch; hover points for event details</text>
	${gridY.join('\n\t')}
	${gridX.join('\n\t')}
	<line class="axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" />
	<line class="axis" x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" />
	<g>${onsetNodes}</g>
	<g>${spartitoNodes}</g>
	<circle class="onset" cx="${width - 300}" cy="28" r="5" /><text class="legend" x="${width - 286}" y="33">transkun.mid noteOn (${onsets.length})</text>
	<circle class="spartito" cx="${width - 300}" cy="52" r="5" /><text class="legend" x="${width - 286}" y="57">spartito event pitches (${spartitoPoints.length})</text>
	<text class="axis-label" x="${margin.left + plotWidth / 2}" y="${height - 18}" text-anchor="middle">tick</text>
	<text class="axis-label" x="22" y="${margin.top + plotHeight / 2}" transform="rotate(-90 22 ${margin.top + plotHeight / 2})" text-anchor="middle">MIDI pitch</text>
</svg>
`;
};


const main = () => {
	const source = process.argv[2];
	if (!source)
		throw new Error('Usage: visualize.ts <score-directory> [output.svg]');

	const sourceDir = path.resolve(source);
	const spartitoPath = path.join(sourceDir, 'spartito.json');
	const midiPath = path.join(sourceDir, 'transkun.mid');
	const outputPath = path.resolve(process.argv[3] ?? path.join(sourceDir, 'midi-annotator-compare.svg'));

	const spartito = JSON.parse(fs.readFileSync(spartitoPath).toString());
	const midi = MIDI.parseMidiData(fs.readFileSync(midiPath));
	const spartitoPoints = extractSpartitoEvents(spartito);
	const onsets = midiToOnset(midi);

	fs.writeFileSync(outputPath, renderSvg(spartitoPoints, onsets));

	console.log('spartito events:', spartito.measures.reduce((n: number, measure: any) => n + (measure.events?.length ?? 0), 0));
	console.log('spartito pitch points:', spartitoPoints.length);
	console.log('transkun onsets:', onsets.length);
	console.log('svg saved:', outputPath);
};


if (require.main === module)
	main();
