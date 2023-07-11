
import { PrismaClient } from '@prisma/client';

import "../env";



const prisma = new PrismaClient();
global.prisma = prisma;


setTimeout(() => {}, 1e+9);
