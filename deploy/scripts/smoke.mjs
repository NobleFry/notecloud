#!/usr/bin/env node
/**
 * M1 端到端冒烟测试（不依赖测试框架，直接打真实接口）
 *
 *   node deploy/scripts/smoke.mjs
 *   BASE=http://127.0.0.1:3000/api/v1 node deploy/scripts/smoke.mjs
 *
 * 覆盖：首次启动引导、注册、登录态、工作区、邀请、角色权限不变量、
 *       Refresh 轮转与重放检测。
 *
 * ⚠️ 会往数据库写入测试数据。跑完后建议重置开发库：
 *      pnpm dev:db:reset && pnpm --filter @notecloud/api exec prisma migrate dev --name init
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000/api/v1';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    failures.push({ name, detail });
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  → ${JSON.stringify(detail)}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[36m${title}\x1b[0m`);
}

function pickRefreshCookie(setCookies) {
  const raw = setCookies.find((c) => c.startsWith('nc_rt='));
  if (!raw) return null;
  return raw.split(';')[0];
}

async function req(method, path, { body, token, cookie, query, headers } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const res = await fetch(`${BASE}${path}${qs}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 空响应 */
  }

  return {
    status: res.status,
    body: json,
    code: json?.code,
    data: json?.data,
    setCookies: res.headers.getSetCookie?.() ?? [],
  };
}

async function main() {
  // 时间戳后缀，保证同一个库可以重复跑
  const stamp = Date.now().toString(36);
  const adminEmail = `admin-${stamp}@smoke.local`;
  let memberEmail = `member-${stamp}@smoke.local`;
  const PASSWORD = 'SmokeTest1234';

  section('1. 站点状态与首次启动');

  const status0 = await req('GET', '/site/status');
  check('GET /site/status 返回 200', status0.status === 200, status0.body);
  check('响应包结构符合约定（code/message/data/requestId）',
    typeof status0.code === 'number' && 'message' in (status0.body ?? {}) && 'requestId' in (status0.body ?? {}),
    status0.body);

  // 无法假设库一定是空的（可能重复跑），只校验字段存在
  check('initialized 是布尔值', typeof status0.data?.initialized === 'boolean', status0.data);
  check('registration 策略已下发', typeof status0.data?.registration?.enabled === 'boolean', status0.data);

  section('2. 注册与登录态');

  let r = await req('POST', '/auth/register', {
    body: { email: adminEmail, password: PASSWORD, name: '冒烟管理员' },
  });

  // 若库里已有用户且未开公开注册，这里会 40310 —— 那也算正确行为
  if (r.code === 40310) {
    console.log('  \x1b[33m!\x1b[0m 公开注册已关闭且库中已有用户，跳过后续流程（重置数据库后再跑）');
    return summarize();
  }

  check('POST /auth/register 成功', r.code === 0, r.body);
  const adminToken = r.data?.accessToken;
  const adminId = r.data?.user?.id;
  check('注册返回 accessToken', typeof adminToken === 'string' && adminToken.length > 20);
  check('注册即获得个人工作区', Array.isArray(r.data?.workspaces) && r.data.workspaces.some((w) => w.isPersonal));
  check('注册下发 HttpOnly refresh cookie', r.setCookies.some((c) => c.includes('nc_rt=') && /httponly/i.test(c)));

  let adminCookie = pickRefreshCookie(r.setCookies);

  const me = await req('GET', '/auth/me', { token: adminToken });
  check('GET /auth/me 可访问', me.code === 0 && me.data?.user?.id === adminId, me.body);
  const isAdmin = me.data?.user?.role === 'ADMIN';
  console.log(`  \x1b[90m·\x1b[0m 当前账号站点角色: ${me.data?.user?.role}（库中首个用户应为 ADMIN）`);

  const badLogin = await req('POST', '/auth/login', { body: { email: adminEmail, password: 'WrongPass1234' } });
  check('错误密码返回 40100', badLogin.code === 40100, badLogin.body);

  const noAuth = await req('GET', '/auth/me');
  check('无 token 访问受保护接口返回 40100', noAuth.code === 40100, noAuth.body);

  section('3. 工作区');

  r = await req('POST', '/workspaces', { token: adminToken, body: { name: `冒烟团队 ${stamp}` } });
  check('创建团队工作区成功', r.code === 0, r.body);
  const teamId = r.data?.workspace?.id;
  check('创建者是 OWNER', r.data?.workspace?.role === 'OWNER', r.data?.workspace);

  const list = await req('GET', '/workspaces', { token: adminToken });
  check('工作区列表包含个人空间与团队', (list.data?.items?.length ?? 0) >= 2, list.data);

  const detail = await req('GET', `/workspaces/${teamId}`, { token: adminToken });
  check('读取工作区详情', detail.code === 0 && detail.data?.memberCount === 1, detail.body);

  section('4. 邀请与加入');

  r = await req('POST', `/workspaces/${teamId}/invitations`, {
    token: adminToken,
    body: { role: 'MEMBER', maxUses: 3, expiresInDays: 7 },
  });
  check('OWNER 生成通用邀请链接', r.code === 0, r.body);
  const inviteToken = r.data?.invitation?.token;
  const inviteUrl = r.data?.invitation?.url;
  check('邀请返回一次性明文 token 与 url', typeof inviteToken === 'string' && typeof inviteUrl === 'string');

  const preview = await req('GET', `/invitations/${inviteToken}`);
  check('公开预览邀请（无需登录）', preview.code === 0 && preview.data?.valid === true, preview.body);

  r = await req('POST', '/auth/register', {
    body: { email: memberEmail, password: PASSWORD, name: '冒烟成员', inviteToken },
  });
  check('带邀请 token 注册成功', r.code === 0, r.body);
  let memberToken = r.data?.accessToken;
  const memberId = r.data?.user?.id;
  check('注册后自动加入被邀请的工作区',
    r.data?.workspaces?.some((w) => w.id === teamId && w.role === 'MEMBER'), r.data?.workspaces);

  const replayInvite = await req('POST', `/invitations/${inviteToken}/accept`, { token: memberToken });
  check('重复接受同一邀请是幂等的（不报错）', replayInvite.code === 0, replayInvite.body);

  section('5. 权限不变量');

  r = await req('POST', `/workspaces/${teamId}/invitations`, {
    token: memberToken,
    body: { role: 'MEMBER', maxUses: 1, expiresInDays: 7 },
  });
  check('MEMBER 不能邀请成员（40302）', r.code === 40302, r.body);

  r = await req('PATCH', `/workspaces/${teamId}`, { token: memberToken, body: { name: '改名试试' } });
  check('MEMBER 不能修改工作区（40302）', r.code === 40302, r.body);

  r = await req('GET', `/workspaces/${teamId}/members`, { token: adminToken });
  check('成员列表包含 2 人', r.data?.items?.length === 2, r.data);

  r = await req('DELETE', `/workspaces/${teamId}/members/${adminId}`, { token: adminToken });
  check('不能移除自己（40300）', r.code === 40300, r.body);

  r = await req('POST', `/workspaces/${teamId}/leave`, { token: adminToken });
  check('最后一个 OWNER 不能退出（40902）', r.code === 40902, r.body);

  r = await req('PATCH', `/workspaces/${teamId}/members/${adminId}`, {
    token: adminToken,
    body: { role: 'MEMBER' },
  });
  check('不能修改自己的角色（40300）', r.code === 40300, r.body);

  r = await req('DELETE', `/workspaces/${teamId}/members/${adminId}`, { token: memberToken });
  check('MEMBER 不能移除他人（40302）', r.code === 40302, r.body);

  const outsider = await req('GET', `/workspaces/${teamId}/members`, { token: undefined });
  check('未登录访问成员列表被拒', outsider.code === 40100, outsider.body);

  await notesTests(adminToken, teamId);
  await tasksTests(adminToken, teamId);
  await boardsTests(adminToken, teamId);
  await attachmentsTests(adminToken, teamId);
  await notificationsTests(adminToken, memberToken, memberId, teamId);
  await syncShareRealtimeTests(adminToken, memberToken, memberId, teamId);
  memberToken = await m1CompletionTests(adminToken, memberToken, memberId, teamId, PASSWORD) ?? memberToken;

  section('13. Refresh 轮转与重放检测');

  const first = await req('POST', '/auth/refresh', { cookie: adminCookie });
  check('用 cookie 刷新成功', first.code === 0 && typeof first.data?.accessToken === 'string', first.body);
  const rotatedCookie = pickRefreshCookie(first.setCookies);
  check('刷新后下发了新的 refresh cookie', Boolean(rotatedCookie) && rotatedCookie !== adminCookie);

  const replay = await req('POST', '/auth/refresh', { cookie: adminCookie });
  check('重放旧 refresh token 被识别（40102）', replay.code === 40102, replay.body);

  const afterReplay = await req('POST', '/auth/refresh', { cookie: rotatedCookie });
  check('重放检测后整族会话被吊销（新 token 也失效）', afterReplay.code === 40100 || afterReplay.code === 40102, afterReplay.body);

  section('14. 退出与清理');

  r = await req('POST', '/auth/logout', { token: adminToken, cookie: adminCookie });
  check('登出接口可用', r.code === 0 || r.code === 40100, r.body);

  r = await req('POST', `/workspaces/${teamId}/leave`, { token: memberToken });
  check('普通成员可以退出工作区', r.code === 0, r.body);

  return summarize(isAdmin);
}

