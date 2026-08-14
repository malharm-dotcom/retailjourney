-- CreateTable
CREATE TABLE "UserAccessAudit" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "targetEmail" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "diff" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserAccessAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserAccessAudit_targetUserId_createdAt_idx" ON "UserAccessAudit"("targetUserId", "createdAt");

-- CreateIndex
CREATE INDEX "UserAccessAudit_createdAt_idx" ON "UserAccessAudit"("createdAt");
