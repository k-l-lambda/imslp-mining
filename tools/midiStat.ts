
import fs from "fs";
import { MIDI } from "@k-l-lambda/music-widgets";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import YAML from "yaml";

import walkDir from "./libs/walkDir";



const argv = yargs(hideBin(process.argv))
	.command(
		"$0 source [options]",
		"MIDI event classific counting",
		yargs => yargs
			.positional("source", { type: "string", describe: "" })
			.demandOption("source")
		,
	).help().argv;


const main = () => {
	const files = walkDir(argv.source, /\.midi?$/, { recursive: true });
	//console.log("files:", files);

	const countings = {} as Record<string, number>;

	files.forEach((file, index) => {
		process.stdout.write(`\r${index}/${files.length}`);

		const buffer = fs.readFileSync(file);
		const midi = MIDI.parseMidiData(buffer);

		midi.tracks.forEach(events => events.forEach(event => {
			switch (event.subtype) {
				case "controller": {
					//if (event.controllerType === 64)
					//	break;
					const key = `${event.controllerType}_${event.value}`;
					countings[key] = countings[key] || 0;
					++countings[key];
				}

					break;
			}
		}));
	});

	const result = Object.entries(countings).sort((i1, i2) => i2[1] - i1[1]);
	console.log("\ncountings:", YAML.stringify(result.map(pair => `${pair[0]}: ${pair[1]}`)));
};


main();
