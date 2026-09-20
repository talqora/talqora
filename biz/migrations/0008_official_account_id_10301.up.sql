-- 修复:官方账号「涂将」id 从 0 迁移到 10301(承接 26-9-20 音视频通话排查,见 docs/音视频模块/debug/)。
--
-- 背景:id=0 是业务侧"非法/未设置"哨兵值(大量校验 userID>0 / calleeID>0 依赖此约定)。
-- 官方账号占 id=0 导致三类故障(全部实测):
--   1) 登录签发 id=0 JWT,网关验签放行 userId=0 连接;
--   2) 呼叫方 to.id=0 被 callRelay 判"非法被叫"→ 音视频通话请求无法送达对端;
--   3) 触发器 seed_official_friend 写 friend_id=0 → 0 被迁走后新用户注册触发 FK 拒绝(500)。
--
-- 幂等性:26-9-20 已对存量库做过一次手工迁移(users.id/friendships/messages.sender_id),
-- 本迁移在存量库上重跑仅影响"字符串会话迁移 + 触发器函数替换"部分,其余影响 0 行,不报错;
-- 新环境从零建库(0001→0008 顺序执行)亦正确。

-- 1) 官方账号本体:id 0 → 10301。
--    friendships / user_conversations / group_members / message_refs / user_groups 的 FK
--    均为 ON UPDATE CASCADE(见 0001),此 UPDATE 自动级联迁移全部引用;
--    AFTER INSERT 触发器不受 UPDATE 触发。
UPDATE "users" SET "id" = 10301 WHERE "id" = 0;

-- messages 无 FK(分区表),sender_id 手动迁移(存量库已迁移则影响 0 行)
UPDATE "messages" SET "sender_id" = 10301 WHERE "sender_id" = 0;

-- 序列防撞:保证后续注册 id 不与官方账号冲突
SELECT setval('users_id_seq', GREATEST((SELECT COALESCE(max("id"), 1) FROM "users") + 1, 10302));

-- 2) 存量会话字符串迁移:single_0_<uid> → single_10301_<uid>
--    (会话 id 是逻辑键,含 0 的字符串会让前端解析出"用户 0"并 searchUser 失败)
UPDATE "conversations" SET "id" = replace("id", 'single_0_', 'single_10301_') WHERE "id" LIKE 'single_0\_%' ESCAPE '\';
UPDATE "user_conversations" SET "conversation_id" = replace("conversation_id", 'single_0_', 'single_10301_') WHERE "conversation_id" LIKE 'single_0\_%' ESCAPE '\';
UPDATE "messages" SET "conversation_id" = replace("conversation_id", 'single_0_', 'single_10301_') WHERE "conversation_id" LIKE 'single_0\_%' ESCAPE '\';

-- 3) 触发器函数:官方 id 改为 10301、会话前缀改为 single_10301_。
--    新用户注册自动与官方(10301)互为好友 + 建 single_10301_<uid> 会话(语义与 0006 一致)。
CREATE OR REPLACE FUNCTION "seed_official_friend"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" <> 10301 THEN
    INSERT INTO "friendships" ("user_id", "friend_id", "status")
    VALUES
      (NEW."id", 10301, 'accepted'::"FriendshipStatus"),
      (10301, NEW."id", 'accepted'::"FriendshipStatus")
    ON CONFLICT ("user_id", "friend_id") DO NOTHING;

    INSERT INTO "conversations" ("id", "conv_type")
    VALUES ('single_10301_' || NEW."id"::text, 'single'::"ConvType")
    ON CONFLICT ("id") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
