-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "panelCode" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "apiSecretEncrypted" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "callbackUrl" TEXT,
    "depositApiUrl" TEXT,
    "depositApiKey" TEXT,
    "depositApiSecretEncrypted" TEXT,
    "allowedIps" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" DATETIME,
    "lastLoginIp" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QrisAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "merchantName" TEXT NOT NULL,
    "sessionTokenEncrypted" TEXT,
    "cookiesEncrypted" TEXT,
    "deviceId" TEXT,
    "dailyLimit" INTEGER NOT NULL DEFAULT 30000000,
    "usedToday" INTEGER NOT NULL DEFAULT 0,
    "lastResetAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAssignedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "healthStatus" TEXT NOT NULL DEFAULT 'healthy',
    "status" TEXT NOT NULL DEFAULT 'active',
    "qrisPayload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "qrId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userIdExt" TEXT NOT NULL,
    "externalReference" TEXT,
    "qrisAccountId" TEXT NOT NULL,
    "requestedAmount" INTEGER NOT NULL,
    "uniqueCode" INTEGER NOT NULL,
    "finalAmount" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "qrPayload" TEXT NOT NULL,
    "qrImageBase64" TEXT NOT NULL,
    "statusPay" TEXT NOT NULL DEFAULT 'open',
    "statusBot" TEXT NOT NULL DEFAULT 'pending',
    "paidAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "issuerName" TEXT,
    "rrn" TEXT,
    "feeAmount" INTEGER NOT NULL DEFAULT 0,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Transaction_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transaction_qrisAccountId_fkey" FOREIGN KEY ("qrisAccountId") REFERENCES "QrisAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AmountLock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "qrisAccountId" TEXT NOT NULL,
    "requestedAmount" INTEGER NOT NULL,
    "uniqueCode" INTEGER NOT NULL,
    "finalAmount" INTEGER NOT NULL,
    "activeKey" TEXT,
    "transactionId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AmountLock_qrisAccountId_fkey" FOREIGN KEY ("qrisAccountId") REFERENCES "QrisAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AmountLock_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Mutation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "qrisAccountId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'credit',
    "balanceBefore" INTEGER NOT NULL DEFAULT 0,
    "balanceAfter" INTEGER NOT NULL DEFAULT 0,
    "issuerName" TEXT,
    "rrn" TEXT,
    "transactionTime" DATETIME NOT NULL,
    "rawHash" TEXT NOT NULL,
    "rawDataJson" TEXT NOT NULL,
    "matchedTransactionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Mutation_qrisAccountId_fkey" FOREIGN KEY ("qrisAccountId") REFERENCES "QrisAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Mutation_matchedTransactionId_fkey" FOREIGN KEY ("matchedTransactionId") REFERENCES "Transaction" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DepositAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transactionId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestPayloadJson" TEXT NOT NULL,
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "nextRetryAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DepositAttempt_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SettlementRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromWallet" TEXT NOT NULL,
    "toWallet" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "qrisAccountId" TEXT,
    "bankCode" TEXT,
    "bankAccount" TEXT,
    "bankName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "referenceNo" TEXT,
    "note" TEXT,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SettlementItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "settlementRequestId" TEXT NOT NULL,
    "transactionId" TEXT,
    "amount" INTEGER NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SettlementItem_settlementRequestId_fkey" FOREIGN KEY ("settlementRequestId") REFERENCES "SettlementRequest" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoginLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "username" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "detailJson" TEXT,
    "ipAddress" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RequestNonce" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RequestNonce_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_panelCode_key" ON "Client"("panelCode");

-- CreateIndex
CREATE UNIQUE INDEX "Client_apiKey_key" ON "Client"("apiKey");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_name_key" ON "Permission"("name");

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_userId_roleId_key" ON "UserRole"("userId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_roleId_permissionId_key" ON "RolePermission"("roleId", "permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "QrisAccount_code_key" ON "QrisAccount"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_qrId_key" ON "Transaction"("qrId");

-- CreateIndex
CREATE UNIQUE INDEX "AmountLock_transactionId_key" ON "AmountLock"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "AmountLock_activeKey_key" ON "AmountLock"("activeKey");

-- CreateIndex
CREATE INDEX "AmountLock_qrisAccountId_status_idx" ON "AmountLock"("qrisAccountId", "status");

-- CreateIndex
CREATE INDEX "AmountLock_expiresAt_idx" ON "AmountLock"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Mutation_rawHash_key" ON "Mutation"("rawHash");

-- CreateIndex
CREATE INDEX "Mutation_qrisAccountId_matchedTransactionId_idx" ON "Mutation"("qrisAccountId", "matchedTransactionId");

-- CreateIndex
CREATE INDEX "DepositAttempt_transactionId_idx" ON "DepositAttempt"("transactionId");

-- CreateIndex
CREATE INDEX "LoginLog_createdAt_idx" ON "LoginLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "RequestNonce_expiresAt_idx" ON "RequestNonce"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RequestNonce_apiKey_nonce_key" ON "RequestNonce"("apiKey", "nonce");
