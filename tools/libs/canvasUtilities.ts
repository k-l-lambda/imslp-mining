
import { Canvas, CanvasImageSource } from "skia-canvas";

import { starry } from "./omr";



// transform page source image by source matrix
const shootPageCanvas = ({ page, source }: {
	page: starry.Page;
	source: CanvasImageSource;
}): Canvas => {
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

	return correctCanvas;
};



export {
	shootPageCanvas,
};
