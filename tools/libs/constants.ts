
import path from "path";



export const DATA_DIR = "./data";

export const IMSLP_FILES_DIR = process.env.IMSLP_FILES_DIR;


export const IMAGE_BED = path.resolve(process.env.IMAGE_BED);

export const TORCH_DEVICE = process.env.TORCH_DEVICE;

export const PROCESS_PREDICTOR_DIR = process.env.PROCESS_PREDICTOR_DIR;
export const PROCESS_PREDICTOR_CMD = process.env.PROCESS_PREDICTOR_CMD;

export const SCORE_FILTER_CONDITION = process.env.SCORE_FILTER_CONDITION as ("single_piano"|"1or2pianos");


export const VIEWPORT_UNIT = 8;