// ─────────────────────────────────────────────────────────────────
// M2：笔记 / 笔记本 / 标签
// ─────────────────────────────────────────────────────────────────
async function notesTests(token, workspaceId) {
  section('6. 笔记 / 笔记本 / 标签');

  // ── 笔记本 ──
  let r = await req('POST', `/workspaces/${workspaceId}/notebooks`, { token, body: { name: '产品设计' } });
  check('创建笔记本', r.code === 0, r.body);
  const nbId = r.data?.notebook?.id;

  r = await req('POST', `/workspaces/${workspaceId}/notebooks`, { token, body: { name: '需求', parentId: nbId } });
  check('创建子笔记本（depth=1）', r.code === 0 && r.data?.notebook?.depth === 1, r.body);
  const childId = r.data?.notebook?.id;

  r = await req('GET', `/workspaces/${workspaceId}/notebooks`, { token });
  check('笔记本树返回 2 个节点', r.data?.items?.length === 2, r.data);

  // ── 拖拽重排：环路保护 / 深度重算 / 空列表 ──
  r = await req('POST', `/workspaces/${workspaceId}/notebooks/reorder`, {
    token,
    body: { parentId: childId, orderedIds: [nbId] },
  });
  check('拒绝把父笔记本移到自己的子节点下（40000）', r.code === 40000, r.body);

  r = await req('POST', `/workspaces/${workspaceId}/notebooks/reorder`, {
    token,
    body: { parentId: null, orderedIds: [childId, nbId] },
  });
  check('把子笔记本拖到根目录并排在前面', r.code === 0, r.body);

  r = await req('GET', `/workspaces/${workspaceId}/notebooks`, { token });
  const movedChild = (r.data?.items ?? []).find((n) => n.id === childId);
  check('移动后 depth 被重算为 0', movedChild?.depth === 0, movedChild);

  r = await req('POST', `/workspaces/${workspaceId}/notebooks/reorder`, {
    token,
    body: { parentId: null, orderedIds: [] },
  });
  check('允许空列表重排（源父级被搬空时的清理）', r.code === 0, r.body);

  // 还原结构，后面的删除测试依赖"父 + 子"共 2 个
  r = await req('POST', `/workspaces/${workspaceId}/notebooks/reorder`, {
    token,
    body: { parentId: nbId, orderedIds: [childId] },
  });
  check('把子笔记本拖回父节点下', r.code === 0, r.body);

  // ── 笔记创建 ──
  r = await req('POST', `/workspaces/${workspaceId}/notes`, {
    token,
    body: {
      title: '云同步笔记系统设计',
      content: '# 目标\n\n支持中文全文检索的笔记系统。',
      notebookIds: [nbId],
      tagIds: [],
    },
  });
  check('创建笔记并归属笔记本', r.code === 0 && r.data?.note?.notebookIds?.includes(nbId), r.body);
  const noteId = r.data?.note?.id;
  check('新建笔记版本号为 1', r.data?.note?.version === 1, r.data?.note?.version);

  // ── 乐观锁 ──
  r = await req('PATCH', `/workspaces/${workspaceId}/notes/${noteId}`, {
    token,
    body: { version: 1, title: '云同步笔记系统设计 v2', content: '支持中文全文检索与看板联动。' },
  });
  check('按版本号更新成功且版本 +1', r.code === 0 && r.data?.note?.version === 2, r.body);

  r = await req('PATCH', `/workspaces/${workspaceId}/notes/${noteId}`, {
    token,
    body: { version: 1, title: '并发覆盖尝试' },
  });
  check('用过期版本号更新返回 40900', r.code === 40900, r.body);
  check('409 响应带回服务端最新内容', r.data?.current?.version === 2, r.data?.current);

  // ── 中文全文检索（ngram）──
  r = await req('GET', `/workspaces/${workspaceId}/notes`, { token, query: { q: '中文检索' } });
  check('ngram 中文全文检索命中', (r.data?.items?.length ?? 0) >= 1, r.data);
  check('检索结果包含目标笔记', (r.data?.items ?? []).some((n) => n.id === noteId), r.data?.items);

  r = await req('GET', `/workspaces/${workspaceId}/notes`, { token, query: { q: '不存在的关键词xyz' } });
  check('无关词不返回结果', (r.data?.items?.length ?? 0) === 0, r.data);

  // ── 标签 ──
  r = await req('POST', `/workspaces/${workspaceId}/tags`, { token, body: { name: '设计' } });
  check('创建标签', r.code === 0, r.body);
  const tagId = r.data?.tag?.id;

  r = await req('PUT', `/workspaces/${workspaceId}/notes/${noteId}/tags`, { token, body: { tagIds: [tagId] } });
  check('给笔记打标签', r.code === 0, r.body);

  r = await req('GET', `/workspaces/${workspaceId}/notes/${noteId}`, { token });
  check('笔记详情带标签', r.data?.note?.tags?.[0]?.id === tagId, r.data?.note?.tags);

  r = await req('GET', `/workspaces/${workspaceId}/notes`, { token, query: { tagId } });
  check('按标签筛选命中', (r.data?.items ?? []).some((n) => n.id === noteId), r.data);

  // ── 回收站（保留 30 天）──
  r = await req('DELETE', `/workspaces/${workspaceId}/notes/${noteId}`, { token });
  check('移入回收站', r.code === 0, r.body);

  r = await req('GET', `/workspaces/${workspaceId}/notes`, { token, query: { view: 'trash' } });
  check('回收站列表能看到', (r.data?.items ?? []).some((n) => n.id === noteId), r.data);

  r = await req('GET', `/workspaces/${workspaceId}/notes`, { token, query: { view: 'all' } });
  check('普通列表看不到已删除的', !(r.data?.items ?? []).some((n) => n.id === noteId), r.data);

  r = await req('POST', `/workspaces/${workspaceId}/notes/${noteId}/restore`, { token });
  check('从回收站恢复', r.code === 0, r.body);

  // ── 删除笔记本：只解关联，不删笔记 ──
  r = await req('DELETE', `/workspaces/${workspaceId}/notebooks/${nbId}`, { token });
  check('删除笔记本（含子笔记本，共 2 个）', r.code === 0 && r.data?.deletedCount === 2, r.body);

  r = await req('GET', `/workspaces/${workspaceId}/notes/${noteId}`, { token });
  check('笔记没有被连带删除', r.code === 0, r.body);
  check('笔记已解除笔记本归属', (r.data?.note?.notebookIds ?? []).length === 0, r.data?.note?.notebookIds);

  r = await req('GET', `/workspaces/${workspaceId}/notes`, { token, query: { notebookId: 'none' } });
  check('收件箱能查到该笔记', (r.data?.items ?? []).some((n) => n.id === noteId), r.data);
}

