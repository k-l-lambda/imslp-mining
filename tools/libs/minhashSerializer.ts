
const stringify = hash => {
	const arr = new Uint32Array(hash.hashvalues);
	const buffer = Buffer.from(arr.buffer);

	return buffer.toString("base64");
};


const parse = (base64: string, seed = 257) => {
	const buffer = Buffer.from(base64, "base64");
	const arr = new Uint32Array(buffer.buffer);

	return {
		hashvalues: arr,
		seed,
	};
};



export {
	stringify,
	parse,
};
