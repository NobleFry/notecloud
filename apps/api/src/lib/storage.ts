import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import { env, repoRoot } from '../config/env.js';

/**
 * 存储抽象。
 *
 * 现在只有 local 一种实现；以后要接 MinIO / S3，只需要再写一个实现了
 * 这个接口的类，业务代码一行都不用改。
 */
export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>;
  getStream(key: string): ReadStream;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

class LocalStorage implements StorageDriver {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * 把存储键解析成绝对路径。
   * 必须校验最终路径仍在 root 之下 —— 即使 storageKey 完全由服务端生成，
   * 将来接外部输入时这一步是唯一的路径穿越防线。
   */
  private resolveKey(key: string): string {
    const full = resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error('非法的存储键');
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolveKey(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  getStream(key: string): ReadStream {
    return createReadStream(this.resolveKey(key));
  }

  async delete(key: string): Promise<void> {
    await unlink(this.resolveKey(key)).catch(() => {
      /* 文件已经不在也不该让清理流程失败 */
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }
}

function resolveRoot(): string {
  // UPLOAD_DIR 相对路径以仓库根为基准，避免依赖进程 cwd
  return env.UPLOAD_DIR.startsWith('/') ? env.UPLOAD_DIR : resolve(repoRoot, env.UPLOAD_DIR);
}

function build(): StorageDriver {
  switch (env.STORAGE_DRIVER) {
    case 'local':
      return new LocalStorage(resolveRoot());
    default:
      throw new Error(`不支持的存储驱动: ${String(env.STORAGE_DRIVER)}`);
  }
}

export const storage = build();
export const storageRoot = resolveRoot();
