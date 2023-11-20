
import fs from "fs";
import path from "path";
import YAML from "yaml";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { Prisma } from '@prisma/client';

import "../env";
import prisma from "./libs/prismaClient";
import { DATA_DIR } from "./libs/constants";
import { ensureDir } from "./libs/utils";



const DB_WORK_LIMIT = process.env.DB_WORK_LIMIT || 1e+6;


const EXT_MAP = {
	midi: "mid",
	jpeg: "jpg",
};


const argv = yargs(hideBin(process.argv))
	.command(
		"$0 [options]",
		"Initialize data directory",
		yargs => yargs
			.option("ids", { alias: "i", type: "string" })
		,
	).help().argv;


const main = async () => {
	ensureDir(DATA_DIR);

	const query = argv.ids ? prisma.$queryRaw`SELECT * FROM Work
		WHERE id IN (${Prisma.join(argv.ids.split(","))})`
		: prisma.$queryRaw`SELECT * FROM Work
		WHERE pdfs like '%"savePath"%' OR audios like '%"savePath"%'
		LIMIT ${DB_WORK_LIMIT}`;

	const works = (await query) as any[];

	works.forEach(work => {
		//console.log(work.id);
		const dir = path.join(DATA_DIR, work.id.toString());
		ensureDir(dir);

		const pdfs = JSON.parse(work.pdfs) || [];
		const audios = JSON.parse(work.audios) || [];

		const files = [];

		[...pdfs, ...audios].forEach(tab => {
			const tabName = tab.id.replace(/^#tab/, "");

			tab.files.forEach((group, gi) => group.filter(file => file.savePath).forEach(file => {
				const fileId = file.url.match(/\d+$/)[0];
				const ext = file.savePath.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
				files.push({
					id: fileId,
					tab: tabName,
					tabText: tab.text,
					rating: file.ratings?.[0],
					rateBy: Number(file.ratings?.[1]),
					group: gi,
					title: file.title,
					path: file.savePath,
					ext: EXT_MAP[ext] || ext,
				});
			}));
		});

		const titleAuthor = work.title.match(/^(.*\S)\s*\((.*)\)/);
		const title = titleAuthor ? titleAuthor[1] : work.title;
		const author = titleAuthor && titleAuthor[2];

		const basic = {
			id: work.id,
			title,
			author,
			url: work.url,
			meta: JSON.parse(work.metadata),
			categories: JSON.parse(work.categories),
			files,
		};

		fs.writeFileSync(path.join(dir, "basic.yaml"), YAML.stringify(basic));
	});

	console.log("Done:", works.length);
};


main();
