import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * 已部署实例的会话夹具。
 *
 * 夹具由 `bootstrap.py` 通过公开 API 建立并落在同目录的 `.state.json`，这里只读它。
 * 每个用例需要两个独立浏览器上下文（不同账号、不同存储），因此以 context 为单位
 * 建会话，而不是复用 Playwright 默认的 `page`。
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** 预置脚本写下的夹具。 */
export interface LiveState {
  baseUrl: string;
  repoId: string;
  repoName: string;
  repoPath: string;
  defaultBranch: string;
  seedPath: string;
  roomId: string;
  roomName: string;
  users: {
    a: { username: string; password: string; full_name: string; id: string };
    b: { username: string; password: string; full_name: string; id: string };
  };
}

/**
 * 读取夹具。
 *
 * @returns 夹具内容
 * @throws Error 未运行预置脚本时给出可执行的下一步，而不是让用例在缺字段处报错
 */
export function loadState(): LiveState {
  const file = join(HERE, ".state.json");
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as LiveState;
  } catch {
    throw new Error(`缺少夹具文件 ${file}，请先执行 python e2e/live/bootstrap.py`);
  }
}

/** 一个已登录的会话。 */
export interface Session {
  context: BrowserContext;
  page: Page;
}

/**
 * 新开浏览器上下文并以指定账号登录。
 *
 * 走真实登录表单而不是注入 localStorage：令牌换发、失效处理与受保护路由
 * 都是被测链路的一部分。
 *
 * @param browser 浏览器实例
 * @param account 账号
 * @returns 已登录的上下文与页面
 */
export async function signInAs(
  browser: Browser,
  account: { username: string; password: string },
): Promise<Session> {
  const context = await browser.newContext();
  // 固定界面语言为中文：i18n 检测顺序是 localStorage > navigator，
  // 不固定的话不同开发机跑出的文案不一致
  await context.addInitScript(() => {
    window.localStorage.setItem("kustos.locale", "zh");
  });
  const page = await context.newPage();

  await page.goto("/login");
  await page.locator("#username").fill(account.username);
  await page.locator("#password").fill(account.password);
  await page.getByRole("button", { name: "使用邮箱密码登录" }).click();

  // 登录成功后进入工作台；侧栏是外壳渲染完成的信号
  await page.getByRole("navigation", { name: "仓库" }).waitFor({ timeout: 15_000 });
  return { context, page };
}

/**
 * 在侧栏选中指定仓库。
 *
 * 扁平路由下「当前仓库」来自 `repo-store`，默认取列表第一项；账号可见多个仓库时
 * 必须显式选中，否则用例会跑到别的仓库上。
 *
 * @param page 页面
 * @param repoName 仓库名
 */
export async function selectRepo(page: Page, repoName: string): Promise<void> {
  const group = page.getByRole("navigation", { name: "仓库" });
  const row = group.getByRole("button", { name: new RegExp(`^${repoName}`) }).first();
  await row.click();
  await expect(row).toHaveClass(/bg-ink-750/);
}

/**
 * 打开代码页并等待文件内容就绪。
 *
 * @param page 页面
 * @param path 仓库内文件路径
 */
export async function openFile(page: Page, path: string): Promise<void> {
  await page.goto(`/code?path=${encodeURIComponent(path)}`);
  // 只读视图由 CodeMirror 渲染；元素出现即说明 blob 已从 Git 取回
  await page.locator(".cm-content").first().waitFor({ timeout: 15_000 });
}

/**
 * 点击「协作编辑」并等待协作网关连接建立。
 *
 * @param page 页面
 * @param expectWritable 是否期望拿到写权限（决定编辑器是否可输入）
 */
export async function startCollab(page: Page, expectWritable: boolean): Promise<void> {
  await page.getByRole("button", { name: "协作编辑" }).click();
  await expect(page.getByText("协作中")).toBeVisible();
  await expect(page.getByRole("button", { name: "结束协作" })).toBeVisible();
  if (!expectWritable) {
    await expect(page.getByText("· 只读")).toBeVisible();
  }
}

/**
 * 在协作编辑器里输入文本。
 *
 * 先点一下编辑区把焦点交给 CodeMirror，再逐字符输入——直接 `fill` 不会经过
 * CodeMirror 的输入管线，Yjs 收不到增量更新。
 *
 * @param page 页面
 * @param text 要输入的文本
 */
export async function typeInCollabEditor(page: Page, text: string): Promise<void> {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.type(text, { delay: 20 });
}

/**
 * 打开房间聊天并等待实时通道连上。
 *
 * @param page 页面
 * @param roomId 房间 ID
 */
export async function openRoom(page: Page, roomId: string): Promise<void> {
  await page.goto(`/chat?room=${roomId}`);
  await expect(page.getByText("实时通道已连接")).toBeVisible();
}

/**
 * 在聊天输入框发送一条消息。
 *
 * @param page 页面
 * @param text 消息正文
 */
export async function sendChatMessage(page: Page, text: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "消息输入" });
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

/**
 * 关掉一个会话的两层资源。
 *
 * @param session 会话
 */
export async function closeSession(session: Session): Promise<void> {
  await session.context.close();
}
