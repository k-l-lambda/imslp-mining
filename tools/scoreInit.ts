
import fs from "fs";
import path from "path";
import YAML from "yaml";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../env";

import { WorkBasic, PageLayoutResult, LayoutArea } from "./libs/types";
import { DATA_DIR, SCORE_FILTER_CONDITION, VIEWPORT_UNIT } from "./libs/constants";
import walkDir from "./libs/walkDir";
import { idRange2Filter } from "./libs/utils";
import { starry } from "./libs/omr";



const argv = yargs(hideBin(process.argv))
	.command(
		"$0 [options]",
		"Run OCR on layouts",
		yargs => yargs
			.option("ids", { alias: "i", type: "string" })
		,
	).help().argv;


const SYSTEM_MARGIN = 4;


interface SystemInitOptions {
	page: starry.Page;
	backgroundImage?: string;
	area: LayoutArea;
	position: {x: number, y: number};
};


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


const main = async () => {
	let works = walkDir(DATA_DIR, /\/$/);
	works.sort((d1, d2) => Number(path.basename(d1)) - Number(path.basename(d2)));

	if (argv.ids) {
		const goodId = idRange2Filter(argv.ids);
		works = works.filter(work => goodId(Number(path.basename(work))));
	}

	let n_score = 0;

	for (const work of works) {
		const workId = path.basename(work);

		const basic = YAML.parse(fs.readFileSync(path.join(work, "basic.yaml")).toString()) as WorkBasic;
		console.log(basic.id, basic.title);

		const files = basic.files.filter(file => file.ext === "pdf");
		for (const file of files) {
			const layoutPath = path.join(work, file.id, "layout.json");
			if (!fs.existsSync(layoutPath))
				continue;

			const layout = JSON.parse(fs.readFileSync(layoutPath).toString()) as PageLayoutResult[];
			if (!layout?.length)
				continue;

			const layoutPages = layout.filter(page => page.detection?.areas?.length);
			if (!layoutPages.length)
				continue;
	
			const staffNumbers = layout.filter(page => page.detection?.areas?.length)
				.map(page => page.detection?.areas).flat(1)
				.filter(area => area.staves?.middleRhos?.length)
				.map(area => area.staves.middleRhos.length)
				.sort((a, b) => a - b);

			const n_staff = Math.max(0, ...staffNumbers);
			const n_staff_90percent = staffNumbers[Math.floor(staffNumbers.length * 0.9)];

			switch (SCORE_FILTER_CONDITION) {
			case "single_piano":
				if (n_staff_90percent > 3)
					continue;

				break;
			case "1or2pianos":
				if (n_staff_90percent > 4)
					continue;

				break;
			}

			console.log(String.fromCodePoint(0x1f3bc), `[${workId}/${file.id}]`, file.title);

			const omrStatePath = path.join(work, file.id, "omr.yaml");
			const scorePath = path.join(work, file.id, "score.json");

			const omrState = fs.existsSync(omrStatePath) ? YAML.parse(fs.readFileSync(omrStatePath).toString()) : {};
			if (omrState?.score?.init && fs.existsSync(scorePath)) {
				console.log("Score initilization already done, skip");
				continue;
			}

			const meanWidth = layoutPages.reduce((sum, page) => sum + page.sourceSize.width, 0) / layoutPages.length;

			const pageRatios = layoutPages.map(page => {
				const staffInterval = Math.min(...page.detection.areas.filter(area => area.staves?.middleRhos?.length).map(area => area.staves.interval));
				return {
					width: page.sourceSize.width / staffInterval,
					aspect: page.sourceSize.height / page.sourceSize.width,
				};
			});

			const maxLogicWidth = pageRatios.sort((a, b) => b.width - a.width)[0].width;
			const maxAspect = Math.max(...pageRatios.map((r) => r.aspect));

			const unitSize = meanWidth / maxLogicWidth;

			// in points
			const pageSize = {
				width: meanWidth,
				height: meanWidth * maxAspect,
			};

			const pages = layoutPages.map(layout => {
				const page = new starry.Page({
					source: {
						url: layout.page_info.url,
						dimensions: {width: layout.page_info.size[0], height: layout.page_info.size[1]},
						matrix: [Math.cos(layout.theta), -Math.sin(layout.theta), Math.sin(layout.theta), Math.cos(layout.theta), 0, 0],
						interval: layout.interval,
						needGauge: true,
					},
					layout: layout.detection,
					width: pageSize.width / unitSize,
					height: pageSize.height / unitSize,
				});

				(page.layout.areas.filter(area => area.staves?.middleRhos?.length) as LayoutArea[]).forEach(area => {
					const sourceCenter = {
						x: layout.sourceSize.width / 2 / layout.interval,
						y: layout.sourceSize.height / 2 / layout.interval,
					};
	
					const position = {
						x: (area.x + area.staves.phi1) / layout.interval - sourceCenter.x + page.width / 2,
						y: area.y / layout.interval - sourceCenter.y + page.height / 2,
					};
	
					page.systems.push(constructSystem({
						page,
						area,
						position,
					}));
				});

				if (layout.text)
					page.assignTexts(layout.text, [layout.page_info.size[1], layout.page_info.size[0]]);

				return page;
			});

			const title = `${basic.title}/${file.title}`;

			const score = new starry.Score({
				title,
				//stavesCount: n_staff,
				unitSize,
				pageSize,
				headers: {
					id: `imslp-${basic.id}-${file.id}`,
					author: basic.author,
					...basic.meta,
				},
				instrumentDict: {},
				settings: {
					enabledGauge: true,
					semanticConfidenceThreshold: 1,
				},
				pages,
			});

			fs.writeFileSync(scorePath, JSON.stringify(score));

			omrState.score = {init: Date.now()};
			fs.writeFileSync(omrStatePath, YAML.stringify(omrState));

			++n_score;
			console.log("Initial score saved.");
		}
	}

	console.log("All works done,", n_score, "scores saved.");
	process.exit(0);
};


main();
