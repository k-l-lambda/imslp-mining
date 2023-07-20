
import fs from "fs";
import * as skc from "skia-canvas";
import sharp from "sharp";

import "../env";
import { shootPageCanvas } from "./libs/canvasUtilities";
import { starry } from "./libs/omr";
import { loadImage } from "./libs/utils";



const main = async () => {
	const scoreJSON = fs.readFileSync("./data/2/368031/score.json").toString();
	const score = starry.recoverJSON<starry.Score>(scoreJSON, starry);

	const page = score.pages[2];

	const buffer = await loadImage(page.source.url);
	fs.writeFileSync("./test/page-source.webp", buffer);
	const pngBuffer = await sharp(buffer).toFormat("png").toBuffer();
	const image = await skc.loadImage(pngBuffer);

	const canvas = shootPageCanvas({ page, source: image });
	const outputBuffer = canvas.toBufferSync("png");
	fs.writeFileSync("./test/page-canvas.png", outputBuffer);

	console.log("Done.");
};


main();
