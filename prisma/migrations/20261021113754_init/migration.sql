-- CreateTable
CREATE TABLE "Discipline" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Discipline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Teacher" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fio" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Teacher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamSlot" (
    "id" TEXT NOT NULL,
    "disciplineId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "room" TEXT NOT NULL,
    "expectedCapacity" INTEGER NOT NULL DEFAULT 30,
    "alertThreshold" INTEGER NOT NULL DEFAULT 30,
    "registrationDeadline" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "disciplineId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "studentUserId" TEXT,
    "seq" SERIAL NOT NULL,
    "studentFio" TEXT NOT NULL,
    "studentGroup" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 500,
    "paymentToken" TEXT,
    "receiptSha256" TEXT,
    "receiptPath" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "attendance" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotSession" (
    "userId" TEXT NOT NULL,
    "role" TEXT,
    "state" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotSession_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "StaffRole" (
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "teacherId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffRole_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slotId" TEXT,
    "bookingId" TEXT,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "keyboard" JSONB,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistryImport" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "rowsTotal" INTEGER NOT NULL,
    "rowsMatched" INTEGER NOT NULL,
    "rowsUnmatched" INTEGER NOT NULL,
    "unmatchedFios" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistryRow" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "payerFio" TEXT NOT NULL,
    "payerFioNorm" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3),
    "purpose" TEXT,
    "matchedBookingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Discipline_name_key" ON "Discipline"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Discipline_code_key" ON "Discipline"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Teacher_userId_key" ON "Teacher"("userId");

-- CreateIndex
CREATE INDEX "ExamSlot_disciplineId_status_idx" ON "ExamSlot"("disciplineId", "status");

-- CreateIndex
CREATE INDEX "ExamSlot_teacherId_status_idx" ON "ExamSlot"("teacherId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_seq_key" ON "Booking"("seq");

-- CreateIndex
CREATE INDEX "Booking_slotId_status_idx" ON "Booking"("slotId", "status");

-- CreateIndex
CREATE INDEX "Booking_disciplineId_status_idx" ON "Booking"("disciplineId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_paymentToken_slotId_key" ON "Booking"("paymentToken", "slotId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_receiptSha256_slotId_key" ON "Booking"("receiptSha256", "slotId");

-- CreateIndex
CREATE INDEX "NotificationLog_userId_createdAt_idx" ON "NotificationLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_status_createdAt_idx" ON "NotificationLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RegistryRow_payerFioNorm_idx" ON "RegistryRow"("payerFioNorm");

-- AddForeignKey
ALTER TABLE "ExamSlot" ADD CONSTRAINT "ExamSlot_disciplineId_fkey" FOREIGN KEY ("disciplineId") REFERENCES "Discipline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamSlot" ADD CONSTRAINT "ExamSlot_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "ExamSlot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_disciplineId_fkey" FOREIGN KEY ("disciplineId") REFERENCES "Discipline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryRow" ADD CONSTRAINT "RegistryRow_importId_fkey" FOREIGN KEY ("importId") REFERENCES "RegistryImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Защита от второй активной записи на дисциплину (§13.8). Prisma не умеет частичные индексы.
CREATE UNIQUE INDEX "booking_active_one_per_discipline"
    ON "Booking" ("disciplineId", lower("studentFio"))
    WHERE "status" IN ('submitted', 'paid');
