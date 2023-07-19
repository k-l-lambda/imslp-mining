
import * as omr from "./omr";


interface FileInfo {
	id: string;
	tab: string;
	tabText: string;
	rating: number;
	rateBy: number;
	group: number;
	title: string;
	path: string;
	ext: string;
};


interface WorkBasic {
	id: number;
	title: string;
	author: string;
	url: string;
	meta: Record<string, string>;
	categories: string[];
	files: FileInfo[];
};


/*interface OCRArea {
	score: number;
	text: string;
	feature_dict: Record<string, number>;
	cx: number;
	cy: number;
	width: number;
	height: number;
	theta: number;
	title: string;
};*/


interface StaffImage {
	hash: string;
	position: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
};


type LayoutArea = omr.starry.Area & {
	staff_images: StaffImage[];
};

type PageLayoutResult = omr.LayoutResult & {
	detection: {areas: LayoutArea[]};
	image: string;
	page_info: {
		url: string;
		size: [number, number];
	};
	text?: omr.starry.TextArea[];
}



export {
	FileInfo,
	WorkBasic,
	LayoutArea,
	PageLayoutResult,
};
