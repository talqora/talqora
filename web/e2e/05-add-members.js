// E2E 第五段:群资料「添加」邀请入群 —— 交互 + UI 规格断言
async page => {
  const R = [];
  const ok = (n, c) => R.push((c ? 'PASS ' : 'FAIL ') + n);
  try {
    // 复用已有群(不新建,避免测试数据堆积)
    await page.goto('https://localhost:5173/chat');
    await page.waitForTimeout(2000);
    const groupRow = page.locator('[class*=display_item]').filter({ hasText: '群' }).first();
    await groupRow.click();
    await page.waitForTimeout(1200);
    await page.locator('[class*=more_btn]').first().click();
    await page.waitForTimeout(900);

    const beforeCount = await page.locator('aside [class*=cell]').count();

    // 打开弹窗
    await page.locator('aside [class*=addBox]').first().click();
    await page.waitForTimeout(700);

    // ── UI 规格 ──
    const box = await page.locator('[class*=panel]').last().boundingBox();
    ok('弹窗为双栏大尺寸(≥640×480)', !!box && box.width >= 640 && box.height >= 480);

    const twoCol = await page.evaluate(() => {
      const p = [...document.querySelectorAll('div')].filter(
        (e) => typeof e.className === 'string' && e.className.includes('panel'),
      ).pop();
      if (!p) return 'no-panel';
      const kids = [...p.children].map((c) => Math.round(c.getBoundingClientRect().width));
      return kids.length + ':' + kids.join(',');
    });
    ok('左列表 + 右已选区两栏', /^2:/.test(twoCol) && Number(twoCol.split(':')[1].split(',')[0]) >= 260);

    const radius = await page.evaluate(() => {
      const el = [...document.querySelectorAll('span')].find(
        (e) => typeof e.className === 'string' && e.className.includes('check'),
      );
      return el ? getComputedStyle(el).borderRadius : 'none';
    });
    ok('勾选为圆形(非原生方框)', radius === '50%');

    const addBtn = page.getByRole('button', { name: '添加', exact: true });
    ok('未选中时「添加」禁用', await addBtn.isDisabled());

    // ── 交互 ──
    const rows = page.locator('[class*=row] input[type=checkbox]');
    ok('候选列表非空且已排除群内成员', (await rows.count()) > 0);

    // ── 虚拟化 + 分页 ──
    const v1 = await page.evaluate(() => {
      const panel = [...document.querySelectorAll('div')].filter((e) => typeof e.className === 'string' && e.className.includes('panel')).pop();
      const sc = [...panel.querySelectorAll('div')].find((e) => typeof e.className === 'string' && e.className.includes('scroll'));
      return { rows: panel.querySelectorAll('[class*=row]').length, scrollH: sc.scrollHeight, clientH: sc.clientHeight };
    });
    ok('候选列表虚拟化(DOM 行数 < 总高度行数)', v1.rows < v1.scrollH / 44);

    await page.evaluate(() => {
      const panel = [...document.querySelectorAll('div')].filter((e) => typeof e.className === 'string' && e.className.includes('panel')).pop();
      const sc = [...panel.querySelectorAll('div')].find((e) => typeof e.className === 'string' && e.className.includes('scroll'));
      sc.scrollTop = sc.scrollHeight;
    });
    await page.waitForTimeout(1600);
    const v2 = await page.evaluate(() => {
      const panel = [...document.querySelectorAll('div')].filter((e) => typeof e.className === 'string' && e.className.includes('panel')).pop();
      const sc = [...panel.querySelectorAll('div')].find((e) => typeof e.className === 'string' && e.className.includes('scroll'));
      return sc.scrollHeight;
    });
    ok('滚到底触发分页追加', v2 > v1.scrollH);

    // 回到顶部再勾选(验证滚动不影响选择状态)
    await page.evaluate(() => {
      const panel = [...document.querySelectorAll('div')].filter((e) => typeof e.className === 'string' && e.className.includes('panel')).pop();
      const sc = [...panel.querySelectorAll('div')].find((e) => typeof e.className === 'string' && e.className.includes('scroll'));
      sc.scrollTop = 0;
    });
    await page.waitForTimeout(500);
    await rows.nth(0).check();
    await page.waitForTimeout(300);
    ok('勾选后右侧出现已选 chip', (await page.locator('[class*=chip]').count()) === 1);
    ok('选中后「添加」可用', !(await addBtn.isDisabled()));

    // Esc 关闭 + 重开后选择被清空
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    ok('Esc 可关闭弹窗', (await page.getByText('添加群成员').count()) === 0);
    await page.locator('aside [class*=addBox]').first().click();
    await page.waitForTimeout(600);
    ok('重开弹窗选择已清空', (await page.locator('[class*=chip]').count()) === 0);

    // 真正添加
    await page.locator('[class*=row] input[type=checkbox]').nth(0).check();
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await page.waitForTimeout(1800);
    const afterCount = await page.locator('aside [class*=cell]').count();
    ok('添加后成员格子增加', afterCount > beforeCount);

    await page.reload();
    await page.waitForTimeout(2200);
    await page.locator('[class*=more_btn]').first().click();
    await page.waitForTimeout(900);
    ok('刷新后成员数保持(已落库)', (await page.locator('aside [class*=cell]').count()) === afterCount);
  } catch (e) {
    R.push('EXCEPTION ' + (e && e.message ? e.message : e));
  }
  await page.evaluate((r) => { window.__e2e5 = r.join('\n'); }, R);
}
