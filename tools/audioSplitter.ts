
import fs from "fs";
import path from "path";
import YAML from "yaml";
import child_process from "child-process-promise";

import "../env";
import walkDir from "./libs/walkDir";
import { DATA_DIR } from "./libs/constants";
import { WorkBasic } from "./libs/types";
import { ensureDir } from "./libs/utils";



const AUDIO_EXTS = ["mp3", "ogg", "flac"];


const SPLEETER_MODEL = process.env.SPLEETER_MODEL;
const IMSLP_FILES_DIR = process.env.IMSLP_FILES_DIR;


const main = async () => {
	const works = walkDir(DATA_DIR, /\/$/);
	for (const work of works) {
		const basic = YAML.parse(fs.readFileSync(path.join(work, "basic.yaml")).toString()) as WorkBasic;
		console.log(basic.id, basic.title);

		const files = basic.files.filter(file => AUDIO_EXTS.includes(file.ext));
		for (const file of files) {
			//console.log("audio:", basic.id, file.path);
			console.log("Splitting file:", file.id, file.path);
			const fileDir = path.join(work, file.id);
			ensureDir(fileDir);

			const spleeterDir = path.join(fileDir, "spleeter");
			if (fs.existsSync(spleeterDir)) {
				console.log("Spleeter done, skip.");
				continue;
			}

			const proc = child_process.spawn("spleeter", ["separate", "-p", SPLEETER_MODEL, "-o", fileDir, path.join(IMSLP_FILES_DIR, file.path)]).childProcess;
			proc.stderr.on("data", data => console.log("[spleeter err]:", data.toString()));
			proc.stdout.on("data", data => console.log("[spleeter out]:", data.toString()));

			const result = await new Promise(resolve => proc.once("close", (code, signal) => resolve(code)));
			console.debug("Spleeter done:", result);

			const subdir = walkDir(fileDir, /^IMSLP.*\/$/)[0];
			if (subdir)
				fs.renameSync(subdir, spleeterDir);
		};
	};
};

main();
