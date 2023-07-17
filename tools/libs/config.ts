
import fs from "fs";
import YAML from "yaml";



const {pyclients} = YAML.parse(fs.readFileSync("./config.local.yaml").toString());

console.assert(pyclients, "Invalid config, pyclients is required");



export {
	pyclients,
};
