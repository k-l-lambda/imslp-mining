
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


interface OCRArea {
	score: number;
	text: string;
	feature_dict: Record<string, number>;
	cx: number;
	cy: number;
	width: number;
	height: number;
	theta: number;
	title: string;
};


type PageLayoutResult = omr.LayoutResult & {
	image: string;
	page_info: {
		url: string;
		size: [number, number];
	};
	text: OCRArea[];
}



export {
	FileInfo,
	WorkBasic,
	PageLayoutResult,
};