// ─────────────────────────────────────────────────────────────────
// M3：待办任务 / 子任务 / 评论
// ─────────────────────────────────────────────────────────────────
async function tasksTests(token, workspaceId) {
  section('7. 待办任务 / 子任务 / 评论');

  // ── 创建 ──
  let r = await req('POST', `/workspaces/${workspaceId}/tasks`, {
    token,
    body: {
      title: '整理 M3 需求',
      description: '梳理任务模块的字段与视图',
      priority: 'HIGH',
      dueAt: new Date().toISOString(),
      isAllDay: false,
      checklist: [{ title: '确认字段' }, { title: '确认视图' }],
    },
  });
  check('创建任务（含 2 个子任务）', r.code === 0 && r.data?.task?.checklist?.length === 2, r.body);
  const taskId = r.data?.task?.id;
  check('新建任务版本号为 1', r.data?.task?.version === 1, r.data?.task?.version);

  // ── 视图 ──
  r = await req('GET', `/workspaces/${workspaceId}/tasks`, { token, query: { view: 'today' } });
  check('「今天」视图能查到刚建的任务', (r.data?.items ?? []).some((t) => t.id === taskId), r.data);

  // ── 乐观锁 ──
  r = await req('PATCH', `/workspaces/${workspaceId}/tasks/${taskId}`, {
    token,
    body: { version: 1, title: '整理 M3 需求（已改）' },
  });
  check('按版本号更新任务，版本 +1', r.code === 0 && r.data?.task?.version === 2, r.body);

  r = await req('PATCH', `/workspaces/${workspaceId}/tasks/${taskId}`, {
    token,
    body: { version: 1, title: '并发覆盖尝试' },
  });
  check('用过期版本号更新任务返回 40900', r.code === 40900, r.body);
  check('任务 409 带回服务端最新内容', r.data?.current?.version === 2, r.data?.current);

  // ── 子任务勾选（不需要版本号）──
  r = await req('GET', `/workspaces/${workspaceId}/tasks/${taskId}`, { token });
  const itemId = r.data?.task?.checklist?.[0]?.id;

  r = await req('PATCH', `/workspaces/${workspaceId}/tasks/${taskId}/checklist/${itemId}`, {
    token,
    body: { done: true },
  });
  check('勾选子任务，进度变为 1/2', r.code === 0 && r.data?.task?.checklistDone === 1, r.body);

  // ── 完成：写入 completedAt，并从待办视图消失 ──
  r = await req('PATCH', `/workspaces/${workspaceId}/tasks/${taskId}`, {
    token,
    body: { version: 2, status: 'DONE' },
  });
  check('标记完成会写入 completedAt', r.code === 0 && Boolean(r.data?.task?.completedAt), r.body);

  r = await req('GET', `/workspaces/${workspaceId}/tasks`, { token, query: { view: 'all' } });
  check('完成后从「全部待办」消失', !(r.data?.items ?? []).some((t) => t.id === taskId), r.data);

  r = await req('GET', `/workspaces/${workspaceId}/tasks`, { token, query: { view: 'done' } });
  check('「已完成」视图能查到', (r.data?.items ?? []).some((t) => t.id === taskId), r.data);

  // ── 评论 ──
  r = await req('POST', `/workspaces/${workspaceId}/tasks/${taskId}/comments`, {
    token,
    body: { body: '这条先按字段最小集做 @冒烟管理员' },
  });
  check('发表评论', r.code === 0, r.body);

  r = await req('GET', `/workspaces/${workspaceId}/tasks/${taskId}/comments`, { token });
  check('评论列表返回 1 条', r.data?.items?.length === 1, r.data);

  // ── ngram 检索任务 ──
  r = await req('GET', `/workspaces/${workspaceId}/tasks`, { token, query: { q: '任务模块' } });
  check('ngram 检索命中任务描述', (r.data?.items ?? []).some((t) => t.id === taskId), r.data);

  // ── 标签在笔记与任务间共享 ──
  r = await req('POST', `/workspaces/${workspaceId}/tags`, { token, body: { name: '任务标签' } });
  const tagId = r.data?.tag?.id;
  check('创建任务标签', r.code === 0, r.body);

  r = await req('PATCH', `/workspaces/${workspaceId}/tasks/${taskId}`, {
    token,
    body: { version: 3, tagIds: [tagId] },
  });
  check('给任务打标签', r.code === 0 && r.data?.task?.tags?.[0]?.id === tagId, r.body);

  r = await req('GET', `/workspaces/${workspaceId}/tags`, { token });
  const tag = (r.data?.items ?? []).find((t) => t.id === tagId);
  check('标签同时统计任务数', tag?.taskCount === 1, tag);

  // ── 回收站 ──
  r = await req('DELETE', `/workspaces/${workspaceId}/tasks/${taskId}`, { token });
  check('任务移入回收站', r.code === 0, r.body);

  r = await req('GET', `/workspaces/${workspaceId}/tasks`, { token, query: { view: 'trash' } });
  check('回收站能看到任务', (r.data?.items ?? []).some((t) => t.id === taskId), r.data);

  r = await req('POST', `/workspaces/${workspaceId}/tasks/${taskId}/restore`, { token });
  check('从回收站恢复任务', r.code === 0, r.body);
}

