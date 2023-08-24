
import fetch from 'isomorphic-fetch';

import "../env";

import { SOLUTION_STORE_OPTIONS } from "./libs/constants";
import { AdminSolutionStore, regulateWithBeadSolver } from "./libs/omr";



//console.log(AdminSolutionStore, regulateWithBeadSolver);
const store = new AdminSolutionStore({...SOLUTION_STORE_OPTIONS, fetch});

const main = async () => {
	const solution = await store.get("c891c1b7f05afaa9654f88a8e1baf1d176e6e83a");
	console.log("solution:", solution);
};

main();
