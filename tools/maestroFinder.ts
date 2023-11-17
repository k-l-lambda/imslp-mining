
import fs from "fs";

import "../env";
import prisma from "./libs/prismaClient";



interface QueryResult {
	id: number;
	title: string;
	meta: Object;
};


const patternize = word => `%${word}%`;


const formatName = name => {
	const [_, firstName, lastName] = name.match(/^(.*)\s+(\S+)$/);

	return `${lastName}, ${firstName}`;
};


const stringSimilarity = (str1: string, str2: string): number => {
	const words1 = str1.match(/\w+/g).map(s => s.toLocaleLowerCase());
	const words2 = str2.match(/\w+/g).map(s => s.toLocaleLowerCase());

	return words2.reduce((counting, word) => counting + (words1.includes(word) ? 1 : 0), 0);
};


const queryComposer = async (composer: string): Promise<QueryResult[]> => {
	const formalName = formatName(composer);
	//console.log("formalName:", formalName);

	let works = await prisma.$queryRaw`SELECT * FROM Work
	WHERE metadata LIKE ${patternize(formalName)} AND pdfs like '%"savePath"%'
	LIMIT 1000` as any[];

	if (!works.length) {
		const lastName = composer.match(/(\S+)$/)[1];
		works = await prisma.$queryRaw`SELECT * FROM Work
		WHERE metadata LIKE ${patternize(lastName)} AND pdfs like '%"savePath"%'
		LIMIT 1000` as any[];
	}

	return works.map(work => ({
		id: work.id,
		title: work.title,
		meta: JSON.parse(work.metadata),
	}));
};


const composerMap = new Map<string, QueryResult[]>;


const queryWork = async (composer: string, titles: string[]): Promise<QueryResult[]> => {
	if (!composerMap.get(composer))
		composerMap.set(composer, await queryComposer(composer));

	const title = titles.join(", ");

	const works = composerMap.get(composer);
	const simlarities = works.map(work => stringSimilarity(work.title, title));
	//console.log("simlarities:", title, simlarities);

	const similars = works.map((work, i) => ({work, similarity: simlarities[i]}))
		.filter(({similarity}) => similarity > 0)
		.sort((w1, w2) => (w2.similarity - w1.similarity))
		;

	return similars.filter(work => work.similarity >= similars[0].similarity).map(({work}) => work);
};


const main = async (csvPath: string) => {
	/*const works = await queryWork("Alban Berg", ["Sonata Op. 1"]);
	console.log("works:", works.map(work => work.title));
	return;*/
	const csv = fs.readFileSync(csvPath, "utf8");
	//console.log("csv:", csv);
	const table = csv.split("\n").map(line => line.split(",")).slice(1);
	//console.log("table:", table.length);

	const workKeys = new Set(table.map(([composer, title]) => `${composer}|${title}`));
	//console.log("works:", workKeys);

	for (const key of Array.from(workKeys).slice(0, 10)) {
		const [composer, title] = key.split("|");
		//console.log("fields:", composer, title);
		const composers = composer.split("/").map(c => c.trim());
		// remove spaces at begin and end

		const titles = title.replace(/["%]/g, "").replace(/\([^()]+\)/g, "").split(",").map(s => s.split(";")).flat(1).map(c => c.trim());
		//console.log("composers:", key, composers, titles);

		const works = (await Promise.all(composers.map(composer => queryWork(composer, titles)))).flat(1);
		console.log("works:", key, works.map(work => work.title));
	}
};


main(process.argv[2]);
