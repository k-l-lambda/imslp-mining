
import path from "path";
import child_process from "child-process-promise";

import * as asyncAtom from "./asyncAtom";



type ChildProcess = ReturnType<typeof child_process.spawn>["childProcess"];


interface Options {
	command?: string;
	args?: string[];
	cwd: string;
	env?: {[key: string]: string};
};


const randomName = (len = 4) => Buffer.from(Math.random().toString(), "binary").toString("base64").substring(24 - len);


const timeout = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));



export default class ProcessPredictor {
	proc: ChildProcess;

	initialized: boolean = false;
	cacheResults: string[] = [];

	onResult: (results: string[]) => void;
	onInit: () => void;


	constructor (options: Options) {
		console.debug("[ProcessPredictor] startup.");

		const { command = "python", args = ["./streamPredictor.py", "--inspect"], cwd, env = undefined } = options;

		this.proc = child_process.spawn(command, args, { cwd, env }).childProcess;

		this.proc.stderr!.on("data", data => this.alive && console.log("[ProcessPredictor]:", data.toString()));

		let buffer = null as Buffer|null;
		this.proc.stdout!.on("data", (data: Buffer) => {
			if (!this.initialized) {
				this.initialized = true;
				if (this.onInit)
					this.onInit();

				console.debug("[ProcessPredictor] initialized.");
				if (data.length === 1)	// the initialization signal
					return;
			}

			//console.log("received data:", data.length, data[data.length - 1]);
			if (buffer)
				buffer = Buffer.concat([buffer, data]);
			else
				buffer = data;

			// flush when encountered '\n'
			if (buffer[buffer.length - 1] === 0xa) {
				const results = buffer.toString().split("\n")
					.map(str => str.replace(/\r$/, ""));	// for Windows
				//console.log("results got:", results.length, results.map(x => x.length));
				this.cacheResults.push(...results);

				while (true) {
					const nullPos = this.cacheResults.findIndex(x => !x);
					if (nullPos >= 0 && this.cacheResults.length - nullPos >= 2) {
						const results = this.cacheResults.splice(0, nullPos);
						while (this.cacheResults.length && !this.cacheResults[0])
							this.cacheResults.shift();
						//console.log("r-c:", results.length, this.cacheResults.length);

						if (this.onResult)
							this.onResult(results);

						continue;
					}
					else {	// remove tail null results
						while (this.cacheResults.length && !this.cacheResults[this.cacheResults.length - 1])
							this.cacheResults.pop();
					}

					break;
				}

				buffer = null;
			}
		});
	}


	dispose () {
		if (this.proc) {
			const proc = this.proc;
			// @ts-ignore
			this.proc = null;
			proc.kill();

			console.debug("[ProcessPredictor] shutdown.");
		}
	}


	get alive (): boolean {
		return !!this.proc;
	}


	waitInitialization (): Promise<void> {
		if (!this.initialized)
			return new Promise<void>(resolve => this.onInit = resolve);

		return Promise.resolve();
	}


	waitResult (): Promise<string[]> {
		return new Promise<string[]>(resolve => this.onResult = resolve);
	}


	async predict (images: string[], { debug = false, ...fields }: any = {}): Promise<string> {
		if (!this.alive)
			throw new Error("[ProcessPredictor]: predicting on a dead predictor.");

		//++this.serialNumber;
		const serial = randomName();

		const results = await asyncAtom.queue(this, () => {
			if (debug) {
				const output_path = path.resolve(process.env.APP_ROOT_PATH!, "public/predictor-temp/", `${serial}-%(i)d-%(type)s.png`);
				this.proc.stdin!.write("json:" + JSON.stringify({ output_path }) + "\n");
			}

			if (Object.keys(fields).length)
				this.proc.stdin!.write("json:" + JSON.stringify(fields) + "\n");

			images.forEach(code => {
				this.proc.stdin!.write("base64:" + code);
				this.proc.stdin!.write("\n");
			});
			this.proc.stdin!.write("\n");

			return this.waitResult();
		});

		return `{"serial":"${serial}","semantics":[${results.join(",")}]}`;
	}


	async predictJSON (args: object|string): Promise<string> {
		if (!this.alive)
			throw new Error("[ProcessPredictor]: predicting on a dead predictor.");

		const body = typeof args === "string" ? args : JSON.stringify(args);

		const results = await asyncAtom.queue(this, () => {
			this.proc.stdin!.write("json:" + body + "\n");
			this.proc.stdin!.write("\n");

			return this.waitResult();
		});

		return `[${results.join(",")}]`;
	}


	async echo (value: string = randomName(8), timeoutMs: number = 30e+3): Promise<number> {
		const t0 = Date.now();

		this.proc.stdin!.write("echo:" + value + "\n");
		this.proc.stdin!.write("\n");

		for (let i = 0; i < 5; ++i) {
			const result = await Promise.race([this.waitResult(), timeout(timeoutMs).then(() => [] as string[])]);
			if (result.includes(value)) {
				const cost = Date.now() - t0;
				console.log(`Echo passed in ${cost}ms,`, value);

				return cost;
			}
			else
				console.warn("Missed echo message:", value, result[0] && result[0].substring(0, 32));
		}

		// retry 5 times at most, then throw error
		console.warn("Echo time out:", value);
		throw new Error("Echo time out.");
	}
};
