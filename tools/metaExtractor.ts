
// extract meta info (title, author etc.) from score images by OCR

import fs from "fs";
import path from "path";
import yaml from "yaml";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../env";
import pyClients from "./libs/pyClients";



const argv = yargs(hideBin(process.argv))
	.command(
		"$0 source",
		"Extract meta info from score images",
		yargs => yargs
			.positional("source", {
				type: "string",
			})
			.demandOption("source")
		,
	).help().argv;


const ocrImage = async (filePath: string): Promise<any> => {
	console.log("recognizing:", filePath);

	const image = fs.readFileSync(filePath);
	const resultLoc = await pyClients.predictScoreImages("textLoc", [image]);

	const [resultOCR] = await pyClients.predictScoreImages("textOcr", {
		buffers: [image],
		location: resultLoc[0],
	});

	return resultOCR;
};


const normalizeString = (str: string): string => str.replace(/[,"]/g, " ");


const main = async () => {
	const dirs = fs.readdirSync(argv.source).filter(name => /^\d+/.test(name));
	dirs.sort((d1, d2) => parseInt(d1) - parseInt(d2));
	//console.log("dirs:", dirs);

	const metaPath = path.join(argv.source, "meta.csv");

	for (const dir of dirs) {
		const dirPath = path.join(argv.source, dir);
		if (fs.existsSync(path.join(dirPath, "ocr.yaml")))
			continue;

		const files = fs.readdirSync(dirPath).filter(file => /^\d+/.test(file));
		files.sort();

		if (!files.length)
			continue;

		const meta = {};

		for (const file of files) {
			const filePath = path.join(dirPath, file);
			const result = await ocrImage(filePath);
			//console.log("result:", result);

			const titles = result.areas.filter(area => area.type === "Title");
			const authors = result.areas.filter(area => area.type === "Author");

			titles.sort((i1, i2) => i2.height - i1.height);
			authors.sort((i1, i2) => i2.height - i1.height);

			meta[file] = result;

			if (!titles.length)
				continue;

			const title = normalizeString(titles[0].text);
			const author = normalizeString(authors[0]?.text ?? "");

			const totalMeta = fs.createWriteStream(metaPath, { flags: "a" });
			totalMeta.write(`${dir},${title},${author}\n`);
			totalMeta.close();

			console.log(`${dir}: ${title}`);

			break;
		}

		fs.writeFileSync(path.join(dirPath, "ocr.yaml"), yaml.stringify(meta));
	}

	console.log("Done.");

	process.exit();
};


main();
