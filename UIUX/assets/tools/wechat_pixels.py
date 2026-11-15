#!/usr/bin/env python3
"""微信 UI 采样工具(纯标准库,不依赖 PIL / ImageMagick)。

用法(先 `sips -s format bmp shot.png --out shot.bmp`):

  # 1) 游程扫描:找分区边界。沿指定行/列逐像素比对色差,输出跳变点
  python3 wechat_pixels.py runs shot.bmp --y 720
  python3 wechat_pixels.py runs shot.bmp --x 1350 --tol 4

  # 2) 定点取色
  python3 wechat_pixels.py point shot.bmp 30 900 300 1000

  # 3) 包围盒:某区域内「不同于背景」的像素范围(量控件尺寸)
  python3 wechat_pixels.py bbox shot.bmp 120 100 240 240 --bg 3b3b3d

  # 4) 裁剪局部并转 PNG 供目视复核
  python3 wechat_pixels.py crop shot.bmp 600 1100 1400 340 out.bmp
  sips -s format png out.bmp --out out.png

注意:坐标一律是 BMP 的物理像素。@2x 截图请自行除以 2 得到逻辑 px。
"""

import argparse
import struct
import sys


class Bmp:
    """最小 BMP 读取器:支持 24/32bit、BI_RGB、自底向上/向下。"""

    def __init__(self, path):
        self.data = open(path, 'rb').read()
        if self.data[:2] != b'BM':
            raise SystemExit('不是 BMP 文件;sips -s format bmp in.png --out out.bmp')
        self.offset = struct.unpack_from('<I', self.data, 10)[0]
        self.width = struct.unpack_from('<i', self.data, 18)[0]
        raw_h = struct.unpack_from('<i', self.data, 22)[0]
        self.bpp = struct.unpack_from('<H', self.data, 28)[0]
        self.bypp = self.bpp // 8
        self.row_size = ((self.bpp * self.width + 31) // 32) * 4
        self.bottom_up = raw_h > 0
        self.height = abs(raw_h)

    def px(self, x, y):
        yy = (self.height - 1 - y) if self.bottom_up else y
        i = self.offset + yy * self.row_size + x * self.bypp
        b, g, r = self.data[i], self.data[i + 1], self.data[i + 2]
        return (r, g, b)

    def hx(self, x, y):
        return '#%02x%02x%02x' % self.px(x, y)


def diff(a, b):
    return max(abs(p - q) for p, q in zip(a, b))


def cmd_runs(bmp, args):
    axis, fixed = ('x', args.y) if args.y is not None else ('y', args.x)
    prev = None
    for t in (range(bmp.width) if axis == 'x' else range(bmp.height)):
        c = bmp.px(t, fixed) if axis == 'x' else bmp.px(fixed, t)
        if prev is None or diff(c, prev) > args.tol:
            print('  %s=%4d  logical=%6.1f  #%02x%02x%02x' % (axis, t, t / 2, *c))
        prev = c


def cmd_point(bmp, args):
    for i in range(0, len(args.xy), 2):
        x, y = args.xy[i], args.xy[i + 1]
        print('(%4d,%4d) logical=(%.1f,%.1f)  %s' % (x, y, x / 2, y / 2, bmp.hx(x, y)))


def cmd_bbox(bmp, args):
    if args.bg:
        bg = tuple(int(args.bg[i:i + 2], 16) for i in (0, 2, 4))
    else:
        bg = bmp.px(args.x0, args.y0)
    minx, miny, maxx, maxy = 10 ** 9, 10 ** 9, -1, -1
    for y in range(args.y0, args.y1):
        for x in range(args.x0, args.x1):
            if diff(bmp.px(x, y), bg) > args.tol:
                minx, maxx = min(minx, x), max(maxx, x)
                miny, maxy = min(miny, y), max(maxy, y)
    if maxx < 0:
        print('区域内没有与背景不同的像素')
        return
    w, h = maxx - minx + 1, maxy - miny + 1
    print('bg=#%02x%02x%02x  2x=(%d,%d)-(%d,%d)  w=%d h=%d  logical=(%.1f,%.1f) %.1fx%.1f'
          % (*bg, minx, miny, maxx, maxy, w, h, minx / 2, miny / 2, w / 2, h / 2))


def cmd_crop(bmp, args):
    x0, y0, cw, ch = args.x0, args.y0, args.w, args.h
    out_row = ((24 * cw + 31) // 32) * 4
    pixels = bytearray()
    for yy in range(ch - 1, -1, -1):  # BMP 自底向上写出
        line = bytearray()
        for xx in range(cw):
            r, g, b = bmp.px(x0 + xx, y0 + yy)
            line += bytes((b, g, r))
        line += b'\x00' * (out_row - len(line))
        pixels += line
    size = 54 + len(pixels)
    out = bytearray(b'BM') + struct.pack('<IHHI', size, 0, 0, 54)
    out += struct.pack('<IiiHHIIiiII', 40, cw, ch, 1, 24, 0, len(pixels), 2835, 2835, 0, 0)
    out += pixels
    open(args.out, 'wb').write(out)
    print('wrote %s (%dx%d)' % (args.out, cw, ch))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)

    r = sub.add_parser('runs', help='游程扫描:找分区边界')
    r.add_argument('file')
    r.add_argument('--x', type=int, help='固定列,沿 y 扫')
    r.add_argument('--y', type=int, help='固定行,沿 x 扫')
    r.add_argument('--tol', type=int, default=4, help='色差阈值(默认 4)')
    r.set_defaults(func=cmd_runs)

    pt = sub.add_parser('point', help='定点取色')
    pt.add_argument('file')
    pt.add_argument('xy', nargs='+', type=int, help='x y [x y ...]')
    pt.set_defaults(func=cmd_point)

    b = sub.add_parser('bbox', help='包围盒:量控件尺寸')
    b.add_argument('file')
    b.add_argument('x0', type=int)
    b.add_argument('y0', type=int)
    b.add_argument('x1', type=int)
    b.add_argument('y1', type=int)
    b.add_argument('--bg', help='背景色 RRGGBB;缺省取区域左上角像素')
    b.add_argument('--tol', type=int, default=10)
    b.set_defaults(func=cmd_bbox)

    c = sub.add_parser('crop', help='裁剪区域并写 24bit BMP')
    c.add_argument('file')
    c.add_argument('x0', type=int)
    c.add_argument('y0', type=int)
    c.add_argument('w', type=int)
    c.add_argument('h', type=int)
    c.add_argument('out')
    c.set_defaults(func=cmd_crop)

    args = p.parse_args()
    bmp = Bmp(args.file)
    if args.cmd == 'runs' and args.x is None and args.y is None:
        sys.exit('runs 需要 --x 或 --y')
    args.func(bmp, args)


if __name__ == '__main__':
    main()
