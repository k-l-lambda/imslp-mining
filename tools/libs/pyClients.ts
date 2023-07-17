
import * as config from "./config";
import { PyClients } from "./omr";



const pyClients = new PyClients(
	config.pyclients,
	{
		info: (data) => {
			console.log("PyClients info:", data);
		},
		error: (err) => {
			console.log("PyClients error:", err);
		},
	}
);



export default pyClients;
