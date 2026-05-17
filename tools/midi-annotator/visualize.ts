import fs from 'fs';
import path from 'path';
import { MIDI } from '@k-l-lambda/music-widgets';
import { extractSpartitoEvents, midiToOnset, type NoteOnPoint, type SpartitoEventPoint } from './common';


type Boundary = {
	measureIndex: number;
	endTick: number;
	confidence?: number;
	method?: string;
};

type Segmentation = {
	boundaries: Boundary[];
};


type RenderPoint = SpartitoEventPoint & {
	displayTick: number;
};


const escapeXml = (value: unknown) => String(value)
	.replace(/&/g, '&amp;')
	.replace(/</g, '&lt;')
	.replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;');


const measureScoreRanges = (spartitoPoints: SpartitoEventPoint[]) => {
	const ranges = new Map<number, { start: number; end: number }>();
	for (const point of spartitoPoints) {
		const range = ranges.get(point.measureIndex);
		if (range) {
			range.start = Math.min(range.start, point.tick);
			range.end = Math.max(range.end, point.tick);
		} else {
			ranges.set(point.measureIndex, { start: point.tick, end: point.tick });
		}
	}
	return ranges;
};


const remapSpartitoPoints = (spartitoPoints: SpartitoEventPoint[], onsets: NoteOnPoint[], segmentation?: Segmentation): RenderPoint[] => {
	if (!segmentation?.boundaries?.length)
		return spartitoPoints.map(point => ({ ...point, displayTick: point.tick }));

	const boundaries = [...segmentation.boundaries].sort((a, b) => a.measureIndex - b.measureIndex);
	const boundaryByMeasure = new Map(boundaries.map(boundary => [boundary.measureIndex, boundary.endTick]));
	const lastBoundary = boundaries[boundaries.length - 1];
	const tailMeasureIndex = lastBoundary.measureIndex + 1;
	const maxOnsetTick = Math.max(lastBoundary.endTick, ...onsets.map(onset => onset[1]));
	const ranges = measureScoreRanges(spartitoPoints);
	return spartitoPoints.flatMap(point => {
		const currentBoundary = boundaryByMeasure.get(point.measureIndex) ?? (point.measureIndex === tailMeasureIndex ? maxOnsetTick : undefined);
		if (currentBoundary === undefined)
			return [];

		const previousBoundary = point.measureIndex === 0 ? 0 : boundaryByMeasure.get(point.measureIndex - 1);
		if (previousBoundary === undefined)
			return [];

		const range = ranges.get(point.measureIndex);
		if (!range || range.end <= range.start)
			return [{ ...point, displayTick: previousBoundary }];

		const alpha = (point.tick - range.start) / (range.end - range.start);
		return [{
			...point,
			displayTick: previousBoundary + alpha * (currentBoundary - previousBoundary),
		}];
	});
};


