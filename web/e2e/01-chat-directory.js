// E2E 第一段:登录 / 会话列表 / 单聊发消息 / 通讯录两份列表
async page => {
  const R = [];
  try {
  const ok = (n, c) => R.push((c ? 'PASS ' : 'FAIL ') + n);

  // 1) 登录态
  await page.goto('https://localhost:5173/chat');
  await page.waitForTimeout(2500);
  ok('登录后进入 /chat', page.url().includes('/chat'));

  // 2) 会话列表:行存在且标题非空(回归:分页默认值 bug 曾导致标题空)
  const rows = page.locator('[class*=display_item]');
  const n = await rows.count();
  ok('会话列表有行', n > 0);
  const titles = await page.evaluate(() =>
    [...document.querySelectorAll('[class*=display_item]')].map((e) => (e.textContent || '').trim()),
  );
  ok('会话标题都非空', titles.length > 0 && titles.every((t) => t.length > 0));

  // 3) 单聊发消息
  const single = page.locator('[class*=display_item]').filter({ hasNotText: '群聊' }).first();
  await single.click();
  await page.waitForTimeout(1200);
  const before = await page.locator('[class*=bubble]').count();
  await page.locator('textarea').fill('E2E 单聊消息');
  await page.getByRole('button', { name: '发送' }).click();
  await page.waitForTimeout(1800);
  const after = await page.locator('[class*=bubble]').count();
  ok('单聊消息已发送并渲染', after > before || (await page.getByText('E2E 单聊消息').count()) > 0);

  // 4) 通讯录:新朋友展开 + 联系人虚拟列表
  await page.goto('https://localhost:5173/directory');
  await page.waitForTimeout(1600);
  ok('通讯录默认展示联系人', (await page.locator('[class*=display_item]').count()) > 0);
  await page.getByText('新朋友').first().click();
  await page.waitForTimeout(1200);
  ok('新朋友展开有数据行', (await page.locator('[class*=req_row]').count()) > 0);
  const vlistH = await page.evaluate(() => {
    const s = [...document.querySelectorAll('div')].find(
      (x) => typeof x.className === 'string' && x.className.includes('vlist'),
    );
    return s ? s.scrollHeight : 0;
  });
  const domRows = await page.locator('[class*=display_item]').count();
  ok('联系人虚拟化生效(DOM 行数远小于总高)', vlistH > 0 && domRows < vlistH / 44);

  } catch (e) { R.push('EXCEPTION ' + (e && e.message ? e.message : e)); }
  await page.evaluate((r) => { window.__e2e1 = r.join('\n'); }, R);
}
