-- 可靠性命脉迁移:会话内单调 seq + 客户端幂等键 + 已同步/已读双游标。
-- 见 docs 11(seq)、12(幂等)、13(双游标)。
-- 顺序:先加列(带默认 0)→ 回填存量 → 最后建唯一约束(回填后建,避免历史脏数据撞约束)。

-- 1) 加列
ALTER TABLE "conversations" ADD COLUMN "next_seq" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "messages" ADD COLUMN "client_msg_id" VARCHAR(64),
ADD COLUMN "seq" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "user_conversations" ADD COLUMN "last_read_seq" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "last_synced_seq" BIGINT NOT NULL DEFAULT 0;

-- 2) 回填历史消息 seq:同会话内按 (timestamp, id) 升序编号,得到连续的会话内位点。
--    id 作为次级排序键打破同秒并列,保证确定性。
WITH numbered AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY conversation_id
           ORDER BY "timestamp" ASC, id ASC
         ) AS rn
  FROM messages
)
UPDATE messages m
SET seq = numbered.rn
FROM numbered
WHERE m.id = numbered.id;

-- 3) 回填会话发号器:next_seq = 该会话当前最大 seq(下一条从 next_seq+1 取号)。
UPDATE conversations c
SET next_seq = COALESCE(sub.max_seq, 0)
FROM (
  SELECT conversation_id, MAX(seq) AS max_seq
  FROM messages
  GROUP BY conversation_id
) sub
WHERE c.id = sub.conversation_id;

-- 4) 回填已读游标:旧 last_read_message_id 存的是 Message.id(字符串),映射到其 seq;
--    映射不到(NULL 或已删)则保持 0。
UPDATE user_conversations uc
SET last_read_seq = m.seq
FROM messages m
WHERE uc.last_read_message_id IS NOT NULL
  AND uc.last_read_message_id ~ '^[0-9]+$'
  AND m.id = uc.last_read_message_id::BIGINT
  AND m.conversation_id = uc.conversation_id;

-- 5) 回填已同步游标:存量数据无 per-device 信息,基线设为该会话最大 seq
--    (假定既有用户已收到能看到的全部消息);未读 = synced - read 即从此基线起算。
UPDATE user_conversations uc
SET last_synced_seq = COALESCE(sub.max_seq, 0)
FROM (
  SELECT conversation_id, MAX(seq) AS max_seq
  FROM messages
  GROUP BY conversation_id
) sub
WHERE uc.conversation_id = sub.conversation_id;

-- 6) 建索引与唯一约束(回填后)。clientMsgId 为 NULL 的历史消息因 NULL 在唯一约束中互不相等,不冲突。
CREATE INDEX "idx_messages_conv_seq" ON "messages"("conversation_id", "seq" DESC);

CREATE UNIQUE INDEX "uniq_msg_idem" ON "messages"("conversation_id", "sender_id", "client_msg_id");
