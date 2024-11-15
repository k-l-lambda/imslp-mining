
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


// left close, right open
const idRange2Filter = (ids: string): (n: number) => boolean => {
	if (ids.includes(",")) {
		const idList = ids.split(",").map(x => x ? parseInt(x) : null) as any;
		return id => idList.includes(id);
	}

	const [begin, end] = parseIdRangeStr(ids);
	if (end !== undefined)
		return id => id >= begin && (!end || id < end);

	return id => id === begin;
};


// close interval
const pageRange2Filter = (range: string): (n: number) => boolean => {
	const [begin, end] = parseIdRangeStr(range);
	if (end !== undefined)
		return id => id >= begin && (!end || id <= end);

	return id => id === begin;
};


// @ts-ignore
Date.prototype.format = function (fmt: string): string {
	var o = {
		"M+": this.getMonth() + 1,
		"d+": this.getDate(),
		"h+": this.getHours(),
		"m+": this.getMinutes(),
		"s+": this.getSeconds(),
		"q+": Math.floor((this.getMonth() + 3) / 3),	// Quarter
		S: this.getMilliseconds(),
	};
	if (/(y+)/.test(fmt)) fmt = fmt.replace(RegExp.$1, (this.getFullYear() + "").substr(4 - RegExp.$1.length));
	for (var k in o) {
		if (new RegExp("(" + k + ")").test(fmt))
			fmt = fmt.replace(RegExp.$1, (RegExp.$1.length === 1) ? (o[k]) : (("00" + o[k]).substr(("" + o[k]).length)));
	}
	return fmt;
};



export {
	ensureDir,
	loadImage,
	saveImage,
	parseIdRangeStr,
	idRange2Filter,
	pageRange2Filter,
};
