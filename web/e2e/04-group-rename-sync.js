// E2E 第四段:群名/昵称的"点击才进入编辑"与"改名后多处同步"
async page => {
  const R = [];
  const ok = (n, c) => R.push((c ? 'PASS ' : 'FAIL ') + n);
  try {
    // 建一个新群,避免历史数据干扰
    await page.goto('https://localhost:5173/directory');
    await page.waitForTimeout(1500);
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

    // 1) 未点击时是"显示态":aside 内只有搜索框一个 input
    await page.locator('[class*=more_btn]').first().click();
    await page.waitForTimeout(900);
    ok('默认显示态(无编辑输入框)', (await page.locator('aside input').count()) === 1);

    // 2) 点击群名 → 进入编辑态(出现输入框 + 保存 + 取消)
    const secs = page.locator('aside [class*=section]');
    const beforeName = (await secs.nth(0).locator('[class*=value]').textContent()) || '';
    await secs.nth(0).locator('[class*=value]').click();
    await page.waitForTimeout(300);
    const editInputs = await page.locator('aside [class*=editRow] input').count();
    const saveBtn = await page.locator('aside [class*=editRow]').getByRole('button', { name: '保存' }).count();
    const cancelBtn = await page.locator('aside [class*=editRow]').getByRole('button', { name: '取消' }).count();
    ok('点击后进入编辑态(输入+保存,无取消按钮)', editInputs === 1 && saveBtn === 1 && cancelBtn === 0);

    // 3) 失焦 → 自动退出编辑态且不落库
    await secs.nth(0).locator('[class*=editRow] input').fill('不该保存的名字');
    await page.locator('aside [class*=search] input').click(); // 焦点移出编辑行
    await page.waitForTimeout(500);
    const afterBlur = (await secs.nth(0).locator('[class*=value]').textContent()) || '';
    ok('失焦自动取消且不落库', afterBlur === beforeName && (await page.locator('aside [class*=editRow] input').count()) === 0);

    // 4) 改名 → 头部 + 会话列表 同时更新
    const newName = '同步群' + Date.now().toString().slice(-4);
    await secs.nth(0).locator('[class*=value]').click();
    await secs.nth(0).locator('input').fill(newName);
    await secs.nth(0).getByRole('button', { name: '保存' }).click();
    await page.waitForTimeout(1500);
    const header = (await page.locator('[class*=chat_title]').first().textContent()) || '';
    const listText = await page.locator('[class*=chat_view_left_body]').innerText();
    ok('改名后头部同步', header.includes(newName));
    ok('改名后会话列表同步', listText.includes(newName));

    // 5) 刷新(重新拉会话)后仍然是新名 → 说明 conversations.title 也更新了
    await page.reload();
    await page.waitForTimeout(2500);
    const listText2 = await page.locator('[class*=chat_view_left_body]').innerText();
    ok('刷新后群名仍为新名(库已更新)', listText2.includes(newName));

    // 6) 本群昵称:点击 → 编辑 → 保存 → 网格显示;刷新后仍在
    await page.locator('[class*=more_btn]').first().click();
    await page.waitForTimeout(900);
    const secs2 = page.locator('aside [class*=section]');
    await secs2.nth(1).locator('[class*=value]').click();
    await page.waitForTimeout(300);
    const nick = '我' + Date.now().toString().slice(-3);
    await secs2.nth(1).locator('input').fill(nick);
    await secs2.nth(1).getByRole('button', { name: '保存' }).click();
    await page.waitForTimeout(1200);
    ok('本群昵称保存后网格显示', (await page.locator('aside').getByText(nick).count()) > 0);
    await page.reload();
    await page.waitForTimeout(2200);
    await page.locator('[class*=more_btn]').first().click();
    await page.waitForTimeout(900);
    ok('刷新后本群昵称仍在', (await page.locator('aside').getByText(nick).count()) > 0);
  } catch (e) {
    R.push('EXCEPTION ' + (e && e.message ? e.message : e));
  }
  await page.evaluate((r) => { window.__e2e4 = r.join('\n'); }, R);
}