export const renderSvg = (spartitoPoints: SpartitoEventPoint[], onsets: NoteOnPoint[], segmentation?: Segmentation) => {
	const renderSpartitoPoints = remapSpartitoPoints(spartitoPoints, onsets, segmentation);
	const boundaryTicks = segmentation?.boundaries?.map(boundary => boundary.endTick) ?? [];
	const maxTick = Math.max(1, ...renderSpartitoPoints.map(p => p.displayTick), ...onsets.map(p => p[1]), ...boundaryTicks);
	const margin = { left: 80, right: 40, top: 50, bottom: 70 };
	const pxPerTick = 0.1;
	const width = Math.ceil(maxTick * pxPerTick + margin.left + margin.right);
	const height = 900;
	const plotWidth = maxTick * pxPerTick;
	const plotHeight = height - margin.top - margin.bottom;

	const minPitch = Math.floor(Math.min(...spartitoPoints.map(p => p.pitch), ...onsets.map(p => p[0])) / 12) * 12;
	const maxPitch = Math.ceil(Math.max(...spartitoPoints.map(p => p.pitch), ...onsets.map(p => p[0])) / 12) * 12;

	const sx = (tick: number) => margin.left + tick * pxPerTick;
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

	const boundaryNodes = (segmentation?.boundaries ?? []).map(boundary => `
		<g class="boundary">
			<line x1="${sx(boundary.endTick).toFixed(2)}" y1="${margin.top}" x2="${sx(boundary.endTick).toFixed(2)}" y2="${height - margin.bottom}" />
			<text x="${sx(boundary.endTick).toFixed(2)}" y="${margin.top - 8}" text-anchor="middle">m${boundary.measureIndex}</text>
			<title>boundary after measure ${boundary.measureIndex}\ntick=${boundary.endTick}\nconfidence=${boundary.confidence ?? ''}\nmethod=${boundary.method ?? ''}</title>
		</g>`).join('');

	const onsetNodes = onsets.map(([pitch, tick, tau], index) => {
		const x = sx(tick).toFixed(2);
		const y = sy(pitch).toFixed(2);
		return `
		<g class="onset" transform="translate(${x} ${y})">
			<line x1="-6" y1="0" x2="6" y2="0" />
			<line x1="0" y1="-6" x2="0" y2="6" />
			<title>transkun onset #${index}\npitch=${pitch}\ntick=${tick}\ntau=${tau.toFixed(4)}</title>
		</g>`;
	}).join('');

	const spartitoNodes = renderSpartitoPoints.map(point => `
		<circle class="spartito" cx="${sx(point.displayTick).toFixed(2)}" cy="${sy(point.pitch).toFixed(2)}" r="6">
			<title>spartito event\nmeasure=${point.measureIndex}\nevent=${point.eventIndex}\nid=${escapeXml(point.id)}\nstaff=${point.staff}\npivotX=${point.pivotX}\nintX=${point.intX}\ny=${point.y}\npitch=${point.pitch}\nsourceTick=${point.tick.toFixed(2)}\ndisplayTick=${point.displayTick.toFixed(2)}\npitchSource=${escapeXml(JSON.stringify(point.pitchSource))}</title>
		</circle>`).join('');

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}px" height="${height}px" viewBox="0 0 ${width} ${height}">
	<style>
		.background { fill: #fbfbf8; }
		.grid { stroke: #ddd; stroke-width: 1; }
		.axis { stroke: #333; stroke-width: 1.5; }
		.axis-label { fill: #555; font: 12px sans-serif; }
		.title { fill: #222; font: 20px sans-serif; font-weight: 600; }
		.subtitle { fill: #555; font: 13px sans-serif; }
		.legend { fill: #333; font: 14px sans-serif; }
		.boundary line { stroke: #6a3d9a; stroke-width: 1.5; stroke-dasharray: 6 5; }
		.boundary text { fill: #6a3d9a; font: 12px sans-serif; font-weight: 600; }
		.onset { opacity: 1; }
		.onset line { stroke: #1f77b4; stroke-width: 2; stroke-linecap: round; }
		.spartito { fill: none; opacity: 0.9; stroke: #d62728; stroke-width: 2; }
	</style>
	<rect class="background" x="0" y="0" width="${width}" height="${height}" />
	<text class="title" x="${margin.left}" y="28">Spartito events vs transkun MIDI onsets</text>
	<text class="subtitle" x="${margin.left}" y="46">x = tick / estimated spartito tick, y = MIDI pitch; hover points for event details</text>
	${gridY.join('\n\t')}
	${gridX.join('\n\t')}
	<line class="axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" />
	<line class="axis" x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" />
	<g>${boundaryNodes}</g>
	<g>${onsetNodes}</g>
	<g>${spartitoNodes}</g>
	<g class="onset" transform="translate(${width - 380} 28)"><line x1="-6" y1="0" x2="6" y2="0" /><line x1="0" y1="-6" x2="0" y2="6" /></g><text class="legend" x="${width - 366}" y="33">transkun.mid noteOn (${onsets.length})</text>
	<circle class="spartito" cx="${width - 380}" cy="52" r="6" /><text class="legend" x="${width - 366}" y="57">spartito event pitches (${spartitoPoints.length})</text>
	<g class="boundary"><line x1="${width - 380}" y1="72" x2="${width - 370}" y2="72" /></g><text class="legend" x="${width - 366}" y="77">segmentation boundaries (${segmentation?.boundaries?.length ?? 0})</text>
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
	const measuresDir = path.join(sourceDir, '.measures');
	const outputPath = path.resolve(process.argv[3] ?? path.join(measuresDir, 'midi-annotator-compare.svg'));

	const spartito = JSON.parse(fs.readFileSync(spartitoPath).toString());
	const midi = MIDI.parseMidiData(fs.readFileSync(midiPath));
	const spartitoPoints = extractSpartitoEvents(spartito);
	const onsets = midiToOnset(midi);

	const segmentationPath = [
		path.join(measuresDir, 'midi-segmentation.json'),
		path.join(sourceDir, 'midi-segmentation.json'),
	].find(filePath => fs.existsSync(filePath));
	const segmentation = segmentationPath ? JSON.parse(fs.readFileSync(segmentationPath).toString()) as Segmentation : undefined;

	fs.mkdirSync(path.dirname(outputPath), { recursive: true });

	fs.writeFileSync(outputPath, renderSvg(spartitoPoints, onsets, segmentation));

	console.log('spartito events:', spartito.measures.reduce((n: number, measure: any) => n + (measure.events?.length ?? 0), 0));
	console.log('spartito pitch points:', spartitoPoints.length);
	console.log('transkun onsets:', onsets.length);
	console.log('segmentation boundaries:', segmentation?.boundaries?.length ?? 0);
	console.log('svg saved:', outputPath);
};


if (require.main === module)
	main();
