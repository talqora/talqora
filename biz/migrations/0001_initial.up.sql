-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('online', 'offline', 'busy', 'away', 'deleted');

-- CreateEnum
CREATE TYPE "GroupType" AS ENUM ('public', 'private');

-- CreateEnum
CREATE TYPE "FriendshipStatus" AS ENUM ('sent', 'pending', 'accepted', 'blocked');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "ConvType" AS ENUM ('single', 'group');

-- CreateEnum
CREATE TYPE "OAuthClientType" AS ENUM ('public', 'confidential');

-- CreateEnum
CREATE TYPE "OAuthCodeChallengeMethod" AS ENUM ('S256');

-- CreateTable
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "username" VARCHAR(50) NOT NULL,
    "email" VARCHAR(100),
    "phone" VARCHAR(20),
    "password" VARCHAR(255) NOT NULL,
    "nickname" VARCHAR(50),
    "avatar" VARCHAR(255),
    "bio" TEXT,
    "gender" VARCHAR(16),
    "status" "UserStatus" DEFAULT 'offline',
    "last_seen" TIMESTAMPTZ(0),
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_groups" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "avatar" VARCHAR(255),
    "owner_id" BIGINT NOT NULL,
    "max_members" INTEGER NOT NULL DEFAULT 500,
    "group_type" "GroupType" NOT NULL DEFAULT 'private',
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "friendships" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "friend_id" BIGINT NOT NULL,
    "status" "FriendshipStatus" NOT NULL DEFAULT 'pending',
    "remark" VARCHAR(64),
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friendships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "id" BIGSERIAL NOT NULL,
    "group_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'member',
    "nickname" VARCHAR(50),
    "joined_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" VARCHAR(100) NOT NULL,
    "conv_type" "ConvType" NOT NULL,
    "title" VARCHAR(100),
    "avatar" VARCHAR(255),
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_conversations" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "conversation_id" VARCHAR(100) NOT NULL,
    "last_read_message_id" VARCHAR(50),
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "is_muted" BOOLEAN NOT NULL DEFAULT false,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_refs" (
    "id" VARCHAR(50) NOT NULL,
    "conversation_id" VARCHAR(100) NOT NULL,
    "sender_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
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

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_cache" (
    "id" VARCHAR(100) NOT NULL,
    "type" VARCHAR(16),
    "title" VARCHAR(100),
    "avatar" VARCHAR(255),
    "participants" JSONB NOT NULL DEFAULT '[]',
    "last_message" JSONB,
    "total_messages" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_conversation_states" (
    "id" BIGSERIAL NOT NULL,
    "user_id" VARCHAR(64) NOT NULL,
    "conversation_id" VARCHAR(100) NOT NULL,
    "last_read_message_id" VARCHAR(50),
    "last_read_time" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "typing" BOOLEAN NOT NULL DEFAULT false,
    "typing_at" TIMESTAMPTZ(0),
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_conversation_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_info" (
    "id" VARCHAR(64) NOT NULL,
    "original_name" VARCHAR(255),
    "file_name" VARCHAR(255),
    "mime_type" VARCHAR(128),
    "size" BIGINT,
    "url" VARCHAR(512),
    "thumbnail" VARCHAR(512),
    "uploader_id" VARCHAR(64),
    "conversation_id" VARCHAR(100),
    "message_id" VARCHAR(64),
    "uploaded_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_info_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_clients" (
    "client_id" VARCHAR(64) NOT NULL,
    "client_name" VARCHAR(128) NOT NULL,
    "client_type" "OAuthClientType" NOT NULL,
    "client_secret_hash" VARCHAR(255),
    "redirect_uris" JSONB NOT NULL,
    "allowed_scopes" JSONB NOT NULL,
    "allowed_grant_types" JSONB NOT NULL,
    "token_lifetime_sec" INTEGER NOT NULL DEFAULT 900,
    "refresh_lifetime_sec" INTEGER NOT NULL DEFAULT 2592000,
    "require_pkce" BOOLEAN NOT NULL DEFAULT true,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("client_id")
);

-- CreateTable
CREATE TABLE "oauth_codes" (
    "code" VARCHAR(64) NOT NULL,
    "client_id" VARCHAR(64) NOT NULL,
    "user_id" BIGINT NOT NULL,
    "redirect_uri" VARCHAR(512) NOT NULL,
    "code_challenge" VARCHAR(128) NOT NULL,
    "code_challenge_method" "OAuthCodeChallengeMethod" NOT NULL,
    "scope" VARCHAR(512) NOT NULL,
    "nonce" VARCHAR(255),
    "expires_at" TIMESTAMPTZ(0) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_codes_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "oauth_refresh_tokens" (
    "jti" VARCHAR(64) NOT NULL,
    "family_id" VARCHAR(64) NOT NULL,
    "client_id" VARCHAR(64) NOT NULL,
    "user_id" BIGINT NOT NULL,
    "scope" VARCHAR(512) NOT NULL,
    "issued_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(0) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "rotated_to" VARCHAR(64),
    "rotated_at" TIMESTAMPTZ(0),
    "revoke_reason" VARCHAR(64),

    CONSTRAINT "oauth_refresh_tokens_pkey" PRIMARY KEY ("jti")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "unique_friendship" ON "friendships"("user_id", "friend_id");

-- CreateIndex
CREATE UNIQUE INDEX "unique_member" ON "group_members"("group_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "unique_user_conversation" ON "user_conversations"("user_id", "conversation_id");

-- CreateIndex
CREATE INDEX "idx_messages_conv_ts" ON "messages"("conversation_id", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "idx_messages_sender_ts" ON "messages"("sender_id", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "idx_user_conv_state_user" ON "user_conversation_states"("user_id");

-- CreateIndex
CREATE INDEX "idx_user_conv_state_conv" ON "user_conversation_states"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "unique_user_conv_state" ON "user_conversation_states"("user_id", "conversation_id");

-- CreateIndex
CREATE INDEX "idx_file_info_uploader" ON "file_info"("uploader_id");

-- CreateIndex
CREATE INDEX "idx_file_info_conv" ON "file_info"("conversation_id");

-- CreateIndex
CREATE INDEX "idx_oauth_codes_expires" ON "oauth_codes"("expires_at");

-- CreateIndex
CREATE INDEX "idx_oauth_codes_user" ON "oauth_codes"("user_id");

-- CreateIndex
CREATE INDEX "idx_oauth_rt_family" ON "oauth_refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "idx_oauth_rt_user_active" ON "oauth_refresh_tokens"("user_id", "revoked", "expires_at");

-- CreateIndex
CREATE INDEX "idx_oauth_rt_expires" ON "oauth_refresh_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_friend_id_fkey" FOREIGN KEY ("friend_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "user_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_conversations" ADD CONSTRAINT "user_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_conversations" ADD CONSTRAINT "user_conversations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_refs" ADD CONSTRAINT "message_refs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_refs" ADD CONSTRAINT "message_refs_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
