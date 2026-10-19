import { hash, verify } from '@node-rs/argon2';

/**
 * 用 @node-rs/argon2（Rust 实现，带预编译产物）而不是 argon2 npm 包：
 * 后者是原生模块，没有预编译产物时需要本地编译，在自部署的干净环境里经常失败。
 *
 * 参数按 OWASP 推荐：argon2id + m=19MiB + t=2 + p=1
 *
 * 关于 `algorithm: 2`：@node-rs/argon2 的 Algorithm 是声明在 .d.ts 里的 ambient enum，
 * 在 isolatedModules 下无法以值的形式引用，所以这里写成字面量并注明出处
 * （其 d.ts 中 `Argon2id = 2`，与 Rust argon2 crate 的编号一致）。
 */
const ARGON2ID = 2;

const HASH_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, HASH_OPTIONS);
}

/** 校验密码。任何异常（哈希串损坏等）都视为"不匹配"，而不是抛出 */
export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}
