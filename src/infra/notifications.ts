import type { Prisma, PrismaClient } from "@prisma/client";

export type NotificationStatus = "queued" | "sent" | "failed";

export interface NotificationRecord {
  userId: string;
  kind: string;
  text: string;
  status: NotificationStatus;
  slotId?: string | undefined;
  bookingId?: string | undefined;
  error?: string | undefined;
}

/** Запись исходящего уведомления в журнал. Журнал — единственный источник правды для демо. */
export async function recordNotification(
  prisma: PrismaClient,
  record: NotificationRecord,
  keyboard?: unknown,
): Promise<string> {
  const row = await prisma.notificationLog.create({
    data: {
      userId: record.userId,
      kind: record.kind,
      text: record.text,
      status: record.status,
      slotId: record.slotId ?? null,
      bookingId: record.bookingId ?? null,
      error: record.error ?? null,
      sentAt: record.status === "sent" ? new Date() : null,
      ...(keyboard === undefined
        ? {}
        : { keyboard: JSON.parse(JSON.stringify(keyboard)) as Prisma.InputJsonValue }),
    },
  });
  return row.id;
}

export async function listNotifications(prisma: PrismaClient, userId: string, since: Date) {
  return prisma.notificationLog.findMany({
    where: { userId, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
  });
}
