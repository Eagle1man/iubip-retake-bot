import type { PrismaClient } from "@prisma/client";

export interface SeedBase {
  disciplineId: string;
  teacherId: string;
  slotId: string;
  openSlotId: string;
  token: string;
}

/** Базовый набор: дисциплина, преподаватель, открытая сессия + глубокая ссылка. */
export async function seedBase(prisma: PrismaClient): Promise<SeedBase> {
  const discipline = await prisma.discipline.upsert({
    where: { name: "Математический анализ" },
    update: {},
    create: { name: "Математический анализ" },
  });

  const teacher = await prisma.teacher.upsert({
    where: { userId: "2001" },
    update: {},
    create: { userId: "2001", fio: "Иванова Ольга Петровна" },
  });

  const startsAt = new Date(Date.now() + 7 * 86_400_000);
  const slot = await prisma.examSlot.create({
    data: {
      disciplineId: discipline.id,
      teacherId: teacher.id,
      startsAt,
      room: "А-204",
      expectedCapacity: 30,
      alertThreshold: 30,
      registrationDeadline: new Date(Date.now() + 5 * 86_400_000),
      status: "open",
    },
  });

  return {
    disciplineId: discipline.id,
    teacherId: teacher.id,
    slotId: slot.id,
    openSlotId: slot.id,
    token: `rt_${discipline.id}_${slot.id}`,
  };
}

/** Сессия с уже прошедшим дедлайном регистрации (§13.7 → 410). */
export async function seedClosedSlot(prisma: PrismaClient, base: SeedBase): Promise<string> {
  const slot = await prisma.examSlot.create({
    data: {
      disciplineId: base.disciplineId,
      teacherId: base.teacherId,
      startsAt: new Date(Date.now() + 86_400_000),
      room: "Б-101",
      registrationDeadline: new Date(Date.now() - 3_600_000),
      status: "open",
    },
  });
  return slot.id;
}

export async function seedRoles(prisma: PrismaClient): Promise<void> {
  await prisma.staffRole.upsert({
    where: { userId: "2001" },
    update: {},
    create: { userId: "2001", role: "teacher", teacherId: null },
  });
  await prisma.staffRole.upsert({
    where: { userId: "3001" },
    update: {},
    create: { userId: "3001", role: "directorate" },
  });
}

/** Запись в слот — для проверок списков и уведомлений. */
export async function seedBooking(
  prisma: PrismaClient,
  slot: { id: string; disciplineId: string; teacherId: string },
  student: { userId: string; fio: string; group: string },
) {
  return prisma.booking.create({
    data: {
      slotId: slot.id,
      disciplineId: slot.disciplineId,
      teacherId: slot.teacherId,
      studentUserId: student.userId,
      studentFio: student.fio,
      studentGroup: student.group,
      amount: 500,
      paymentToken: `pay_${student.userId}_${slot.id}`,
    },
  });
}
