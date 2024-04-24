
import lmdb from 'lmdb';

import { starry } from './omr';



const db = lmdb.open({
	path: 'cache.local',
	// any options go here, we can turn on compression like this:
	compression: true,
});


const solutionStore = {
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
};


export default solutionStore;
