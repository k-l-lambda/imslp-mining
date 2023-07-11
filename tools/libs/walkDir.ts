
import fs from "fs";
import path from "path";



const walkDir = (dir, pattern, { recursive = false } = {}): string[] => {
	const list = fs.readdirSync(dir);
	//console.log("files:", files);

	const subdirs = [] as string[];

	const files = list.map(filename => {
		const file = path.resolve(dir, filename);
		const stat = fs.statSync(file);

		if (stat.isDirectory())
			subdirs.push(file);

		return { file, filename, stat };
	}).filter(({ filename, stat }) => (!pattern || pattern.test(filename + (stat.isDirectory() ? "/" : ""))))
		.map(({ file }) => file);

	if (recursive) {
		subdirs.forEach(subdir => {
			files.push(...walkDir(subdir, pattern, { recursive }));
		});
	}

	return files;
};



export default walkDir;
