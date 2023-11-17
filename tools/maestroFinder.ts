
import fs from "fs";
import * as levenshtein from "fastest-levenshtein";

import "../env";
import prisma from "./libs/prismaClient";



interface QueryResult {
	id: number;
	title: string;
	meta: Object;
};


const patternize = word => `%${word}%`;


const formatName = name => {
	const captures = name.match(/^(.*)\s+(\S+)$/);
	if (!captures) {
		console.warn("invalid name:", name);
		return name;
	}
	const [_, firstName, lastName] = captures;

	return `${lastName}, ${firstName}`;
};


const WORD_WEIGHTS = {
	sonata: 10,
	waltz: 10,
	minor: 2,
	major: 2,
	no: 10,
	op: 100,
};


const tokenizeStr = str => str.replace(/\.\s*/g, "").match(/\w+/g).map(s => s.toLocaleLowerCase());


const stringSimilarity = (str1: string, str2: string): number => {
	const words1 = tokenizeStr(str1)
	const words2 = tokenizeStr(str2)

	return words2.reduce((counting, word) => counting + (words1.includes(word) ? (WORD_WEIGHTS[word.replace(/\d+/, "")] || 1) : 0), 0);
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
	if (!composer)
		return [];

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
	//console.log("similars:", similars.map(({work, similarity}) => [similarity, work.title]));

	const candidates = similars.filter(work => work.similarity >= similars[0].similarity);

	if (candidates.length > 1) {
		const distances = candidates.map(({work}) => ({
			work,
			distance: levenshtein.distance(title, work.title.replace(/ \([^()]+\)$/, "")),
		})).sort((d1, d2) => d1.distance - d2.distance);
		//console.log("distances:", distances.slice(0, 1000).map(({work, distance}) => [distance, work.title]));

		return distances.filter(work => work.distance <= distances[0].distance).map(({work}) => work);
	}

	return candidates.map(({work}) => work);
};


const main = async (csvPath: string) => {
	/*const works = await queryWork("Alban Berg", ["Sonata Op. 1"]);
	console.log("works:", works.map(work => work.title));
	return;*/
	const csv = fs.readFileSync(csvPath, "utf8");
	//console.log("csv:", csv);
	const lines = csv.split("\n");
	const table = lines.map(line => line.split(",")).slice(1);
	//console.log("table:", table.length);

	const workKeys = new Set(table.map(([composer, title]) => `${composer}|${title}`));
	//console.log("works:", workKeys);

	const key2Ids = new Map<string, number[]>();

	for (const key of Array.from(workKeys)) {
		const [composer, title] = key.split("|");
		//console.log("fields:", composer, title);
		const composers = composer.split("/").map(c => c.trim());
		// remove spaces at begin and end

		const titles = title.replace(/["%]/g, "").replace(/\([^()]+\)/g, "").split(",").map(s => s.split(";")).flat(1).map(c => c.trim());
		//console.log("composers:", key, composers, titles);

		const works = (await Promise.all(composers.map(composer => queryWork(composer, titles)))).flat(1);
		console.log("works:", key, works.map(work => work.title));

		key2Ids.set(key, works.map(work => work.id));
	}

	console.log("ids:", [...key2Ids.values()].flat(1).sort((i1, i2) => i1 - i2).join(","));

	const newTable = table.map(line => {
		const [composer, title] = line;
		const ids = key2Ids.get(`${composer}|${title}`) || [];

		return line.concat([ids.join(";")]);
	});

	const newCsv = [lines[0] + ",ids", ...newTable.map(line => line.join(","))].join("\n");
	fs.writeFileSync(csvPath.replace(/\.\w+$/, "-ids.csv"), newCsv);
};


main(process.argv[2]);
