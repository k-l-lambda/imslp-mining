
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
			//console.log("omrState:", omrState);

			for (const item of omrState.spartito) {
				const spartitoPath = path.join(work, file.id, `${item.id}.spartito.json`);
				if (!fs.existsSync(spartitoPath))
					continue;

				const content = fs.readFileSync(spartitoPath).toString();
				const spartito = starry.recoverJSON<starry.Spartito>(content, starry);

				const dummyScore = {
					assemble () {},
					makeSpartito () {return spartito},
					assignBackgroundForMeasure (_: starry.SpartitoMeasure) {},
				} as starry.Score;

				const stat = await regulateWithBeadSolver(dummyScore, {
					logger: console,
					pickers,
					solutionStore,
				});
				console.log('stat:', stat);

				const targetName = omrState.spartito.length > 1 ? `${workId}-${file.id}-${item.id}.spartito.json` : `${workId}-${file.id}.spartito.json`;
				fs.writeFileSync(path.join(targetDir, targetName), JSON.stringify(spartito));
			}
			break;
		}
		break;
	}
};


main();
