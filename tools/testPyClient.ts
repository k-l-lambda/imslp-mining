
import {pyclients} from "./libs/config";
import { PyClients } from "./libs/omr";



const pyClients = new PyClients(
	pyclients,
	{
		info: (data) => {
			console.log("PyClients info:", data);
		},
		error: (err) => {
			console.log("PyClients error:", err);
		},
	}
);


pyClients.getClient("textLoc").then(x => console.log(x));
