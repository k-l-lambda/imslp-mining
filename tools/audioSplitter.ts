
import fs from "fs";
import path from "path";
import YAML from "yaml";

import "../env";
import walkDir from "./libs/walkDir";
import { DATA_DIR } from "./libs/constants";
import { WorkBasic } from "./libs/types";



const AUDIO_EXTS = ["mp3", "ogg", "flac"];


const main = async () => {
	const works = walkDir(DATA_DIR, /\/$/);
	works.forEach(work => {
		const basic = YAML.parse(fs.readFileSync(path.join(work, "basic.yaml")).toString()) as WorkBasic;
		basic.files.filter(file => AUDIO_EXTS.includes(file.ext)).forEach(file => {
			console.log("audio:", basic.id, file.path);
			// TODO:
		});
	});
};

main();
