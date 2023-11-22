
import fs from "fs";
import path from "path";
import YAML from "yaml";
import { Minhash, LshIndex } from "minhash";
import { MIDI } from "@k-l-lambda/music-widgets";

import "../env";

import { DATA_DIR, MINHASH_BANDSIZE } from "./libs/constants";
import * as minhashSerializer from "./libs/minhashSerializer";
import * as midiHash from "./libs/midiHash";



const hashMidiFile = (file: string): Minhash => {
	const buffer = fs.readFileSync(file);
	const midi = MIDI.parseMidiData(buffer);
	const words = midiHash.chordsToWords(midiHash.midiToChords(midi));

	const hash = new Minhash();
	words.forEach(word => hash.update(word));

	return hash;
};


const main = async (csvPath: string) => {
	const maestroRoot = path.dirname(csvPath);

	const csv = fs.readFileSync(csvPath, "utf8");
	const lines = csv.split("\n");
	const table = lines.map(line => line.split(",")).slice(1).map(fields => {
		const yearIndex = fields.findIndex(field => /^20\d\d$/.test(field));
		const title = fields.slice(1, yearIndex - 1).join(",");

		return [fields[0], title, ...fields.slice(yearIndex - 1)];
	});
	//const paths = table.map(fields => fields[4]);
	//console.log("paths:", paths);

	const hashLibPath = path.join(DATA_DIR, "midi-hash.yaml");
	const hashLibSource = YAML.parse(fs.readFileSync(hashLibPath).toString()) as Record<string, Record<string, string>>;

	// construct Minhash
	const hashLib = Object.fromEntries(Object.entries(hashLibSource).map(([workId, dict]) => [
		workId,
		Object.fromEntries(Object.entries(dict).map(([path, base64]) => [path, minhashSerializer.parse(base64)])),
	]));

	const index = new LshIndex({bandSize: MINHASH_BANDSIZE});
	const hashDict = {} as Record<string, Minhash>;

	Object.entries(hashLib).forEach(([workId, dict]) => Object.entries(dict).forEach(([path, hash]) => {
		const key = `${workId}/${path}`;
		index.insert(key, hash);
		hashDict[key] = hash;
	}));

	const indexing = [];

	table.forEach((fields, li) => {
		const midiPath = fields[4];
		console.log("Querying:", fields[7], midiPath);

		const works = fields[7].split(";");
		const validIds = works.filter(workId => hashLib[workId]);
		//console.log("path:", path, works);

		const hash = hashMidiFile(path.join(maestroRoot, midiPath));
		index.insert(`_${li}`, hash);
		//console.log("hash:", minhashSerializer.stringify(hash));

		/*const localIndex = new LshIndex({bandSize: MINHASH_BANDSIZE});
		localIndex.insert(`_${li}`, hash);
		validIds.forEach(workId => Object.entries(hashLib[workId]).forEach(([path, hash]) => localIndex.insert(`${workId}/${path}`, hash)));

		let keys = validIds.length ? localIndex.query(hash).filter(k => !k.startsWith("_")) : [];
		if (!keys.length) {
			console.log("no local matching keys.");
			keys = index.query(hash).filter(k => !k.startsWith("_"));
		}*/
		const keys = index.query(hash).filter(k => !k.startsWith("_"));

		const similarities = keys.map(key => [key, hash.jaccard(hashDict[key])]).sort((i1, i2) => i2[1] - i1[1]);
		if (similarities.length)
			console.log("similarities:", similarities);

		indexing.push({
			midi: midiPath,
			works: fields[7],
			imslp: similarities,
		});
	});

	fs.writeFileSync(path.join(maestroRoot, "imslp-indexing.yaml"), YAML.stringify(indexing));
};


main(process.argv[2]);
