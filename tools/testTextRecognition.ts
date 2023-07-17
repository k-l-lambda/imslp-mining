
import fs from "fs";

import "../env";
import pyClients from "./libs/pyClients";



const main = async () => {
	const image = fs.readFileSync("./images/00ae3150541c904ec5de598753623576.webp");
	const resultLoc = await pyClients.predictScoreImages("textLoc", [image]);
	console.log("resultLoc:", resultLoc);

	const [resultOCR] = await pyClients.predictScoreImages("textOcr", {
		buffers: [image],
		location: resultLoc[0],
	});

	console.log("resultOCR:", resultOCR);

	process.exit();
};


main();
