export type Pitch = {
	note: number;
	alter: number;
	octaveShift?: number;
};

export type NoteOnPoint = [number, number, number];

export type MidiEvent = {
	deltaTime?: number;
	subtype?: string;
	noteNumber?: number;
	velocity?: number;
	tick?: number;
	track?: number;
};

export type SpartitoEventPoint = {
	measureIndex: number;
	eventIndex: number;
	id?: number | string;
	staff?: number;
	pivotX?: number;
	intX?: number;
	intY?: number;
	y?: number;
	pitch: number;
	pitchSource?: Pitch;
	tick: number;
};


const GROUP_N_TO_PITCH = [0, 2, 4, 5, 7, 9, 11];
const MIDDLE_C = 60;


const mod = (x: number, n: number) => {
	let y = x % n;
	while (y < 0)
		y += n;
	return y;
};


export const noteToPitch = ({ note, alter, octaveShift = 0 }: Pitch): number => {
	const group = Math.floor(note / 7);
	const gn = mod(note, 7);
	return MIDDLE_C + group * 12 + GROUP_N_TO_PITCH[gn] + alter + octaveShift * 12;
};


export const midiToOnset = (midi: any): NoteOnPoint[] => {
	const tracks = midi.tracks as MidiEvent[][];
	let trackIndex = 0;

	for (const track of tracks) {
		let tick = 0;
		for (const event of track) {
			tick += event.deltaTime ?? 0;
			event.track = trackIndex;
			event.tick = tick;
		}
		++trackIndex;
	}

	const points = tracks
		.map(events => events.filter(e => e.subtype === 'noteOn' && (e.velocity ?? 0) > 0).map(event => [event.noteNumber!, event.tick!] as [number, number]))
		.flat(1)
		.sort((p1, p2) => p1[1] - p2[1]);

	if (!points.length)
		return [];

	const intervals = [0];
	let lastT = points[0][1];
	points.slice(1).forEach(p => {
		const t = p[1];
		if (t > lastT + 24) {
			intervals.push(t - lastT);
			lastT = t;
		}
	});

	const medianT = intervals[Math.floor(intervals.length * 0.62)] || 160;
	const unitT = Math.min(160, medianT);

	let tau = 0;
	return points.map((p, i) => {
		if (i === 0)
			return [p[0], p[1], tau] as NoteOnPoint;

		const t1 = p[1];
		const t0 = points[i - 1][1];
		tau += Math.tanh((t1 - t0) / unitT);

		return [p[0], p[1], tau] as NoteOnPoint;
	});
};


export const extractSpartitoEvents = (spartito: any): SpartitoEventPoint[] => {
	const points: SpartitoEventPoint[] = [];
	let measureStart = 0;

	spartito.measures.forEach((measure: any, measureIndex: number) => {
		const events = measure.events ?? [];
		const measureDuration = measure.estimatedDuration || measure.duration || 1920;
		const maxIntX = Math.max(0, ...events.map((event: any) => Number(event.intX ?? 0)));

		events.forEach((event: any, eventIndex: number) => {
			if (event.rest)
				return;

			const localTick = maxIntX > 0 ? Number(event.intX ?? 0) / maxIntX * measureDuration : 0;
			const tick = measureStart + localTick;
			const pitches = event.pitches?.length ? event.pitches : [];
			const ys = event.ys?.length ? event.ys : [];

			pitches.forEach((pitch: Pitch, pitchIndex: number) => {
				points.push({
					measureIndex,
					eventIndex,
					id: event.id,
					staff: event.staff,
					pivotX: event.pivotX,
					intX: event.intX,
					intY: event.intY,
					y: ys[pitchIndex],
					pitch: noteToPitch(pitch),
					pitchSource: pitch,
					tick,
				});
			});
		});

		measureStart += measureDuration;
	});

	return points;
};
