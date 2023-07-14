
import path from "path";

import "../env";
import ProcessPredictor from "./libs/processPredictor";



const IMAGE_BED = path.resolve(process.env.IMAGE_BED!);

const TORCH_DEVICE = process.env.TORCH_DEVICE!;

const PROCESS_PREDICTOR_DIR = process.env.PROCESS_PREDICTOR_DIR!;
const PROCESS_PREDICTOR_CMD = process.env.PROCESS_PREDICTOR_CMD;

const SCORE_LAYOUT_WEIGHT = process.env.SCORE_LAYOUT_WEIGHT;


const main = async () => {
	const predictor = new ProcessPredictor({
		command: PROCESS_PREDICTOR_CMD,
		cwd: PROCESS_PREDICTOR_DIR,
		args: ["./streamPredictor.py", SCORE_LAYOUT_WEIGHT, "-m", "scorePage", "-dv", TORCH_DEVICE],
	});

	const result = await predictor.predict([], { pdf: "test.pdf", output_folder: IMAGE_BED });
	console.log("result:", result);
};


main();
