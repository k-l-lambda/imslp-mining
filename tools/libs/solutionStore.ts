
import lmdb from 'lmdb';
import fetch from "isomorphic-fetch";

import { starry, AdminSolutionStore } from './omr';
import { SOLUTION_STORE_OPTIONS } from "./constants";



const db = SOLUTION_STORE_OPTIONS?.local && lmdb.open({
	path: SOLUTION_STORE_OPTIONS.local,
	// any options go here, we can turn on compression like this:
	compression: true,
});


const solutionStore = db ? {
	async get(key: string) {
		return db.get(key) as starry.RegulationSolution;
	},
	async set(key: string, val: starry.RegulationSolution) {
		db.put(key, val);

		//console.debug('solution set:', key, val);
	},
	batchGet: (keys: string[]) => {
		return db.getMany(keys);
	},
} : new AdminSolutionStore({...SOLUTION_STORE_OPTIONS, fetch});	// if no local file configured, use remote store



export default solutionStore;
