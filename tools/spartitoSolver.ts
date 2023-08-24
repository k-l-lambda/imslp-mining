
import fs from "fs";
import path from "path";
import YAML from "yaml";
import fetch from "isomorphic-fetch";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../env";

import { WorkBasic } from "./libs/types";
import { DATA_DIR, BEAD_PICKER_URL, SPARTITO_ROOT, SOLUTION_STORE_OPTIONS } from "./libs/constants";
import { starry, AdminSolutionStore, regulateWithBeadSolver } from "./libs/omr";
import OnnxBeadPicker from "./libs/onnxBeadPicker";
import walkDir from "./libs/walkDir";
import { idRange2Filter } from "./libs/utils";



const argv = yargs(hideBin(process.argv))
	.command(
		"$0 [target] [options]",
		"Solve spartito files.",
		yargs => yargs
			.positional("target", { type: "string", describe: "Target directory" })
			.option("ids", { alias: "i", type: "string" })
			.option("logger", { alias: "l", type: "boolean" })
		,
	).help().argv;


const PICKER_SEQS = [32, 64, 128, 512];


const main = async () => {
	const targetDir = argv.target ?? path.join(SPARTITO_ROOT, `imslp-solver${(new Date() as any).format("yyyyMMdd")}`);
	if (!fs.existsSync(targetDir))
		fs.mkdirSync(targetDir);

	const loadings = [] as Promise<void>[];
	const pickers = PICKER_SEQS.map(n_seq => new OnnxBeadPicker(BEAD_PICKER_URL.replace(/seq\d+/, `seq${n_seq}`), {
		n_seq,
		usePivotX: true,
		onLoad: promise => loadings.push(promise.catch(err => console.warn("error to load BeadPicker:", err))),
	}));

	let works = walkDir(DATA_DIR, /\/$/);
	works.sort((d1, d2) => Number(path.basename(d1)) - Number(path.basename(d2)));

	if ((argv as any).ids) {
		const goodId = idRange2Filter((argv as any).ids);
		works = works.filter(work => goodId(Number(path.basename(work))));
	}

	const solutionStore = new AdminSolutionStore({...SOLUTION_STORE_OPTIONS, fetch});

	let n_stat = 0;
	const statSum = {
		totalCost: 0,
		pickerCost: 0,
		measures: {
			cached: 0,
			simple: 0,
			computed: 0,
			tryTimes: 0,
			solved: 0,
			issue: 0,
			fatal: 0,
		},
		qualityScore: 0,
	};
	const reportStat = () => {
		if (!n_stat)
			return;

		console.log("totalCost:", statSum.totalCost, "mean:", statSum.totalCost / n_stat);
		console.log("pickerCost:", statSum.pickerCost, "mean:", statSum.pickerCost / n_stat);
		console.log("measures:");
		console.log("\tcached:", statSum.measures.cached);
		console.log("\tsimple:", statSum.measures.simple);
		console.log("\tcomputed:", statSum.measures.computed);
		console.log("\ttryTimes:", statSum.measures.tryTimes);
		console.log("\tsolved:", statSum.measures.solved);
		console.log("\tissue:", statSum.measures.issue);
		console.log("\tfatal:", statSum.measures.fatal);
		console.log(n_stat, "spartitos, mean qualityScore:", statSum.qualityScore / n_stat);
	};

	await Promise.all(loadings);

	for (const work of works) {
		const workId = path.basename(work);

		const basic = YAML.parse(fs.readFileSync(path.join(work, "basic.yaml")).toString()) as WorkBasic;
		console.log(String.fromCodePoint(0x1f4d5), basic.id, basic.title);

		const files = basic.files.filter(file => file.ext === "pdf");
		for (const file of files) {
			const omrStatePath = path.join(work, file.id, "omr.yaml");
			if (!fs.existsSync(omrStatePath))
				continue;

			const omrState = YAML.parse(fs.readFileSync(omrStatePath).toString());
			if (!omrState.spartito)
				continue;

			for (const item of omrState.spartito) {
				const spartitoPath = path.join(work, file.id, `${item.id}.spartito.json`);
				if (!fs.existsSync(spartitoPath))
					continue;
				console.log("--------------------------------------");
				console.log(String.fromCodePoint(0x1d11e), `${basic.id}/${file.id}/${item.id}`);

				const targetName = omrState.spartito.length > 1 ? `${workId}-${file.id}-${item.id}.spartito.json` : `${workId}-${file.id}.spartito.json`;
				const targetPath = path.join(targetDir, targetName);

				if (fs.existsSync(targetPath)) {
					console.log("Solving finished, skip.");
					continue;
				}

				const content = fs.readFileSync(spartitoPath).toString();
				const spartito = starry.recoverJSON<starry.Spartito>(content, starry);

				const dummyScore = {
					assemble () {},
					makeSpartito () {return spartito},
					assignBackgroundForMeasure (_: starry.SpartitoMeasure) {},
				} as starry.Score;

				const stat = await regulateWithBeadSolver(dummyScore, {
					logger: argv.logger ? console : undefined,
					pickers,
					solutionStore,
				});
				//console.log('stat:', stat);
				statSum.totalCost += stat.totalCost;
				statSum.pickerCost += stat.pickerCost;
				statSum.qualityScore += stat.qualityScore;
				Object.keys(stat.measures).forEach(key => statSum.measures[key] += stat.measures[key]);
				++n_stat;

				if (n_stat % 100 === 0)
					reportStat();

				console.log("measures:", `(${stat.measures.cached})${stat.measures.simple}->${stat.measures.solved}->${stat.measures.issue}->${stat.measures.fatal}/${spartito.measures.length}`, "quality:", spartito.qualityScore);

				fs.writeFileSync(targetPath, JSON.stringify(spartito));
			}
		}
	}

	reportStat();
	console.log("Done.");
};


main();
