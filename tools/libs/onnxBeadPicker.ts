
import * as ort from "onnxruntime-node";

import { starry } from "./omr";



interface BeadPickerOptions {
	sessionOptions?: ort.InferenceSession.SessionOptions;
	n_seq: number;
	usePivotX: boolean;

	onLoad?: (promise: Promise<void>) => void;
};


const FEATURE_DIMS = 16;



export default class OnnxBeadPicker {
	private session: ort.InferenceSession;
	private sessionOptions?: ort.InferenceSession.SessionOptions;

	n_seq: number;
	usePivotX: boolean;

	quota: number = 0;
	cost: number = 0;


	constructor (modelURL: string, { sessionOptions, n_seq, usePivotX, onLoad }: BeadPickerOptions) {
		this.sessionOptions = sessionOptions;
		this.n_seq = n_seq;
		this.usePivotX = usePivotX;

		const loading = this.loadModel(modelURL);

		onLoad && onLoad(loading);
	}


	async loadModel (modelURL: string): Promise<void> {
		this.session = await ort.InferenceSession.create(modelURL, this.sessionOptions);
		console.debug("OnnxBeadPicker: model loaded:", modelURL);
	}


	async predictCluster (cluster: starry.EventCluster, tip: number): Promise<number[]> {
		if (cluster.elements.length > this.n_seq)
			console.warn("OnnxBeadPicker: cluster size out of limit:", cluster.elements.length, this.n_seq);

		const t0 = Date.now();

		const type = new ort.Tensor("int8", Int8Array.from(Array(this.n_seq).fill(0).map((_, i) => i < cluster.elements.length ? cluster.elements[i].type : 0)), [1, this.n_seq]);
		const staff = new ort.Tensor("int8", Int8Array.from(Array(this.n_seq).fill(0).map((_, i) => i < cluster.elements.length ? cluster.elements[i].staff : 0)), [1, this.n_seq]);
		const beading_pos = new ort.Tensor("int16", Int16Array.from(Array(this.n_seq).fill(0).map((_, i) =>
			i < cluster.elements.length && Number.isInteger(cluster.elements[i].order) && cluster.elements[i].order! < tip ? cluster.elements[i].order! - tip : 0)), [1, this.n_seq]);
		const x = new ort.Tensor("float32", Float32Array.from(Array(this.n_seq).fill(0).map((_, i) => i < cluster.elements.length ? cluster.elements[i][this.usePivotX ? "pivotX" : "x"] as number : 0)), [1, this.n_seq]);
		const y1 = new ort.Tensor("float32", Float32Array.from(Array(this.n_seq).fill(0).map((_, i) => i < cluster.elements.length ? cluster.elements[i].y1 : 0)), [1, this.n_seq]);
		const y2 = new ort.Tensor("float32", Float32Array.from(Array(this.n_seq).fill(0).map((_, i) => i < cluster.elements.length ? cluster.elements[i].y2 : 0)), [1, this.n_seq]);
		const feature = new ort.Tensor("float32", Float32Array.from(Array(this.n_seq).fill(0).map((_, i) => i < cluster.elements.length && cluster.elements[i].feature).map((feature, i) => {
			if (!feature)
				return Array(FEATURE_DIMS).fill(0);

			const fixed = Number.isInteger(cluster.elements[i].order) && cluster.elements[i].order! < tip;

			const divisions = fixed ? Array(7).fill(0).map((_, ii) => ii === cluster.elements[i].division ? 1 : 0) : feature.divisions;
			const dots = fixed ? [cluster.elements[i].dots! > 0 ? 1 : 0, cluster.elements[i].dots! > 1 ? 1 : 0] : feature.dots;
			const tremoloCatcher = Number.isFinite(feature.tremoloCatcher) ? feature.tremoloCatcher : (cluster.elements[i].tremoloCatcher ? 1 : 0);

			return [
				...divisions,
				...dots,
				...feature.beams,
				...feature.stemDirections,
				feature.grace,
				tremoloCatcher,
			];
		}).flat(1)), [1, this.n_seq, FEATURE_DIMS]);

		const time8th = new ort.Tensor("int8", Int8Array.from([Math.min(16, Math.ceil((cluster.signatureDuration || 1920) / 240))]));

		const results = await this.session.run({ type, staff, beading_pos, x, y1, y2, feature, time8th });
		//console.log("results:", results);

		cluster.elements.forEach((elem, i) => {
			if ([starry.EventElementType.CHORD, starry.EventElementType.REST].includes(elem.type)) {
				elem.predisposition = {
					grace: (results.grace.data[i] as number) > 0.5,
					timeWarped: results.timeWarped.data[i],
					fullMeasure: results.fullMeasure.data[i],
					fake: results.fake.data[i],
					tick: results.tick.data[i],
					divisionVector: Array.from(results.division.data.slice(i * 9, (i + 1) * 9) as any),
					dotsVector: Array.from(results.dots.data.slice(i * 3, (i + 1) * 3) as any),
					beamVector: Array.from(results.beam.data.slice(i * 4, (i + 1) * 4) as any),
					stemDirectionVector: Array.from(results.stemDirection.data.slice(i * 3, (i + 1) * 3) as any),
				} as any;

				elem.predisposition!.fakeP = 1 - (1 - elem.predisposition!.fake) * (1 - (results.grace.data[i] as number)) * (1 - elem.predisposition!.fullMeasure);
			}
			else if (elem.type === starry.EventElementType.EOS) {
				elem.predisposition = {
					tick: results.tick.data[i],
				} as any;
			}
		});

		if (this.quota)
			--this.quota;

		this.cost += Date.now() - t0;

		return cluster.elements.map((elem, i) => Number.isInteger(elem.order) && elem.order! < tip ? 0 : results.successor.data[i] as number);
	}
};
