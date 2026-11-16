// E2E 第二段:建群 → 群内发消息 → ⋯ 面板 → 改群名 → 改本群昵称
async page => {
  const R = [];
  const ok = (n, c) => R.push((c ? 'PASS ' : 'FAIL ') + n);
  try {
    // 1) 建群
    await page.goto('https://localhost:5173/directory');
    await page.waitForTimeout(1600);
    await page.locator('[class*=left_header_add_user_container]').first().click();
    await page.waitForTimeout(400);
    await page.getByText('发起群聊').first().click();
    await page.waitForTimeout(600);
    const boxes = page.locator('[class*=row] input[type=checkbox]');
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await page.getByRole('button', { name: '完成' }).click();
    await page.waitForURL(/\/chat\/group_\d+/, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    ok('建群并跳转到群会话', /\/chat\/group_\d+/.test(page.url()));

    // 2) 群内发消息
    await page.locator('textarea').fill('群E2E消息');
    await page.getByRole('button', { name: '发送' }).click();
    await page.waitForTimeout(1800);
    ok('群消息已发送并渲染', (await page.getByText('群E2E消息').count()) > 0);

    // 3) ⋯ 打开群资料面板 + 成员格等宽
    await page.locator('[class*=more_btn]').first().click();
    await page.waitForTimeout(1000);
    ok('⋯ 打开右侧群资料面板', (await page.locator('aside').count()) > 0);
    const widths = await page.evaluate(() =>
      [...document.querySelectorAll('aside [class*=cell]')].slice(0, 4).map((e) => Math.round(e.getBoundingClientRect().width)),
    );
    ok('成员格四列等宽', widths.length >= 2 && Math.max(...widths) - Math.min(...widths) <= 1);

    // 4) 改群名 → 头部立即生效
    const secs = page.locator('aside [class*=section]');
    await secs.nth(0).locator('[class*=value]').click();
    await page.waitForTimeout(300);
    const newName = 'E2E群' + Date.now().toString().slice(-4);
    await secs.nth(0).locator('input').fill(newName);
    await secs.nth(0).getByRole('button', { name: '保存' }).click();
    await page.waitForTimeout(1500);
    const header = await page.locator('[class*=chat_title]').first().textContent();
    ok('改群名后头部立即显示新名', (header || '').includes(newName));

    // 5) 改我在本群的昵称 → 成员格显示
    const nick = '昵称' + Date.now().toString().slice(-3);
    await secs.nth(1).locator('[class*=value]').click();
    await page.waitForTimeout(300);
    await secs.nth(1).locator('input').fill(nick);
    await secs.nth(1).getByRole('button', { name: '保存' }).click();
    await page.waitForTimeout(1500);
    ok('本群昵称保存后成员格显示', (await page.locator('aside').getByText(nick).count()) > 0);
  } catch (e) {
    R.push('EXCEPTION ' + (e && e.message ? e.message : e));
  }
  await page.evaluate((r) => { window.__e2e2 = r.join('\n'); }, R);
}
