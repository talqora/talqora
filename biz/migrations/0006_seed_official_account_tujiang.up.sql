-- 测试/官方账号:涂将(id = 0),所有用户(含未来注册者)自动成为其好友。
--
-- 1) 写入 id=0 账号:用户名 = 涂将(好友列表展示的就是 username),登录密码 Tj@19970924,
--    库里存的是 bcrypt(cost 12) 散列(与 register.ts / login.ts 一致)。
-- 2) 回填:为现有所有用户与 0 建立"双向 accepted 好友 + single 会话"——
--    与 addFriend 写双向行、replyFriendReq(accepted) 建 single_<min>_<max> 会话的语义一致。
-- 3) 触发器:今后每注册一个新用户,自动与 0 建立同样的好友关系与会话。
-- 全部 ON CONFLICT DO NOTHING,可重复执行不报错;0 自身入库不触发(不自我加好友)。

-- 1) 账号本体(id 显式 0;ON CONFLICT 幂等)
INSERT INTO "users" ("id", "username", "password", "nickname", "status")
VALUES (
  0,
  '涂将',
  '$2b$12$cPk1umsZPNojotn2szMHb.Ds9ieOKQcsJsnbkEhvUmJ1rAuoyrYxW',
  '涂将',
  'offline'::"UserStatus"
)
ON CONFLICT ("id") DO NOTHING;

-- 2) 回填现有用户(双向好友 + single 会话;0 始终是较小 id,故会话固定为 single_0_<uid>)
INSERT INTO "friendships" ("user_id", "friend_id", "status")
SELECT u."id", 0, 'accepted'::"FriendshipStatus" FROM "users" u WHERE u."id" <> 0
ON CONFLICT ("user_id", "friend_id") DO NOTHING;

INSERT INTO "friendships" ("user_id", "friend_id", "status")
SELECT 0, u."id", 'accepted'::"FriendshipStatus" FROM "users" u WHERE u."id" <> 0
ON CONFLICT ("user_id", "friend_id") DO NOTHING;

INSERT INTO "conversations" ("id", "conv_type")
SELECT 'single_0_' || u."id"::text, 'single'::"ConvType" FROM "users" u WHERE u."id" <> 0
ON CONFLICT ("id") DO NOTHING;

-- 3) 新用户注册即与 0 互为好友 + 建会话
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

DROP TRIGGER IF EXISTS "trg_seed_official_friend" ON "users";
CREATE TRIGGER "trg_seed_official_friend"
AFTER INSERT ON "users"
FOR EACH ROW EXECUTE FUNCTION "seed_official_friend"();
