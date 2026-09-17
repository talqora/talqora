// Package migrate 用 golang-migrate 管理 schema(embed 单二进制)。
// 存量衔接:库若已被 Prisma 管理(_prisma_migrations 表存在)而 golang-migrate 尚未成功接管,
// 自动 force 到最大版本基线;全新库直接 migrate up 从头重放;此后迁移唯一入口 = golang-migrate。
package migrate

import (
	"context"
	"embed"
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5/pgxpool"
)

// prismaBaselineVersion 存量 Prisma 迁移转换后的最大版本(6 个)。
const prismaBaselineVersion = 6

// Up 应用全部 pending 迁移(带 Prisma→golang-migrate 基线自动 force 逻辑)。
// fs 由 module 根包注入(biz.MigrationsFS,含 migrations/ 子目录)。
func Up(ctx context.Context, pool *pgxpool.Pool, fs embed.FS) error {
	src, err := iofs.New(fs, "migrations")
	if err != nil {
		return err
	}
	dsn := pool.Config().ConnString()
	m, err := migrate.NewWithSourceInstance("iofs", src, dsn)
	if err != nil {
		return err
	}
	defer m.Close()

	// 1. 清理上次中断的脏状态:version 存在且 dirty → force 回退一版。
	ver, dirty, verErr := m.Version()
	if verErr == nil && dirty {
		if err := m.Force(int(ver) - 1); err != nil {
			return fmt.Errorf("清理 dirty 迁移状态失败: %w", err)
		}
	}

	// 2. 基线衔接:Prisma 已管理过本库(_prisma_migrations 存在)且 golang-migrate 尚未成功
	//    接管(schema_migrations 不存在或版本 0)→ force 到存量末尾,避免对既有表从头重放。
	prismaManaged, err := tableExists(ctx, pool, "_prisma_migrations")
	if err != nil {
		return err
	}
	if prismaManaged {
		ver, _, verErr := m.Version()
		if errors.Is(verErr, migrate.ErrNilVersion) || ver == 0 {
			if err := m.Force(prismaBaselineVersion); err != nil {
				return fmt.Errorf("force 基线失败: %w", err)
			}
		}
	}

	err = m.Up()
	if errors.Is(err, migrate.ErrNoChange) {
		return nil
	}
	return err
}

func tableExists(ctx context.Context, pool *pgxpool.Pool, name string) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx,
		"SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1)",
		name,
	).Scan(&exists)
	return exists, err
}
