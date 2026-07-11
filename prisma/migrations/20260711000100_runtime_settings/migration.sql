CREATE TABLE "RuntimeSettings" (
  "id" TEXT NOT NULL,
  "logsChannelId" TEXT,
  "trackingEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RuntimeSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PermissionRole" (
  "roleId" TEXT NOT NULL,
  "level" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PermissionRole_pkey" PRIMARY KEY ("roleId")
);
