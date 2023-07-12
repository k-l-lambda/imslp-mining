
import fs from "fs";



const ensureDir = (dir: string): void => {
	if (!fs.existsSync(dir))
		fs.mkdirSync(dir);
};



export {
	ensureDir,
};
