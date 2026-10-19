-- 首次初始化数据卷时自动执行（仅在 mysql-dev-data 卷为空时运行一次）
-- 注意：这里只放"必须有"的东西，表结构一律交给 Prisma migrate 管理。

-- 测试用数据库（跑集成测试用，与开发库隔离）
CREATE DATABASE IF NOT EXISTS `notecloud_test`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

GRANT ALL PRIVILEGES ON `notecloud_test`.* TO 'notecloud'@'%';

FLUSH PRIVILEGES;

-- 自检：确认 ngram 解析器可用（这是选 MySQL 8 而非 MariaDB 的核心原因）
-- 运行 `SHOW VARIABLES LIKE 'ngram_token_size';` 应返回 2
