
import fs from "fs";
import path from "path";
import md5 from "spark-md5";

import { IMAGE_BED } from "./constants";



const ensureDir = (dir: string): void => {
	if (!fs.existsSync(dir))
		fs.mkdirSync(dir);
};


const loadImage = (url: string): Promise<Buffer> => {
	const [_, proto, url_body] = url.match(/^(\w+):(.*)/) || [];
	switch (proto) {
	case "md5": {
		const localPath = path.join(IMAGE_BED, url_body);
		return fs.promises.readFile(localPath);
	}

	default:
		return fs.promises.readFile(url);
	}
};


const saveImage = async (data: Buffer, ext: string): Promise<string> => {
	const hash = md5.ArrayBuffer.hash(data);
	const filename = `${hash}.${ext}`;
	await fs.promises.writeFile(path.join(IMAGE_BED, filename), data);

	return `md5:${filename}`;
};


const parseIdRangeStr = (ids: string): [number, number?] => ids.split("-").map(x => x ? parseInt(x) : null) as any;



export {
	ensureDir,
	loadImage,
	saveImage,
	parseIdRangeStr,
};
