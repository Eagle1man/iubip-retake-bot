import type { PrismaClient } from "@prisma/client";

export type Role = "student" | "teacher" | "directorate";

/**
 * Роль определяется по StaffRole. Студент — это отсутствие роли (§14 ТЗ):
 * отдельная запись студенту не нужна.
 */
export class RoleService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly directorateChatId: string,
  ) {}

  async resolve(userId: string): Promise<Role> {
    if (userId === this.directorateChatId) return "directorate";

    const row = await this.prisma.staffRole.findUnique({ where: { userId } });
    if (row?.role === "teacher") return "teacher";
    if (row?.role === "directorate") return "directorate";
    return "student";
  }

  async findTeacherByUserId(userId: string) {
    return this.prisma.teacher.findUnique({ where: { userId } });
  }
}

export function bookingNumber(seq: number): string {
  return `B-${seq}`;
}

/** Поиск записи по номеру вида B-3. */
export async function findByNumber(prisma: PrismaClient, number: string) {
  const seq = Number.parseInt(number.replace(/^[БB]-/i, ""), 10);
  if (!Number.isFinite(seq)) return null;
  return prisma.booking.findFirst({ where: { seq }, include: { slot: true } });
}
