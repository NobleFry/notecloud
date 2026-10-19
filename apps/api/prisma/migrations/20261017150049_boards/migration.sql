

-- AlterTable
ALTER TABLE `tasks` ADD COLUMN `columnId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `boards` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `description` VARCHAR(500) NULL,
    `icon` VARCHAR(32) NULL,
    `color` VARCHAR(16) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `boards_workspaceId_deletedAt_idx`(`workspaceId`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `board_columns` (
    `id` VARCHAR(191) NOT NULL,
    `boardId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `status` ENUM('TODO', 'IN_PROGRESS', 'DONE', 'CANCELED') NOT NULL DEFAULT 'TODO',
    `position` INTEGER NOT NULL DEFAULT 0,
    `color` VARCHAR(16) NULL,
    `wipLimit` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `board_columns_boardId_position_idx`(`boardId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `tasks_columnId_position_idx` ON `tasks`(`columnId`, `position`);

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_columnId_fkey` FOREIGN KEY (`columnId`) REFERENCES `board_columns`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `boards` ADD CONSTRAINT `boards_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `boards` ADD CONSTRAINT `boards_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `board_columns` ADD CONSTRAINT `board_columns_boardId_fkey` FOREIGN KEY (`boardId`) REFERENCES `boards`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────
-- 说明：本迁移是手工落的（不是 prisma migrate dev 生成）。
--
-- 原因：ngram 全文索引不在 Prisma schema 里，Prisma 会把它判为 drift，
-- 导致 migrate dev 要求 reset 整个数据库。所以这里用
-- `prisma migrate diff --from-config-datasource --to-schema` 生成 SQL，
-- 剔除其中的 DROP INDEX 语句后落盘，再用 migrate deploy 应用。
--
-- 全文索引由 scripts/ensure-indexes.ts 在每次迁移后自动维护。
-- ─────────────────────────────────────────────────────────────────