// ─────────────────────────────────────────────────────────────────
// M4：看板
// ─────────────────────────────────────────────────────────────────
async function boardsTests(token, workspaceId) {
  section('8. 看板（卡片即任务）');

  // ── 建板 ──
  let r = await req('POST', `/workspaces/${workspaceId}/boards`, { token, body: { name: '迭代看板' } });
  check('创建看板', r.code === 0, r.body);
  const boardId = r.data?.board?.id;

  r = await req('GET', `/workspaces/${workspaceId}/boards/${boardId}`, { token });
  check('新看板自带 3 列', r.data?.columns?.length === 3, r.data?.columns?.map((c) => c.name));
  let columns = r.data?.columns ?? [];
  const todoCol = columns.find((c) => c.status === 'TODO');
  const doingCol = columns.find((c) => c.status === 'IN_PROGRESS');
  const doneCol = columns.find((c) => c.status === 'DONE');

  // ── 自定义列 ──
  r = await req('POST', `/workspaces/${workspaceId}/boards/${boardId}/columns`, {
    token,
    body: { name: '待评审', status: 'IN_PROGRESS' },
  });
  check('添加自定义列', r.code === 0, r.body);
  const reviewCol = r.data?.column;

  // ── 卡片就是任务 ──
  r = await req('POST', `/workspaces/${workspaceId}/tasks`, {
    token,
    body: { title: '看板卡片 A', columnId: todoCol.id },
  });
  check('从看板列新建卡片', r.code === 0 && r.data?.task?.columnId === todoCol.id, r.body);
  const cardA = r.data?.task?.id;
  check('卡片状态由所在列决定', r.data?.task?.status === 'TODO', r.data?.task?.status);

  r = await req('POST', `/workspaces/${workspaceId}/tasks`, {
    token,
    body: { title: '看板卡片 B', columnId: todoCol.id },
  });
  const cardB = r.data?.task?.id;

  // ── 拖动 ──
  r = await req('POST', `/workspaces/${workspaceId}/boards/${boardId}/move`, {
    token,
    body: { taskId: cardA, columnId: doingCol.id, orderedTaskIds: [cardA] },
  });
  check('拖到「进行中」列', r.code === 0, r.body);
  const movedCol = (r.data?.columns ?? []).find((c) => c.id === doingCol.id);
  check('卡片出现在目标列', (movedCol?.tasks ?? []).some((t) => t.id === cardA), movedCol?.tasks);

  r = await req('GET', `/workspaces/${workspaceId}/tasks/${cardA}`, { token });
  check('拖动后任务状态同步为 IN_PROGRESS', r.data?.task?.status === 'IN_PROGRESS', r.data?.task?.status);
  check('任务 columnId 指向新列', r.data?.task?.columnId === doingCol.id, r.data?.task?.columnId);

  // ── WIP 上限 ──
  r = await req('PATCH', `/workspaces/${workspaceId}/board-columns/${doneCol.id}`, {
    token,
    body: { wipLimit: 1 },
  });
  check('设置 WIP 上限', r.code === 0 && r.data?.column?.wipLimit === 1, r.body);

  r = await req('POST', `/workspaces/${workspaceId}/boards/${boardId}/move`, {
    token,
    body: { taskId: cardA, columnId: doneCol.id, orderedTaskIds: [cardA] },
  });
  check('第一张卡可以进入有 WIP 限制的列', r.code === 0, r.body);

  r = await req('POST', `/workspaces/${workspaceId}/boards/${boardId}/move`, {
    token,
    body: { taskId: cardB, columnId: doneCol.id, orderedTaskIds: [cardA, cardB] },
  });
  check('超过 WIP 上限被拒绝（40000）', r.code === 40000, r.body);

  // ── 改列的映射状态 → 列内任务跟着变 ──
  r = await req('PATCH', `/workspaces/${workspaceId}/board-columns/${doneCol.id}`, {
    token,
    body: { status: 'CANCELED' },
  });
  check('修改列的映射状态', r.code === 0, r.body);

  r = await req('GET', `/workspaces/${workspaceId}/tasks/${cardA}`, { token });
  check('列内任务状态同步变为 CANCELED', r.data?.task?.status === 'CANCELED', r.data?.task?.status);

  // ── 删列：任务脱离看板但保留 ──
  r = await req('DELETE', `/workspaces/${workspaceId}/board-columns/${doneCol.id}`, { token });
  check('删除列', r.code === 0, r.body);

  r = await req('GET', `/workspaces/${workspaceId}/tasks/${cardA}`, { token });
  check('删列后任务没被删，只是脱离看板', r.code === 0 && r.data?.task?.columnId === null, r.data?.task?.columnId);

  // ── 列表统计 ──
  r = await req('GET', `/workspaces/${workspaceId}/boards`, { token });
  const summary = (r.data?.items ?? []).find((b) => b.id === boardId);
  check('看板列表返回列数统计（4-1=3）', summary?.columnCount === 3, summary);

  // ── 列内重排（用户反馈的场景）──
  const mk = async (title) =>
    (await req('POST', `/workspaces/${workspaceId}/tasks`, { token, body: { title, columnId: todoCol.id } })).data
      ?.task?.id;

  const t1 = await mk('顺序卡 1');
  const t2 = await mk('顺序卡 2');
  const t3 = await mk('顺序卡 3');

  r = await req('GET', `/workspaces/${workspaceId}/boards/${boardId}`, { token });
  let todoTasks = (r.data?.columns ?? []).find((c) => c.id === todoCol.id)?.tasks ?? [];
  check(
    '新卡片按创建顺序排在列尾',
    todoTasks.map((t) => t.id).join(',') === [cardB, t1, t2, t3].join(','),
    todoTasks.map((t) => t.title),
  );

  // 把最后一张拖到最前
  r = await req('POST', `/workspaces/${workspaceId}/boards/${boardId}/move`, {
    token,
    body: { taskId: t3, columnId: todoCol.id, orderedTaskIds: [t3, cardB, t1, t2] },
  });
  check('列内重排请求成功', r.code === 0, r.body);

  todoTasks = (r.data?.columns ?? []).find((c) => c.id === todoCol.id)?.tasks ?? [];
  check(
    '列内顺序确实改变了',
    todoTasks.map((t) => t.id).join(',') === [t3, cardB, t1, t2].join(','),
    todoTasks.map((t) => t.title),
  );
  check(
    '重排后 position 连续递增',
    todoTasks.every((t, i) => t.position === i),
    todoTasks.map((t) => t.position),
  );

  // ── 把已有待办加进看板（用户反馈的缺口）──
  r = await req('POST', `/workspaces/${workspaceId}/tasks`, { token, body: { title: '还没上板的任务' } });
  const looseTask = r.data?.task?.id;
  check('待办里新建的任务默认不在看板上', r.data?.task?.columnId === null, r.data?.task?.columnId);

  r = await req('GET', `/workspaces/${workspaceId}/tasks`, { token, query: { unassigned: '1' } });
  check(
    'unassigned 过滤只返回未上板的任务',
    (r.data?.items ?? []).length > 0 && (r.data?.items ?? []).every((t) => t.columnId === null),
    r.data?.items?.map((t) => ({ id: t.id, columnId: t.columnId })),
  );

  r = await req('GET', `/workspaces/${workspaceId}/board-columns`, { token });
  check('可以列出所有看板列（选择器用）', (r.data?.boards ?? []).some((b) => b.id === boardId), r.data);

  r = await req('PUT', `/workspaces/${workspaceId}/tasks/${looseTask}/column`, {
    token,
    body: { columnId: todoCol.id },
  });
  check('把已有任务放进看板列', r.code === 0 && r.data?.task?.columnId === todoCol.id, r.body);
  check('状态随列同步为 TODO', r.data?.task?.status === 'TODO', r.data?.task?.status);

  r = await req('PUT', `/workspaces/${workspaceId}/tasks/${looseTask}/column`, {
    token,
    body: { columnId: null },
  });
  check('可以从看板移出', r.code === 0 && r.data?.task?.columnId === null, r.body);

  // ── 删板 ──
  r = await req('DELETE', `/workspaces/${workspaceId}/boards/${boardId}`, { token });
  check('删除看板', r.code === 0, r.body);

  r = await req('GET', `/workspaces/${workspaceId}/boards/${boardId}`, { token });
  check('删除后看板不可访问（40400）', r.code === 40400, r.body);

  void reviewCol;
  void columns;
}

