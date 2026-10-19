-- CreateTable
CREATE TABLE `notebooks` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `parentId` VARCHAR(191) NULL,
    `name` VARCHAR(64) NOT NULL,
    `icon` VARCHAR(32) NULL,
    `color` VARCHAR(16) NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `depth` INTEGER NOT NULL DEFAULT 0,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `notebooks_workspaceId_parentId_position_idx`(`workspaceId`, `parentId`, `position`),
    INDEX `notebooks_workspaceId_deletedAt_idx`(`workspaceId`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notes` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `content` LONGTEXT NOT NULL,
    `excerpt` VARCHAR(300) NULL,
    `visibility` ENUM('PRIVATE', 'WORKSPACE') NOT NULL DEFAULT 'WORKSPACE',
    `isPinned` BOOLEAN NOT NULL DEFAULT false,
    `isStarred` BOOLEAN NOT NULL DEFAULT false,
    `archivedAt` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdById` VARCHAR(191) NOT NULL,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `notes_workspaceId_deletedAt_updatedAt_idx`(`workspaceId`, `deletedAt`, `updatedAt`),
    INDEX `notes_workspaceId_isStarred_idx`(`workspaceId`, `isStarred`),
    INDEX `notes_workspaceId_archivedAt_idx`(`workspaceId`, `archivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `note_notebooks` (
    `noteId` VARCHAR(191) NOT NULL,
    `notebookId` VARCHAR(191) NOT NULL,

    INDEX `note_notebooks_notebookId_idx`(`notebookId`),
    PRIMARY KEY (`noteId`, `notebookId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tags` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(32) NOT NULL,
    `color` VARCHAR(16) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `tags_workspaceId_idx`(`workspaceId`),
    UNIQUE INDEX `tags_workspaceId_name_key`(`workspaceId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `note_tags` (
    `noteId` VARCHAR(191) NOT NULL,
    `tagId` VARCHAR(191) NOT NULL,

    INDEX `note_tags_tagId_idx`(`tagId`),
    PRIMARY KEY (`noteId`, `tagId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `notebooks` ADD CONSTRAINT `notebooks_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notebooks` ADD CONSTRAINT `notebooks_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `notebooks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notebooks` ADD CONSTRAINT `notebooks_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notes` ADD CONSTRAINT `notes_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notes` ADD CONSTRAINT `notes_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notes` ADD CONSTRAINT `notes_updatedById_fkey` FOREIGN KEY (`updatedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `note_notebooks` ADD CONSTRAINT `note_notebooks_noteId_fkey` FOREIGN KEY (`noteId`) REFERENCES `notes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `note_notebooks` ADD CONSTRAINT `note_notebooks_notebookId_fkey` FOREIGN KEY (`notebookId`) REFERENCES `notebooks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tags` ADD CONSTRAINT `tags_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `note_tags` ADD CONSTRAINT `note_tags_noteId_fkey` FOREIGN KEY (`noteId`) REFERENCES `notes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `note_tags` ADD CONSTRAINT `note_tags_tagId_fkey` FOREIGN KEY (`tagId`) REFERENCES `tags`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────
-- 中文全文检索索引（手写，Prisma 不支持 WITH PARSER ngram）
--
-- 用 ngram 而不是默认解析器：MySQL 默认分词按空格切，中文整段会变成一个词，
-- 搜 "笔记" 命中不了 "我的笔记系统"。ngram_token_size=2 已在 compose 里设好，
-- 即按"双字词"切分，符合中文习惯。
--
-- 注意：ngram_token_size 是只读启动参数，改它必须重建索引 —— 一开始就定死。
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE `notes`
  ADD FULLTEXT INDEX `notes_ft_title_content` (`title`, `content`) WITH PARSER ngram;
