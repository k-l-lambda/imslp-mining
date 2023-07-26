
import fs from "fs";
import path from "path";
import YAML from "yaml";

import "../env";

import { WorkBasic } from "./libs/types";
import { DATA_DIR } from "./libs/constants";
import walkDir from "./libs/walkDir";



const FILENAME_REDUCTIONS = [
	{
		pattern: /\d+\.webp/,
		replace: "n.webp",
	},
];


const main = async () => {
	const works = walkDir(DATA_DIR, /\/$/);
	works.sort((d1, d2) => Number(path.basename(d1)) - Number(path.basename(d2)));

	let referenceWorks = 0;

	const workStats = [] as Record<string, any>[];
	const fileExt = {} as Record<string, { size: number, number: number }>;

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

			const subrFiles = walkDir(filePath, /.+/, { recursive: true });
			subrFiles.forEach(file => {
				const stat = fs.statSync(file);
				if (stat.isDirectory())
					return;

				const key = FILENAME_REDUCTIONS.reduce((k, { pattern, replace }) => pattern.test(k) ? replace : k,
					(file.match(/[^\\/.]+\.\w+$/) || file.match(/\w+$/))[0]);
				fileExt[key] = fileExt[key] || { size: 0, number: 0 };
				fileExt[key].size += stat.size;
				++fileExt[key].number;
			});
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

	const extItems = Object.entries(fileExt).sort((i1, i2) => i2[1].size - i1[1].size);
	const csvContent2 = ["name,n,size,size_per_file", ...extItems.map(([key, { size, number }]) => [key, number, new Intl.NumberFormat().format(size), Math.round(size / number)].join("\t"))].join("\n");
	fs.writeFileSync(path.join(DATA_DIR, "ext.tsv"), csvContent2);

	console.log("fileExt:", extItems);
};


main();
