-- AlterTable: @提醒旁路游标。未读 @ 判定 = mention_seq > last_read_seq,读位点推过即自动清除。
ALTER TABLE "user_conversations" ADD COLUMN "mention_seq" BIGINT NOT NULL DEFAULT 0;
