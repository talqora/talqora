-- messages 按会话哈希 64 分区(V3 §4.1:单表膨胀/写入热点分散)。
-- 分区键 = conversation_id 本身(PG 对 text 的 HASH 分区,等值查询自动裁剪,业务查询零改动)。
-- 主键须含分区键:由 (id) 改为 (id, conversation_id)(仓库无任何 FK 引用 messages.id,安全)。
-- 流程:建分区表 → 64 分区 → 索引 → 回填 → 同事务原子切换 → 旧表保留可回滚(down 恢复)。

-- 1) 分区表(与 0001_initial messages 同结构,主键含分区键)
CREATE TABLE messages_partitioned (
    "id" BIGSERIAL NOT NULL,
    "conversation_id" VARCHAR(100) NOT NULL,
    "sender_id" BIGINT NOT NULL,
    "content" TEXT NOT NULL,
    "type" VARCHAR(32) NOT NULL DEFAULT 'text',
    "status" VARCHAR(32) NOT NULL DEFAULT 'sent',
    "mentions" JSONB NOT NULL DEFAULT '[]',
    "is_edited" BOOLEAN NOT NULL DEFAULT false,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "extra" JSONB NOT NULL DEFAULT '{}',
    "file_info" JSONB NOT NULL DEFAULT '{}',
    "edit_history" JSONB NOT NULL DEFAULT '[]',
    "timestamp" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "client_msg_id" VARCHAR(64),
    "seq" BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY ("id", "conversation_id")
) PARTITION BY HASH (conversation_id);

-- 2) 64 个分区
CREATE TABLE messages_p00 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 0);
CREATE TABLE messages_p01 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 1);
CREATE TABLE messages_p02 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 2);
CREATE TABLE messages_p03 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 3);
CREATE TABLE messages_p04 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 4);
CREATE TABLE messages_p05 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 5);
CREATE TABLE messages_p06 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 6);
CREATE TABLE messages_p07 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 7);
CREATE TABLE messages_p08 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 8);
CREATE TABLE messages_p09 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 9);
CREATE TABLE messages_p10 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 10);
CREATE TABLE messages_p11 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 11);
CREATE TABLE messages_p12 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 12);
CREATE TABLE messages_p13 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 13);
CREATE TABLE messages_p14 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 14);
CREATE TABLE messages_p15 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 15);
CREATE TABLE messages_p16 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 16);
CREATE TABLE messages_p17 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 17);
CREATE TABLE messages_p18 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 18);
CREATE TABLE messages_p19 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 19);
CREATE TABLE messages_p20 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 20);
CREATE TABLE messages_p21 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 21);
CREATE TABLE messages_p22 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 22);
CREATE TABLE messages_p23 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 23);
CREATE TABLE messages_p24 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 24);
CREATE TABLE messages_p25 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 25);
CREATE TABLE messages_p26 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 26);
CREATE TABLE messages_p27 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 27);
CREATE TABLE messages_p28 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 28);
CREATE TABLE messages_p29 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 29);
CREATE TABLE messages_p30 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 30);
CREATE TABLE messages_p31 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 31);
CREATE TABLE messages_p32 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 32);
CREATE TABLE messages_p33 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 33);
CREATE TABLE messages_p34 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 34);
CREATE TABLE messages_p35 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 35);
CREATE TABLE messages_p36 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 36);
CREATE TABLE messages_p37 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 37);
CREATE TABLE messages_p38 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 38);
CREATE TABLE messages_p39 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 39);
CREATE TABLE messages_p40 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 40);
CREATE TABLE messages_p41 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 41);
CREATE TABLE messages_p42 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 42);
CREATE TABLE messages_p43 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 43);
CREATE TABLE messages_p44 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 44);
CREATE TABLE messages_p45 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 45);
CREATE TABLE messages_p46 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 46);
CREATE TABLE messages_p47 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 47);
CREATE TABLE messages_p48 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 48);
CREATE TABLE messages_p49 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 49);
CREATE TABLE messages_p50 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 50);
CREATE TABLE messages_p51 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 51);
CREATE TABLE messages_p52 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 52);
CREATE TABLE messages_p53 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 53);
CREATE TABLE messages_p54 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 54);
CREATE TABLE messages_p55 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 55);
CREATE TABLE messages_p56 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 56);
CREATE TABLE messages_p57 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 57);
CREATE TABLE messages_p58 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 58);
CREATE TABLE messages_p59 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 59);
CREATE TABLE messages_p60 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 60);
CREATE TABLE messages_p61 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 61);
CREATE TABLE messages_p62 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 62);
CREATE TABLE messages_p63 PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 64, REMAINDER 63);

-- 3) 释放旧索引名(索引名 schema 级唯一,旧表 rename 不会带走索引名;
--    切换前把旧索引改挂 legacy 前缀,分区表才能复用原名称)
ALTER INDEX "idx_messages_conv_seq" RENAME TO "idx_messages_legacy_conv_seq";
ALTER INDEX "idx_messages_conv_ts" RENAME TO "idx_messages_legacy_conv_ts";
ALTER INDEX "idx_messages_sender_ts" RENAME TO "idx_messages_legacy_sender_ts";
ALTER INDEX "uniq_msg_idem" RENAME TO "uniq_msg_idem_legacy";

-- 4) 索引(分区主表建,自动传播到各分区;名称与 0001/0002 一致)
CREATE INDEX "idx_messages_conv_seq" ON messages_partitioned("conversation_id", "seq" DESC);
CREATE INDEX "idx_messages_conv_ts" ON messages_partitioned("conversation_id", "timestamp" DESC);
CREATE INDEX "idx_messages_sender_ts" ON messages_partitioned("sender_id", "timestamp" DESC);
CREATE UNIQUE INDEX "uniq_msg_idem" ON messages_partitioned("conversation_id", "sender_id", "client_msg_id");

-- 5) 回填存量(一次性 INSERT SELECT;开发库百万行级,数分钟量级)
INSERT INTO messages_partitioned (
    id, conversation_id, sender_id, content, type, status, mentions, is_edited, is_deleted,
    extra, file_info, edit_history, timestamp, created_at, updated_at, client_msg_id, seq
)
SELECT id, conversation_id, sender_id, content, type, status, mentions, is_edited, is_deleted,
    extra, file_info, edit_history, timestamp, created_at, updated_at, client_msg_id, seq
FROM messages;

-- 6) 序列对齐(新表 BIGSERIAL 独立序列)
SELECT setval(pg_get_serial_sequence('messages_partitioned', 'id'), COALESCE((SELECT max(id) FROM messages), 1));

-- 7) 原子切换(同事务;旧表保留供 down 回滚,运维确认稳定后手动清理)
ALTER TABLE messages RENAME TO messages_legacy;
ALTER TABLE messages_partitioned RENAME TO messages;
