package repo

import "strconv"

// itoa / parseInt64 收在这里,避免各 repo 文件重复 import strconv。
func itoa(n int) string { return strconv.Itoa(n) }

func parseInt64(s string) (int64, error) { return strconv.ParseInt(s, 10, 64) }
