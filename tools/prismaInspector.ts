
import "../env";
import prisma from "./libs/prismaClient";



//(global as any).$query = prisma.$queryRaw;
(global as any).prisma = prisma;


setTimeout(() => {}, 1e+9);
