import { expect, test } from "@playwright/test";

import {
  closeSession,
  loadState,
  openFile,
  selectRepo,
  signInAs,
  startCollab,
  typeInCollabEditor,
  type Session,
} from "./session";

/**
 * 实时协作编辑的端到端用例。
 *
 * 两个浏览器上下文分别以仓库所有者与 developer 身份进入同一个 `repo:branch:path`
 * 文档，验证 CRDT 双向同步：一侧输入，另一侧的编辑器在不刷新的情况下出现同一段文本。
 */

const state = loadState();

test.describe("实时协作编辑", () => {
  let owner: Session;
  let guest: Session;

  test.beforeEach(async ({ browser }) => {
    owner = await signInAs(browser, state.users.a);
    guest = await signInAs(browser, state.users.b);
  });

  test.afterEach(async () => {
    await closeSession(owner);
    await closeSession(guest);
  });

  test("两侧进入同一文档并互相看到在线", async () => {
    for (const session of [owner, guest]) {
      await selectRepo(session.page, state.repoName);
      await openFile(session.page, state.seedPath);
    }

    await startCollab(owner.page, true);
    await startCollab(guest.page, true);

    // awareness 人数包含自己：两端都连上后都是 2
    await expect(owner.page.getByText("2 人在线")).toBeVisible();
    await expect(guest.page.getByText("2 人在线")).toBeVisible();
  });

  test("一方输入的内容实时出现在另一方的编辑器里", async () => {
    for (const session of [owner, guest]) {
      await selectRepo(session.page, state.repoName);
      await openFile(session.page, state.seedPath);
      await startCollab(session.page, true);
    }
    await expect(guest.page.getByText("2 人在线")).toBeVisible();

    const marker = `owner-typed-${Date.now()}`;
    await typeInCollabEditor(owner.page, `\n${marker}\n`);

    // 不刷新、不重连：文本经协作网关推到另一个上下文
    await expect
      .poll(() => guest.page.locator(".cm-content").first().innerText(), { timeout: 20_000 })
      .toContain(marker);

    // 反向验证同一份文档：所有者自己也能读到对方的文本
    const reply = `guest-reply-${Date.now()}`;
    await typeInCollabEditor(guest.page, `\n${reply}\n`);

    await expect
      .poll(() => owner.page.locator(".cm-content").first().innerText(), { timeout: 20_000 })
      .toContain(reply);
  });

  test("两端内容收敛为同一份文本", async () => {
    for (const session of [owner, guest]) {
      await selectRepo(session.page, state.repoName);
      await openFile(session.page, state.seedPath);
      await startCollab(session.page, true);
    }
    await expect(guest.page.getByText("2 人在线")).toBeVisible();

    const left = `left-${Date.now()}`;
    const right = `right-${Date.now()}`;

    // 并发写入：两个上下文各自插入一段，CRDT 负责合并，不要求顺序一致
    await Promise.all([
      typeInCollabEditor(owner.page, `\n${left}\n`),
      typeInCollabEditor(guest.page, `\n${right}\n`),
    ]);

    for (const session of [owner, guest]) {
      await expect
        .poll(() => session.page.locator(".cm-content").first().innerText(), { timeout: 20_000 })
        .toContain(left);
      await expect
        .poll(() => session.page.locator(".cm-content").first().innerText(), { timeout: 20_000 })
        .toContain(right);
    }

    // CodeMirror 把远端光标的名字标签渲染成内联 widget，innerText 会带上它和
    // 零宽占位行；各自视图里出现的标签不同，直接比 innerText 必然不等。
    // 剥掉零宽字符与两侧用户名行后再比对文档正文本身
    const normalize = (text: string) =>
      text
        .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && line !== state.users.a.username && line !== state.users.b.username)
        .join("\n");
    const ownerText = await owner.page.locator(".cm-content").first().innerText();
    const guestText = await guest.page.locator(".cm-content").first().innerText();
    expect(normalize(ownerText)).toBe(normalize(guestText));
  });

  test("结束协作后回到只读视图且内容仍在", async () => {
    await selectRepo(owner.page, state.repoName);
    await openFile(owner.page, state.seedPath);
    await startCollab(owner.page, true);

    const marker = `closing-${Date.now()}`;
    await typeInCollabEditor(owner.page, `\n${marker}\n`);
    await expect
      .poll(() => owner.page.locator(".cm-content").first().innerText())
      .toContain(marker);

    await owner.page.getByRole("button", { name: "结束协作" }).click();

    // 退出后回到只读浏览，编辑器仍在（内容来自 Git，不含未保存的草稿）
    await expect(owner.page.getByRole("button", { name: "协作编辑" })).toBeVisible();
    await expect(owner.page.locator(".cm-content").first()).toBeVisible();
  });
});
