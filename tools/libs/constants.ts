
import path from "path";



export const DATA_DIR = "./data";

export const IMSLP_FILES_DIR = process.env.IMSLP_FILES_DIR;


export const IMAGE_BED = path.resolve(process.env.IMAGE_BED);

export const SPARTITO_ROOT = process.env.SPARTITO_ROOT;

export const TORCH_DEVICE = process.env.TORCH_DEVICE;

export const PROCESS_PREDICTOR_DIR = process.env.PROCESS_PREDICTOR_DIR;
export const PROCESS_PREDICTOR_CMD = process.env.PROCESS_PREDICTOR_CMD;

export const SCORE_FILTER_CONDITION = process.env.SCORE_FILTER_CONDITION as ("single_piano"|"1or2pianos");

export const ENABLED_VISION_GAUGE = !!process.env.ENABLED_VISION_GAUGE;
export const ENABLED_VISION_MASK = !!process.env.ENABLED_VISION_MASK;


export const VIEWPORT_UNIT = 8;


export const MINHASH_BANDSIZE = process.env.MINHASH_BANDSIZE;


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


export const DATE_LOCALE = process.env.DATE_LOCALE;
export const TIMEZONE = process.env.TIMEZONE;


export const PRIMARY_CATEGORIES = {
	Baroque: "baroque",
	Classical: "classical",
	Romantic: "romantic",
	"Early 20th century": "early20th",
	Modern: "modern",
};


export const SOLUTION_STORE_OPTIONS = JSON.parse(process.env.SOLUTION_STORE ?? "null");


export const ORT_SESSION_OPTIONS = process.env.ORT_SESSION_OPTIONS ? JSON.parse(process.env.ORT_SESSION_OPTIONS) : undefined;
