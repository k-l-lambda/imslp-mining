
import path from "path";



export const DATA_DIR = "./data";

export const IMSLP_FILES_DIR = process.env.IMSLP_FILES_DIR;


export const IMAGE_BED = path.resolve(process.env.IMAGE_BED);

export const TORCH_DEVICE = process.env.TORCH_DEVICE;

export const PROCESS_PREDICTOR_DIR = process.env.PROCESS_PREDICTOR_DIR;
export const PROCESS_PREDICTOR_CMD = process.env.PROCESS_PREDICTOR_CMD;

export const SCORE_FILTER_CONDITION = process.env.SCORE_FILTER_CONDITION as ("single_piano"|"1or2pianos");


export const VIEWPORT_UNIT = 8;


export const GAUGE_VISION_SPEC = {
	viewportHeight: 256,
	viewportUnit: 8,
};

export const SEMANTIC_VISION_SPEC = {
	viewportHeight: 192,
	viewportUnit: 8,
};

export const STAFF_PADDING_LEFT = 32;


export const BEAD_PICKER_URL = process.env.BEAD_PICKER_URL;
