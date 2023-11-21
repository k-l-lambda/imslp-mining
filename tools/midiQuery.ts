
import fs from "fs";
import path from "path";
import { MIDI } from "@k-l-lambda/music-widgets";
import { Minhash, LshIndex } from "minhash";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../env";

import { DATA_DIR } from "./libs/constants";
import walkDir from "./libs/walkDir";
import * as midiHash from "./libs/midiHash";
import { idRange2Filter } from "./libs/utils";



interface MidiHash {
	key: string;
	hash: Minhash;
};


const argv = yargs(hideBin(process.argv))
	.command(
		"$0 source [options]",
		"Query a MIDI by hash from midi files in works directory.",
		yargs => yargs
			.positional("source", {type: "string", describe: ""})
			.demandOption("source")
			.option("ids", { alias: "i", type: "string" })
			.option("bandSize", { alias: "b", type: "number", default: 3 })
		,
	).help().argv;


const hashMidiFile = (file: string, root: string): MidiHash => {
	const buffer = fs.readFileSync(file);
	const midi = MIDI.parseMidiData(buffer);
	const words = midiHash.chordsToWords(midiHash.midiToChords(midi));

	const hash = new Minhash();
	words.forEach(word => hash.update(word));

	return {
		key: path.relative(root, file),
		hash,
	};
};


const main = async () => {
	let works = walkDir(DATA_DIR, /\/$/);
	works.sort((d1, d2) => Number(path.basename(d1)) - Number(path.basename(d2)));

	if (argv.ids) {
		const goodId = idRange2Filter(argv.ids);
		works = works.filter(work => goodId(Number(path.basename(work))));
	}

	const {hash} = hashMidiFile(argv.source, "");
	//console.log("hash:", hash);

	const index = new LshIndex({bandSize: argv.bandSize});
	const hashMap = {};

	for (const work of works) {
		const workId = path.basename(work);
		const fileDirs = walkDir(work, /\/$/);
		const midiFiles = fileDirs.map(dir => walkDir(dir, /\.midi?$/)).flat(1);
		if (!midiFiles.length)
			continue;

		console.log(String.fromCodePoint(0x1f4d5), `[${workId}]`, midiFiles.length, "MIDI files.");

		const hashes = midiFiles.map(file => hashMidiFile(file, work));
		hashes.forEach(({key, hash}) => {
			hashMap[key] = hash;
			index.insert(key, hash);
		});
	}

	//console.log("index:", index);

	const keys = index.query(hash);
	const similarities = keys.map(key => [key, hash.jaccard(hashMap[key])]).sort((i1, i2) => i2[1] - i1[1]);

	console.log("similarities:", similarities);
	//await new Promise(resolve => setTimeout(resolve, 1e+9));
}

main();
