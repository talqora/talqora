-- 回滚:官方账号「涂将」id 10301 → 0(与 up 对称;仅用于迁移回滚,业务上不建议回到 id=0 的缺陷状态)
-- 注意:up 迁移后新注册用户已建立 single_10301_* 会话与 10301 好友关系,回滚同样按字符串/引用对称处理。

-- 1) 会话字符串迁回:single_10301_<uid> → single_0_<uid>
UPDATE "conversations" SET "id" = replace("id", 'single_10301_', 'single_0_') WHERE "id" LIKE 'single_10301\_%' ESCAPE '\';
UPDATE "user_conversations" SET "conversation_id" = replace("conversation_id", 'single_10301_', 'single_0_') WHERE "conversation_id" LIKE 'single_10301\_%' ESCAPE '\';
UPDATE "messages" SET "conversation_id" = replace("conversation_id", 'single_10301_', 'single_0_') WHERE "conversation_id" LIKE 'single_10301\_%' ESCAPE '\';

-- 2) 官方账号本体:id 10301 → 0(FK CASCADE 级联引用)
UPDATE "users" SET "id" = 0 WHERE "id" = 10301;

-- messages 无 FK,sender_id 手动迁回
UPDATE "messages" SET "sender_id" = 0 WHERE "sender_id" = 10301;

-- 3) 触发器函数恢复 0006 版本(官方 id 0、会话前缀 single_0_)
CREATE OR REPLACE FUNCTION "seed_official_friend"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" <> 0 THEN
    INSERT INTO "friendships" ("user_id", "friend_id", "status")
    VALUES
      (NEW."id", 0, 'accepted'::"FriendshipStatus"),
      (0, NEW."id", 'accepted'::"FriendshipStatus")
    ON CONFLICT ("user_id", "friend_id") DO NOTHING;

    INSERT INTO "conversations" ("id", "conv_type")
    VALUES ('single_0_' || NEW."id"::text, 'single'::"ConvType")
    ON CONFLICT ("id") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
