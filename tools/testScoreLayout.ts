
import "../env";

import { IMAGE_BED, TORCH_DEVICE, PROCESS_PREDICTOR_DIR, PROCESS_PREDICTOR_CMD } from "./libs/constants";
import ProcessPredictor from "./libs/processPredictor";



const SCORE_LAYOUT_WEIGHT = process.env.SCORE_LAYOUT_WEIGHT;


const main = async (sourceFile) => {
	console.log("sourceFile:", sourceFile);
	const predictor = new ProcessPredictor({
		command: PROCESS_PREDICTOR_CMD,
		cwd: PROCESS_PREDICTOR_DIR,
		args: ["./streamPredictor.py", SCORE_LAYOUT_WEIGHT, "-m", "scorePage", "-dv", TORCH_DEVICE, "-i"],
	});

	const result = await predictor.predict([], { pdf: sourceFile, output_folder: IMAGE_BED });
	console.log("result:", result);

	//predictor.dispose();
};


main(process.argv[2]);