// ─────────────────────────────────────────────────────────────────
// M5-A：附件上传
// ─────────────────────────────────────────────────────────────────
async function attachmentsTests(token, workspaceId) {
  section('9. 附件上传（能力链接）');

  const origin = new URL(BASE).origin;

  // 1×1 透明 PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'dot.png');

  let res = await fetch(`${BASE}/workspaces/${workspaceId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  let body = await res.json();
  check('上传 PNG 成功', body.code === 0, body);

  const att = body.data?.attachment;
  check('返回能力链接', typeof att?.url === 'string' && att.url.startsWith('/api/v1/attachments/'), att);
  check('返回文件大小', att?.size === png.byteLength, att?.size);

  // 能力链接：不登录也能读
  const fileRes = await fetch(`${origin}${att.url}`);
  check('能力链接无需登录即可读取', fileRes.status === 200, fileRes.status);
  check('返回正确的 Content-Type', fileRes.headers.get('content-type') === 'image/png', fileRes.headers.get('content-type'));
  check('带 nosniff 头', fileRes.headers.get('x-content-type-options') === 'nosniff');
  const got = Buffer.from(await fileRes.arrayBuffer());
  check('读回的内容与上传一致', got.equals(png), `${got.length} vs ${png.length}`);

  // 错误 token 必须拿不到
  const badRes = await fetch(`${origin}${att.url}tampered`);
  check('token 被篡改返回 404', badRes.status === 404, badRes.status);

  // 不支持的类型（SVG 内可嵌脚本，刻意拒绝）
  const svgForm = new FormData();
  svgForm.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }), 'x.svg');
  res = await fetch(`${BASE}/workspaces/${workspaceId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: svgForm,
  });
  body = await res.json();
  check('拒绝 SVG 上传', body.code !== 0, body);

  // 未登录不能上传
  const anonForm = new FormData();
  anonForm.append('file', new Blob([png], { type: 'image/png' }), 'a.png');
  res = await fetch(`${BASE}/workspaces/${workspaceId}/attachments`, { method: 'POST', body: anonForm });
  body = await res.json();
  check('未登录上传被拒（40100）', body.code === 40100, body);

  // 删除
  res = await fetch(`${BASE}/workspaces/${workspaceId}/attachments/${att.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  body = await res.json();
  check('删除附件', body.code === 0, body);

  const afterDelete = await fetch(`${origin}${att.url}`);
  check('删除后链接失效（404）', afterDelete.status === 404, afterDelete.status);
}

// ─────────────────────────────────────────────────────────────────
// M5-B：通知 / @提及 / 关注者
// ─────────────────────────────────────────────────────────────────
async function notificationsTests(adminToken, memberToken, memberId, workspaceId) {
  section('10. 通知中心 / @提及 / 关注者');

  // 按任务过滤通知，避免受前面用例的影响
  const countForTask = async (token, taskId) => {
    const res = await req('GET', '/me/notifications', { token, query: { limit: '100' } });
    return (res.data?.items ?? []).filter((n) => n.targetId === taskId);
  };

  // ── 指派通知 ──
  let r = await req('POST', `/workspaces/${workspaceId}/tasks`, {
    token: adminToken,
    body: { title: '通知测试任务', assigneeId: memberId },
  });
  const taskId = r.data?.task?.id;
  check('创建带负责人的任务', r.code === 0, r.body);

  let memberNotifs = await countForTask(memberToken, taskId);
  check('被指派的人收到 TASK_ASSIGNED', memberNotifs.some((n) => n.type === 'TASK_ASSIGNED'), memberNotifs);

  // ── @提及 ──
  r = await req('POST', `/workspaces/${workspaceId}/tasks/${taskId}/comments`, {
    token: adminToken,
    body: { body: '@冒烟成员 这个你看一下', mentions: [memberId] },
  });
  check('发表带 @ 的评论', r.code === 0, r.body);

  memberNotifs = await countForTask(memberToken, taskId);
  check('被 @ 的人收到 MENTION', memberNotifs.some((n) => n.type === 'MENTION'), memberNotifs);

  // 自己评论不通知自己
  const adminNotifs = await countForTask(adminToken, taskId);
  check('自己发的评论不会通知自己', adminNotifs.length === 0, adminNotifs);

  // ── 关注者：成员评论 → 创建者（自动 watcher）收到 ──
  r = await req('POST', `/workspaces/${workspaceId}/tasks/${taskId}/comments`, {
    token: memberToken,
    body: { body: '收到，我看一下' },
  });
  check('成员发表评论', r.code === 0, r.body);

  const adminAfter = await countForTask(adminToken, taskId);
  check(
    '创建者（自动关注）收到 TASK_COMMENT',
    adminAfter.some((n) => n.type === 'TASK_COMMENT'),
    adminAfter,
  );

  // ── 取消关注后不再收到 ──
  r = await req('DELETE', `/workspaces/${workspaceId}/tasks/${taskId}/watch`, { token: adminToken });
  check('取消关注成功', r.code === 0, r.body);

  const beforeUnwatch = (await countForTask(adminToken, taskId)).length;
  await req('POST', `/workspaces/${workspaceId}/tasks/${taskId}/comments`, {
    token: memberToken,
    body: { body: '再补充一句' },
  });
  const afterUnwatch = (await countForTask(adminToken, taskId)).length;
  check('取消关注后不再收到评论通知', afterUnwatch === beforeUnwatch, { beforeUnwatch, afterUnwatch });

  // ── 关注状态接口 ──
  r = await req('GET', `/workspaces/${workspaceId}/tasks/${taskId}/watchers`, { token: memberToken });
  check('关注者列表里 watching=true（评论后自动关注）', r.data?.watching === true, r.data);

  // ── 已读 / 未读数 ──
  r = await req('GET', '/me/notifications/unread-count', { token: memberToken });
  const unread = r.data?.count ?? 0;
  check('未读数大于 0', unread > 0, unread);

  const firstUnread = (await countForTask(memberToken, taskId)).find((n) => !n.read);
  if (firstUnread) {
    await req('POST', `/me/notifications/${firstUnread.id}/read`, { token: memberToken });
    r = await req('GET', '/me/notifications/unread-count', { token: memberToken });
    check('标记单条已读后未读数 -1', r.data?.count === unread - 1, { before: unread, after: r.data?.count });
  }

  await req('POST', '/me/notifications/read-all', { token: memberToken });
  r = await req('GET', '/me/notifications/unread-count', { token: memberToken });
  check('全部已读后未读数为 0', r.data?.count === 0, r.data);

  // ── 提醒时间可以保存 ──
  r = await req('GET', `/workspaces/${workspaceId}/tasks/${taskId}`, { token: adminToken });
  const version = r.data?.task?.version;

  r = await req('PATCH', `/workspaces/${workspaceId}/tasks/${taskId}`, {
    token: adminToken,
    body: { version, reminderAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  check('可以设置提醒时间', r.code === 0 && Boolean(r.data?.task?.reminderAt), r.data?.task?.reminderAt);
}

// ─────────────────────────────────────────────────────────────────
// M5-C / M5-D：增量同步 / 分享 / 智能视图 / 实时
// ─────────────────────────────────────────────────────────────────
async function syncShareRealtimeTests(adminToken, memberToken, memberId, workspaceId) {
  section('11. 增量同步 / 分享 / 智能视图 / 实时');

  // ── 增量同步 ──
  let r = await req('GET', `/workspaces/${workspaceId}/sync/changes`, { token: adminToken });
  check('不带 since 时返回当前游标', r.code === 0 && typeof r.data?.cursor === 'string', r.data);
  const baseCursor = r.data?.cursor ?? '0';

  r = await req('POST', `/workspaces/${workspaceId}/notes`, {
    token: adminToken,
    body: { title: '同步测试笔记', content: '变更日志应该记录这条' },
  });
  const noteId = r.data?.note?.id;
  check('创建笔记', r.code === 0, r.body);

  r = await req('GET', `/workspaces/${workspaceId}/sync/changes`, {
    token: adminToken,
    query: { since: baseCursor },
  });
  const changes = r.data?.changes ?? [];
  check('增量接口返回新变更', changes.length > 0, changes);
  check(
    '变更里包含刚创建的笔记',
    changes.some((c) => c.entityType === 'note' && c.entityId === noteId && c.op === 'upsert'),
    changes,
  );
  check('游标是字符串（BigInt 已序列化）', typeof changes[0]?.seq === 'string', typeof changes[0]?.seq);

  const newCursor = r.data?.cursor;
  r = await req('GET', `/workspaces/${workspaceId}/sync/changes`, {
    token: adminToken,
    query: { since: newCursor },
  });
  check('用新游标拉取没有重复变更', (r.data?.changes ?? []).length === 0, r.data);

  // ── 分享链接 ──
  r = await req('POST', `/workspaces/${workspaceId}/notes/${noteId}/share`, {
    token: adminToken,
    body: { expiresInDays: 7 },
  });
  check('创建分享链接', r.code === 0, r.body);
  const sharePath = r.data?.link?.path;
  const linkId = r.data?.link?.id;

  // path 是**前端页面**路径（/share/<token>）；读内容要走 API 前缀
  const anon = await fetch(`${originOf(BASE)}/api/v1${sharePath}`);
  const anonBody = await anon.json();
  check('分享页无需登录即可读取', anonBody.code === 0, anonBody);
  check('分享内容与笔记一致', anonBody.data?.note?.title === '同步测试笔记', anonBody.data?.note?.title);

  r = await req('DELETE', `/workspaces/${workspaceId}/share-links/${linkId}`, { token: adminToken });
  check('撤销分享链接', r.code === 0, r.body);

  const afterRevoke = await fetch(`${originOf(BASE)}/api/v1${sharePath}`);
  const afterRevokeBody = await afterRevoke.json();
  check('撤销后无法访问（40400）', afterRevokeBody.code === 40400, afterRevokeBody);

  // ── 智能视图 ──
  r = await req('POST', `/workspaces/${workspaceId}/smart-views`, {
    token: adminToken,
    body: { name: '我的收藏', filter: { view: 'starred' }, isShared: true },
  });
  check('创建智能视图', r.code === 0, r.body);
  const viewId = r.data?.view?.id;

  r = await req('GET', `/workspaces/${workspaceId}/smart-views`, { token: memberToken });
  check('共享视图对其他成员可见', (r.data?.items ?? []).some((v) => v.id === viewId), r.data);

  r = await req('PATCH', `/workspaces/${workspaceId}/smart-views/${viewId}`, {
    token: adminToken,
    body: { name: '改个名' },
  });
  check('修改智能视图', r.code === 0 && r.data?.view?.name === '改个名', r.body);

  r = await req('DELETE', `/workspaces/${workspaceId}/smart-views/${viewId}`, { token: adminToken });
  check('删除智能视图', r.code === 0, r.body);

  // ── WebSocket 实时推送 ──
  if (typeof WebSocket === 'undefined') {
    console.log('  \x1b[33m!\x1b[0m 当前 Node 没有全局 WebSocket，跳过实时推送测试');
    return;
  }

  const wsUrl = `${originOf(BASE).replace('http', 'ws')}/api/v1/ws?token=${encodeURIComponent(memberToken)}`;
  const received = [];
  const socket = new WebSocket(wsUrl);

  const opened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(true);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  check('WebSocket 可以连上', opened);

  if (opened) {
    socket.addEventListener('message', (event) => {
      try {
        received.push(JSON.parse(String(event.data)));
      } catch {
        /* ignore */
      }
    });

    // 给 admin 一个动作：把任务指派给 member → member 的 socket 应收到 notification
    await req('POST', `/workspaces/${workspaceId}/tasks`, {
      token: adminToken,
      body: { title: '实时推送测试', assigneeId: memberId },
    });

    // 等最多 3 秒
    for (let i = 0; i < 30; i += 1) {
      if (received.some((m) => m.type === 'notification')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    check(
      '收到 notification 实时事件',
      received.some((m) => m.type === 'notification'),
      received.map((m) => m.type),
    );

    socket.close();
  }

  void noteId;
}

function originOf(base) {
  return new URL(base).origin;
}

// ─────────────────────────────────────────────────────────────────
// M1 补全：站点管理 / 工作区恢复 / 幂等
// ─────────────────────────────────────────────────────────────────
async function m1CompletionTests(adminToken, memberToken, memberId, workspaceId, password) {
  section('12. 站点管理 / 工作区恢复 / 幂等');

  const memberEmail = (await req('GET', `/admin/users`, { token: adminToken, query: { q: 'member-' } })).data
    ?.items?.[0]?.email;

  // ── 站点管理 ──
  let r = await req('GET', '/admin/overview', { token: adminToken });
  check('管理员可读站点概览', r.code === 0 && (r.data?.users ?? 0) >= 2, r.data);

  r = await req('GET', '/admin/overview', { token: memberToken });
  check('普通成员访问概览被拒（40300）', r.code === 40300, r.body);

  r = await req('GET', '/admin/users', { token: adminToken, query: { q: 'member-' } });
  check('管理员可搜索用户', (r.data?.items ?? []).length >= 1, r.data);

  // ── 停用 / 启用 ──
  r = await req('PATCH', `/admin/users/${memberId}`, { token: adminToken, body: { status: 'DISABLED' } });
  check('停用用户', r.code === 0 && r.data?.user?.status === 'DISABLED', r.body);

  r = await req('GET', '/auth/me', { token: memberToken });
  check('停用后被停用者的会话立即失效', [40100, 40103].includes(r.code), r.body);

  r = await req('PATCH', `/admin/users/${memberId}`, { token: adminToken, body: { status: 'ACTIVE' } });
  check('重新启用用户', r.code === 0 && r.data?.user?.status === 'ACTIVE', r.body);

  // 停用会吊销会话，必须重新登录才能继续后面的用例
  r = await req('POST', '/auth/login', { body: { email: memberEmail, password } });
  check('重新启用后可以正常登录', r.code === 0 && typeof r.data?.accessToken === 'string', r.body);
  const refreshedMemberToken = r.data?.accessToken;

  // ── 自我保护 ──
  r = await req('GET', '/auth/me', { token: adminToken });
  const adminId = r.data?.user?.id;

  r = await req('PATCH', `/admin/users/${adminId}`, { token: adminToken, body: { status: 'DISABLED' } });
  check('管理员不能停用自己（40300）', r.code === 40300, r.body);

  r = await req('PATCH', `/admin/users/${adminId}`, { token: adminToken, body: { role: 'USER' } });
  check('管理员不能降级自己（40300）', r.code === 40300, r.body);

  // ── 重置密码 ──
  r = await req('POST', `/admin/users/${memberId}/reset-password`, { token: adminToken });
  check('管理员可重置他人密码', r.code === 0 && (r.data?.temporaryPassword?.length ?? 0) >= 10, r.body);
  const tempPassword = r.data?.temporaryPassword;

  r = await req('POST', '/auth/login', { body: { email: memberEmail, password: tempPassword } });
  check('临时密码可以登录', r.code === 0, r.body);

  // 把密码改回去，后面的退出用例还要用
  const tempToken = r.data?.accessToken;
  r = await req('POST', '/auth/password/change', {
    token: tempToken,
    body: { currentPassword: tempPassword, newPassword: password },
  });
  check('用临时密码登录后可以改回原密码', r.code === 0, r.body);

  // 改密码会吊销"其它"会话，所以能继续用的是这次登录拿到的 token
  void refreshedMemberToken;

  // ── 工作区恢复 ──
  r = await req('POST', '/workspaces', { token: adminToken, body: { name: '待删空间' } });
  const tempWorkspaceId = r.data?.workspace?.id;
  r = await req('GET', `/workspaces/${tempWorkspaceId}`, { token: adminToken });
  const tempSlug = r.data?.workspace?.slug;
  check('创建待删除的工作区', Boolean(tempWorkspaceId && tempSlug), { tempWorkspaceId, tempSlug });

  r = await req('DELETE', `/workspaces/${tempWorkspaceId}`, { token: adminToken, query: { confirm: tempSlug } });
  check('删除工作区', r.code === 0, r.body);

  r = await req('GET', '/workspaces/deleted', { token: adminToken });
  check('已删除列表里能看到', (r.data?.items ?? []).some((w) => w.id === tempWorkspaceId), r.data);

  r = await req('POST', `/workspaces/${tempWorkspaceId}/restore`, { token: adminToken });
  check('可以恢复工作区', r.code === 0, r.body);

  r = await req('GET', '/workspaces', { token: adminToken });
  check('恢复后重新出现在工作区列表', (r.data?.items ?? []).some((w) => w.id === tempWorkspaceId), r.data);

  // ── 幂等键 ──
  const idemKey = `smoke-${Date.now()}`;
  const noteBody = { title: '幂等测试笔记', content: '重复提交只应创建一条' };

  const first = await req('POST', `/workspaces/${workspaceId}/notes`, {
    token: adminToken,
    body: noteBody,
    headers: { 'idempotency-key': idemKey },
  });
  const second = await req('POST', `/workspaces/${workspaceId}/notes`, {
    token: adminToken,
    body: noteBody,
    headers: { 'idempotency-key': idemKey },
  });

  check('重复提交返回同一条笔记', first.data?.note?.id === second.data?.note?.id, {
    first: first.data?.note?.id,
    second: second.data?.note?.id,
  });
  check('幂等响应码一致', first.code === 0 && second.code === 0, { first: first.code, second: second.code });

  r = await req('GET', `/workspaces/${workspaceId}/notes`, {
    token: adminToken,
    query: { q: '幂等测试笔记' },
  });
  check('库里确实只有一条', (r.data?.items ?? []).filter((n) => n.title === '幂等测试笔记').length === 1, r.data);

  return tempToken;
}

function summarize(isAdmin) {
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`  通过 \x1b[32m${passed}\x1b[0m   失败 \x1b[31m${failed}\x1b[0m`);
  if (isAdmin === false) {
    console.log('  \x1b[33m! 首个注册用户不是 ADMIN —— 检查 FIRST_USER_IS_ADMIN 与库是否为空\x1b[0m');
  }
  if (failed > 0) {
    console.log('\n  失败项：');
    for (const f of failures) console.log(`   · ${f.name}`);
    process.exit(1);
  }
  console.log('  \x1b[32m全部通过\x1b[0m');
}

main().catch((err) => {
  console.error('\n\x1b[31m冒烟测试异常中断：\x1b[0m', err);
  process.exit(1);
});
