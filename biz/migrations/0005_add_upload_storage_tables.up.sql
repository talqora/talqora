-- CreateTable
CREATE TABLE "uploaded_files" (
    "id" BIGSERIAL NOT NULL,
    "md5" VARCHAR(32) NOT NULL,
    "object_key" VARCHAR(512) NOT NULL,
    "size" BIGINT NOT NULL,
    "mime_type" VARCHAR(128),
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploaded_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_sessions" (
    "id" BIGSERIAL NOT NULL,
    "file_id" VARCHAR(255) NOT NULL,
    "upload_id" VARCHAR(255) NOT NULL,
    "object_key" VARCHAR(512) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(128),
    "total_chunks" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uploaded_files_md5_key" ON "uploaded_files"("md5");

-- CreateIndex
CREATE UNIQUE INDEX "upload_sessions_file_id_key" ON "upload_sessions"("file_id");
