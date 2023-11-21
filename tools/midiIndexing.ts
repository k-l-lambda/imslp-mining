
import fs from "fs";
import path from "path";
import YAML from "yaml";
import { MIDI } from "@k-l-lambda/music-widgets";
import { Minhash, LshIndex } from "minhash";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../env";

import { DATA_DIR, MINHASH_BANDSIZE } from "./libs/constants";
import walkDir from "./libs/walkDir";
import * as midiHash from "./libs/midiHash";
import { idRange2Filter } from "./libs/utils";
import * as minhashSerializer from "./libs/minhashSerializer";



interface MidiHash {
	key: string;
	hash: Minhash;
};


const argv = yargs(hideBin(process.argv))
	.command(
		"$0 [options]",
		"Construct MIDI indexes.",
		yargs => yargs
			.option("ids", { alias: "i", type: "string" })
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


const main = () => {
	let works = walkDir(DATA_DIR, /\/$/);
	works.sort((d1, d2) => Number(path.basename(d1)) - Number(path.basename(d2)));

	if (argv.ids) {
		const goodId = idRange2Filter(argv.ids);
		works = works.filter(work => goodId(Number(path.basename(work))));
	}

	let n_cluster = 0;
	let n_saCluster = 0;	// sheet - audio cluster
	let n_work = 0;

	const hashLib = {} as Record<string, Record<string, string>>;

	for (const work of works) {
		const workId = path.basename(work);
		const fileDirs = walkDir(work, /\/$/);
		const midiFiles = fileDirs.map(dir => walkDir(dir, /\.midi?$/)).flat(1);
		if (!midiFiles.length)
			continue;

		console.log(String.fromCodePoint(0x1f4d5), `[${workId}]`, midiFiles.length, "MIDI files.");

		const hashes = midiFiles.map(file => hashMidiFile(file, work));
		//console.log("hashes:", hashes);

		hashLib[workId] = hashes.reduce((dict, {key, hash}) => ({...dict, [key]: minhashSerializer.stringify(hash)}), {});

		const index = new LshIndex({bandSize: MINHASH_BANDSIZE});
		hashes.forEach(hash => index.insert(hash.key, hash.hash));

		// clustering
		const refs = new Set<string>();
		const clusters = [] as string[][];

		hashes.forEach(hash => {
			if (refs.has(hash.key))
				return;

			const cluster = index.query(hash.hash);
			clusters.push(cluster);

			cluster.forEach(key => refs.add(key));
		});

		const multiClusters = clusters.filter(cluster => cluster.length > 1);
		if (multiClusters.length) {
			console.log("clusters:", multiClusters);
			n_cluster += multiClusters.length;
			++n_work;

			const saClusters = multiClusters.filter(cluster => cluster.some(key => /spartito/.test(key)) && cluster.some(key => !/spartito/.test(key)));
			n_saCluster += saClusters.length;
		}

		//console.log("clusters:", clusters);
		const indexPath = path.join(work, "index.yaml");
		fs.writeFileSync(indexPath, YAML.stringify({
			midiClusters: clusters,
		}));
	}

	fs.writeFileSync(path.join(DATA_DIR, "midi-hash.yaml"), YAML.stringify(hashLib));

	console.log("Done,", `${n_saCluster}/${n_cluster}`, "clusters found in", n_work, "works.");
}

main();
