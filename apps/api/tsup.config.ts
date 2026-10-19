import { defineConfig } from 'tsup';

export default defineConfig({
  // 用「命名入口」而不是数组：数组会让 tsup 保留目录结构
  // （输出成 dist/src/index.js、dist/scripts/ensure-indexes.js），
  // 那样 Dockerfile 里的 `node dist/index.js` 就找不到文件。
  entry: {
    index: 'src/index.ts',
    'ensure-indexes': 'scripts/ensure-indexes.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // 工作区内的共享包要打进来（它是源码形态，没有自己的构建产物）
  noExternal: ['@notecloud/shared'],
  // 原生模块与数据库驱动保持外部依赖，不要打进 bundle
  external: ['@node-rs/argon2', 'mariadb'],
});
