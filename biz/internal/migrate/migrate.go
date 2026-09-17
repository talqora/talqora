// Package migrate 用 golang-migrate 管理 schema(embed 单二进制)。
// 存量衔接:库若已被 Prisma 管理(_prisma_migrations 表存在)而 schema_migrations 不存在,
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

	// 基线衔接:Prisma 已管理过本库(有 _prisma_migrations)且 golang-migrate 尚未接管(无 schema_migrations)
	// → force 到最大版本,避免对既有表从头重放。
	prismaManaged, err := tableExists(ctx, pool, "_prisma_migrations")
	if err != nil {
		return err
	}
	gmManaged, err := tableExists(ctx, pool, "schema_migrations")
	if err != nil {
		return err
	}
	if prismaManaged && !gmManaged {
		ver, dirty, err := m.Version()
		if err != nil {
			return fmt.Errorf("读取 golang-migrate 版本失败: %w", err)
		}
		_ = ver
		_ = dirty
		// force 到已转换的存量最大版本(6 个存量迁移)
		if err := m.Force(6); err != nil {
			return fmt.Errorf("force 基线失败: %w", err)
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
