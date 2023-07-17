
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


type PageLayoutResult = omr.LayoutResult & {
	image: string;
	page_info: {
		url: string;
		size: [number, number];
	};
}



export {
	FileInfo,
	WorkBasic,
	PageLayoutResult,
};
