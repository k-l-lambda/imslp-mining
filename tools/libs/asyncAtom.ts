
const atoms = new Map();


const get = <T>(key: any, create: () => Promise<T>): Promise<T> => {
	if (atoms.has(key))
		return atoms.get(key);

	const promise = create();

	atoms.set(key, promise);

	promise
		.then(result => (atoms.delete(key), result))
		.catch(() => atoms.delete(key));

	return promise;
};


const queue = <T>(key: any, create: () => Promise<T>): Promise<T> => {
	const last = atoms.get(key);
	const prev = (!last || last.done) ? Promise.resolve() : last;

	const promise = prev.then(create);

	atoms.set(key, promise);

	promise
		.then(result => ((promise.done = true), result))
		.catch(() => promise.done = true);

	return promise;
};



export {
	get,
	queue,
};
