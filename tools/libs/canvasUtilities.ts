
import { Canvas, CanvasImageSource } from "skia-canvas";
import * as skc from "skia-canvas";

import { starry } from "./omr";
//import { saveImage } from "./utils";



// transform page source image by source matrix
const shootPageCanvas = async ({ page, source }: {
	page: starry.Page;
	source: CanvasImageSource;
}): Promise<Canvas> => {
	if (!page?.layout)
		return null;

	const correctCanvas = new Canvas(source.width, source.height);
	const ctx = correctCanvas.getContext("2d");

	ctx.save();

	const { width, height } = correctCanvas;
	const [a, b, c, d] = page.source.matrix;

	ctx.setTransform(
		a, b, c, d,
		(-1 / 2) * width + (1 / 2) * a * width + (1 / 2) * b * height,
		(-1 / 2) * height + (1 / 2) * c * width + (1 / 2) * d * height,
	);

	ctx.drawImage(source, 0, 0);

	ctx.restore();

	const areas = page.layout.areas.filter(area => area?.staves?.middleRhos?.length);
	console.assert(page.systems.length === areas.length, "area system number mismatch:", page.systems.length, areas.length);

	await Promise.all(page.systems.map(async (system, i) => {
		const area = areas[i];

		const data = ctx.getImageData(area.x, area.y, area.width, area.height);

		const areaCanvas = new Canvas(area.width, area.height);
		const context = areaCanvas.getContext("2d");
		context.putImageData(data, 0, 0);

		const imageBuffer = areaCanvas.toBufferSync("png");
		//const imgURL = await saveImage(imageBuffer, "png");
		//console.log("imgURL:", imgURL);

		system.backgroundImage = imageBuffer as any;
	}));

	return correctCanvas;
};


const shootStaffCanvas = async (system: starry.System, staffIndex: number, { paddingLeft = 0, scaling = 1, spec }: {
		paddingLeft?: number;
		scaling?: number;
		spec: { viewportHeight: number; viewportUnit: number };
	}
): Promise<Canvas> => {
	if (!system || !system.backgroundImage) {
		console.warn("[shootStaffCanvas] no system.backgroundImage:", system.backgroundImage);
		return null;
	}

	const staff = system.staves[staffIndex];
	if (!staff) {
		console.warn("[shootStaffCanvas] no staff:", staff, staffIndex, system.staves.length);
		return null;
	}

	const middleUnits = spec.viewportHeight / spec.viewportUnit / 2;

	const width = system.imagePosition.width * spec.viewportUnit;
	const height = system.imagePosition.height * spec.viewportUnit;
	const x = system.imagePosition.x * spec.viewportUnit + paddingLeft;
	const y = (system.imagePosition.y - (staff.top + staff.staffY - middleUnits)) * spec.viewportUnit;

	const canvas = new Canvas(Math.round(width + x) * scaling, spec.viewportHeight * scaling);
	const context = canvas.getContext("2d");
	context.fillStyle = "white";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.drawImage(await skc.loadImage(system.backgroundImage), x * scaling, y * scaling, width * scaling, height * scaling);

	return canvas;
};



export {
	shootPageCanvas,
	shootStaffCanvas,
};
