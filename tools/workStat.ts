
import fs from "fs";
import path from "path";
import YAML from "yaml";

import "../env";

import { WorkBasic } from "./libs/types";
import { DATA_DIR } from "./libs/constants";
import walkDir from "./libs/walkDir";



const main = async () => {
	const works = walkDir(DATA_DIR, /\/$/);
	works.sort((d1, d2) => Number(path.basename(d1)) - Number(path.basename(d2)));

	let referenceWorks = 0;

	const workStats = [] as Record<string, any>[];

	for (const work of works) {
		const workId = path.basename(work);

		const basic = YAML.parse(fs.readFileSync(path.join(work, "basic.yaml")).toString()) as WorkBasic;
		console.log(String.fromCodePoint(0x1f4d5), basic.id, basic.title);

		const workStat = {
			id: workId,
			sheetFiles: 0,
			midiFiles: 0,
			spartitos: 0,
			originMidis: 0,
			pianoMidis: 0,
			vocalsMidis: 0,
			otherMidis: 0,
			bassMidis: 0,
			drumsMidis: 0,
		};

		for (const file of basic.files) {
			const filePath = path.join(work, file.id);
			if (!fs.existsSync(filePath))
				continue;

			const subFiles = walkDir(filePath, /.+/);

			const spartitos = subFiles.filter(name => name.endsWith(".spartito.json"));
			const midis = subFiles.filter(name => name.endsWith(".midi") || name.endsWith(".mid"));

			if (spartitos.length)
				++workStat.sheetFiles;
			else if (midis.length)
				++workStat.midiFiles;

			const midiFilenames = midis.map(name => path.basename(name));

			workStat.spartitos += spartitos.length;
			workStat.originMidis += midiFilenames.filter(name => name.startsWith("origin")).length;
			workStat.pianoMidis += midiFilenames.filter(name => name.startsWith("piano")).length;
			workStat.vocalsMidis += midiFilenames.filter(name => name.startsWith("vocal")).length;
			workStat.otherMidis += midiFilenames.filter(name => name.startsWith("other")).length;
			workStat.bassMidis += midiFilenames.filter(name => name.startsWith("bass")).length;
			workStat.drumsMidis += midiFilenames.filter(name => name.startsWith("drum")).length;
		}

		if (workStat.sheetFiles || workStat.originMidis)
			workStats.push(workStat);

		if (workStat.sheetFiles && workStat.originMidis)
			++referenceWorks;
	}

	console.log("referenceWorks:", `${referenceWorks}/${workStats.length}`);

	const csvContent = [
		Object.keys(workStats[0]).join(","),
		...workStats.map(stat => Object.values(stat)),
	].join("\n");
	fs.writeFileSync(path.join(DATA_DIR, "stat.csv"), csvContent);
};


main();
