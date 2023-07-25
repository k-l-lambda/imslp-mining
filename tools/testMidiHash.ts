
import fs from "fs";
import { MIDI } from "@k-l-lambda/music-widgets";

import {midiToChords, chordsToWords} from "./libs/midiHash";



const main = () => {
	const buffer = fs.readFileSync("./data/2/754508/p0.spartito.midi");
	const midi = MIDI.parseMidiData(buffer);

	const chords = midiToChords(midi);
	const words = chordsToWords(chords);

	console.log("words:", words);
};

main();
