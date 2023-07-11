
import "../env";
import prisma from "./libs/prismaClient";



/*prisma.work.findMany({
	where: {
		OR: {
			pdfs: {
				startsWith: "[{",
			},
			audios: {
				startsWith: "[{",
			},
		},
	},
}).then(works => console.log(works));*/


prisma.$queryRaw`SELECT * FROM Work
WHERE pdfs like '%"savePath"%' OR audios like '%"savePath"%'
LIMIT 100
`.then(x => console.log(x));


setTimeout(() => {}, 1e+9);
