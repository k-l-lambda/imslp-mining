
import fs from "fs";
import path from "path";

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



export {
	ensureDir,
	loadImage,
};
