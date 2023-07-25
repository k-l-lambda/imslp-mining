
import { MIDI } from "@k-l-lambda/music-widgets";



type Chord = Number[];

interface Onset {
	tick: number;
	pitch: number;
};


const midiToChords = (midi: MIDI.MidiData, {interval = 20} = {}): Chord[] => {
	const tracks = midi.tracks.map(events => {
		let tick = 0;
		return events.reduce((set, event) => {
			tick += event.deltaTime;
			if (event.subtype === "noteOn")
				set.push({tick, pitch: event.noteNumber!});

			return set;
		}, [] as Onset[]);
	});

	const onset = tracks.flat(1).sort((o1, o2) => o1.tick - o2.tick);
	const chords = [] as Chord[];

	while (onset.length) {
		let note = onset.shift();
		const pitches = new Set([note.pitch]);

		while (onset.length && onset[0].tick - note.tick < interval) {
			note = onset.shift();
			pitches.add(note.pitch);
		}

		const chord = Array.from(pitches);
		chord.sort((p1, p2) => p1 - p2);
		chords.push(chord);
	}

	return chords;
};


const chordsToWords = (chords: Chord[], {groupSize = 2} = {}): string[] => {
	const groups = Array(chords.length - groupSize + 1).fill(0).map((_, i) => chords.slice(i, i + groupSize));

	return groups.map(chords => chords.map(pitches => pitches.map(p => p.toString(16)).join("")).join(";"));
};



export {
	midiToChords,
	chordsToWords,
};
