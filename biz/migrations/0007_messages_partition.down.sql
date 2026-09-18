-- 回滚:恢复旧表(切换窗口后旧表内数据落后于分区表,回滚会丢切换后的新消息——down 仅在切换后立即回滚有意义)。
DROP TABLE messages;
ALTER TABLE messages_legacy RENAME TO messages;
-- 恢复旧索引名
ALTER INDEX "idx_messages_legacy_conv_seq" RENAME TO "idx_messages_conv_seq";
ALTER INDEX "idx_messages_legacy_conv_ts" RENAME TO "idx_messages_conv_ts";
ALTER INDEX "idx_messages_legacy_sender_ts" RENAME TO "idx_messages_sender_ts";
ALTER INDEX "uniq_msg_idem_legacy" RENAME TO "uniq_msg_idem";
