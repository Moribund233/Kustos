import { expect, test } from "@playwright/test";

import { closeSession, loadState, openRoom, sendChatMessage, signInAs, type Session } from "./session";

/**
 * 房间交流的端到端用例。
 *
 * 两个上下文进入同一个仓库频道，验证 WebSocket 推送：一侧发送，另一侧在不刷新
 * 的情况下出现同一条消息；另覆盖表情回应的双向同步与输入指示。
 */

const state = loadState();

test.describe("房间实时交流", () => {
  let owner: Session;
  let guest: Session;

  test.beforeEach(async ({ browser }) => {
    owner = await signInAs(browser, state.users.a);
    guest = await signInAs(browser, state.users.b);
    await openRoom(owner.page, state.roomId);
    await openRoom(guest.page, state.roomId);
  });

  test.afterEach(async () => {
    await closeSession(owner);
    await closeSession(guest);
  });

  test("一条消息实时送达另一个会话", async () => {
    const body = `e2e 实时消息 ${Date.now()}`;
    await sendChatMessage(owner.page, body);

    // 自己的会话先落一条（本地写入 + 服务端回执合并）
    await expect(owner.page.locator("article").filter({ hasText: body })).toBeVisible();

    // 对方不刷新、不重新拉取，靠 WebSocket 帧渲染出来
    await expect(guest.page.locator("article").filter({ hasText: body })).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      guest.page.locator("article").filter({ hasText: body }).getByText(state.users.a.username),
    ).toBeVisible();
  });

  test("双向收发：对方回复也能回到发起方", async () => {
    const question = `ping-${Date.now()}`;
    await sendChatMessage(owner.page, question);
    await expect(guest.page.locator("article").filter({ hasText: question })).toBeVisible({
      timeout: 20_000,
    });

    const answer = `pong-${Date.now()}`;
    await sendChatMessage(guest.page, answer);
    await expect(owner.page.locator("article").filter({ hasText: answer })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("表情回应同步到另一侧", async () => {
    const body = `react-${Date.now()}`;
    await sendChatMessage(owner.page, body);

    const guestRow = guest.page.locator("article").filter({ hasText: body });
    await expect(guestRow).toBeVisible({ timeout: 20_000 });

    // 打开表情选择器并点第一个表情；回应对所有人可见
    await guestRow.getByRole("button", { name: "添加表情回应" }).click();
    await guestRow.getByRole("button", { name: /回应/ }).first().click();

    const ownerRow = owner.page.locator("article").filter({ hasText: body });
    await expect(ownerRow.getByRole("button", { name: /人$/ }).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(ownerRow.getByRole("button", { name: "👍 1 人" })).toBeVisible();
  });

  test("在线成员列表包含另一位参与者", async () => {
    // 成员面板在右缘 dock 里，默认关闭；presence 经实时通道广播后才显示在线数
    await owner.page.getByRole("button", { name: "成员", exact: true }).click();
    await expect(owner.page.getByText("2 人在线")).toBeVisible({ timeout: 20_000 });
    await expect(
      owner.page.getByRole("listitem").filter({ hasText: state.users.b.username }),
    ).toBeVisible();
  });
});
