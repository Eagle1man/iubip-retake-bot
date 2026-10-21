import { PrismaClient } from "@prisma/client";

let client: PrismaClient | undefined;

/** Единственный клиент на процесс. Тесты могут переопределить через setPrisma. */
export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({ log: ["warn", "error"] });
  }
  return client;
}

export function setPrisma(instance: PrismaClient | undefined): void {
  client = instance;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
