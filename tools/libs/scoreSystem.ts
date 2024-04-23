
import { starry } from "./omr";
import { SystemInitOptions } from "./types";
import { VIEWPORT_UNIT } from "./constants";



const SYSTEM_MARGIN = 4;


const constructSystem = ({ page, backgroundImage, area, position }: SystemInitOptions): starry.System => {
	const detection = area.staves;

	const systemWidth = (detection.phi2 - detection.phi1) / detection.interval;
	const systemHeight = area.height / detection.interval;

	const lastSystem = page.systems[page.systems.length - 1];
	const top = position ? position.y : (lastSystem ? lastSystem.top + lastSystem.height : 0) + SYSTEM_MARGIN;
	const left = position ? position.x : SYSTEM_MARGIN;

	console.assert(area.staff_images.length === detection.middleRhos.length, "");

	const stavesTops = [
		0,
		...Array(detection.middleRhos.length - 1)
			.fill(0)
			.map((_, i) => (detection.middleRhos[i] + detection.middleRhos[i + 1]) / 2 / detection.interval),
	];

	const measureBars = [systemWidth];	// initial with no measure division

	const staves = area.staff_images.map((img, i) => {
		const staffY = detection.middleRhos[i] / detection.interval - stavesTops[i];

		return new starry.Staff({
			top: stavesTops[i],
			height: (stavesTops[i + 1] || systemHeight) - stavesTops[i],
			staffY,
			measureBars,
			backgroundImage: img.hash,
			imagePosition: {
				x: img.position.x / VIEWPORT_UNIT,
				y: img.position.y / VIEWPORT_UNIT + staffY,
				width: img.position.width / VIEWPORT_UNIT,
				height: img.position.height / VIEWPORT_UNIT,
			},
		});
	});

	const imagePosition = {
		x: -detection.phi1 / detection.interval,
		y: 0,
		width: area.width / detection.interval,
		height: area.height / detection.interval,
	};

	return new starry.System({
		staves,
		left,
		top,
		width: systemWidth,
		backgroundImage,
		imagePosition,
		measureBars,
	});
};



export {
	constructSystem,
};
