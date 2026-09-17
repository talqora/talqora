-- CreateTable
CREATE TABLE "device_sync_state" (
    "user_id" BIGINT NOT NULL,
    "device_id" VARCHAR(64) NOT NULL,
    "conversation_id" VARCHAR(100) NOT NULL,
    "last_synced_seq" BIGINT NOT NULL DEFAULT 0,
    "last_heartbeat" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_sync_state_pkey" PRIMARY KEY ("user_id","device_id","conversation_id")
);

