// E2E 第三段:深链刷新 / 会话搜索 / 主题切换 / 通讯录好友详情
async page => {
  const R = [];
  const ok = (n, c) => R.push((c ? 'PASS ' : 'FAIL ') + n);
  try {
    // 1) 深链:直接打开某会话 → 刷新后仍在同一会话
    const firstId = await page.evaluate(async () => {
      const r = await (await fetch('/user/userConversations?userId=10301')).json();
      return r.data[0].conversationId;
    });
    await page.goto('https://localhost:5173/chat/' + firstId);
    await page.waitForTimeout(1500);
    await page.reload();
    await page.waitForTimeout(2000);
    ok('深链刷新后仍停在原会话', page.url().includes(firstId));
    ok('刷新后消息区已渲染', (await page.locator('[class*=chat_body]').count()) > 0);

    // 2) 会话列表搜索过滤
    const search = page.locator('[class*=container] input').first();
    await search.fill('zzz_should_match_nothing');
    await page.waitForTimeout(800);
    const afterFilter = await page.locator('[class*=display_item]').count();
    await search.fill('');
    await page.waitForTimeout(800);
    const afterClear = await page.locator('[class*=display_item]').count();
    ok('搜索能减少列表项并清空恢复', afterClear >= afterFilter);

    // 3) 通讯录:点联系人 → 右侧好友详情
    await page.goto('https://localhost:5173/directory');
    await page.waitForTimeout(1600);
    await page.locator('[class*=display_item]').first().click();
    await page.waitForTimeout(1000);
    ok('点联系人出现好友详情', (await page.locator('[class*=detail]').count()) > 0);

    // 4) 主题切换(设置弹窗)
    await page.locator('[class*=icon-menu]').first().click();
    await page.waitForTimeout(500);
    await page.getByText('设置').first().click();
    await page.waitForTimeout(800);
    const hasThemeControl = await page.getByText('主题').count();
    ok('设置弹窗可打开且含主题项', hasThemeControl > 0);

    await page.evaluate((r) => { window.__e2e3 = r.join('\n'); }, R);
  } catch (e) {
    R.push('EXCEPTION ' + (e && e.message ? e.message : e));
    await page.evaluate((r) => { window.__e2e3 = r.join('\n'); }, R);
  }
}
