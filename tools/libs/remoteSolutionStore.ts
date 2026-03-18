
import lmdb from 'lmdb';
import fetch from "isomorphic-fetch";

import { starry } from './omr';
import { SOLUTION_STORE_OPTIONS } from "./constants";



const OMR_BASE = process.env.OMR_BASE || "http://localhost:3080";

const db = SOLUTION_STORE_OPTIONS?.local && lmdb.open({
	path: SOLUTION_STORE_OPTIONS.local,
	compression: true,
});


const fetchRemote = async (path: string, body: any): Promise<any> => {
	try {
		const resp = await fetch(`${OMR_BASE}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!resp.ok)
			return null;
		const text = await resp.text();
		if (text.startsWith("<"))
			return null; // HTML (SPA fallback), not JSON
		return JSON.parse(text);
	}
	catch {
		return null;
	}
};


const remoteSolutionStore = {
	async get(key: string): Promise<starry.RegulationSolution> {
		// Try local LMDB first
		if (db) {
			const local = db.get(key) as starry.RegulationSolution;
			if (local)
				return local;
		}

		// Fallback to remote
		const result = await fetchRemote("/solutions/batchGet", { nameList: [key] });
		if (result?.code === 0 && result.data?.[0])
			return result.data[0];

		return undefined as any;
	},

	async set(key: string, val: starry.RegulationSolution): Promise<void> {
		// Write to local LMDB
		if (db)
			db.put(key, val);

		// Write to remote (best-effort)
		await fetchRemote("/solutions/set", { name: key, value: val });
	},

	async batchGet(keys: string[]): Promise<starry.RegulationSolution[]> {
		// Try local LMDB first
		if (db) {
			const locals = db.getMany(keys);
			const allFound = locals.every(v => v !== undefined);
			if (allFound)
				return locals as starry.RegulationSolution[];

			// Some missing locally, try remote and merge
			const result = await fetchRemote("/solutions/batchGet", { nameList: keys });
			if (result?.code === 0 && result.data) {
				return keys.map((key, i) => {
					const local = locals[i] as starry.RegulationSolution;
					if (local)
						return local;
					return result.data[i];
				});
			}

			return locals as starry.RegulationSolution[];
		}

		// No local DB, fetch all from remote
		const result = await fetchRemote("/solutions/batchGet", { nameList: keys });
		if (result?.code === 0 && result.data)
			return result.data;

		return keys.map(() => undefined as any);
	},
};


export default remoteSolutionStore;
