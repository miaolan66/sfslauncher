# -*- coding: utf-8 -*-
"""生成圆角图标：从高清源图生成 256/128/64/48/32/16 各尺寸圆角 PNG + ICO"""
import os
from PIL import Image, ImageDraw

BASE = r'C:\Users\Administrator\Doubao\chats\2026-09-23\new-chat\sfs-launcher'
SRC = os.path.join(BASE, 'renderer', 'assets', 'user-icon.png')   # 高清源图 101515B
if not os.path.exists(SRC):
    SRC = os.path.join(BASE, 'build', 'icon.png')

RADIUS_RATIO = 0.20  # 圆角半径 = 边长 * 20%

def rounded(src_path, size, radius_ratio):
    im = Image.open(src_path).convert('RGBA')
    # 先等比缩放到目标尺寸
    im = im.resize((size, size), Image.LANCZOS)
    r = int(size * radius_ratio)
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(im, (0, 0), mask)
    return out

sizes = [256, 128, 64, 48, 32, 16]
pngs = {s: rounded(SRC, s, RADIUS_RATIO) for s in sizes}

# build/icon.png (256, 供 builder 用) 与 build/icon.ico
pngs[256].save(os.path.join(BASE, 'build', 'icon.png'))
pngs[256].save(os.path.join(BASE, 'build', 'icon.ico'), sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])

# renderer 用图标
pngs[64].save(os.path.join(BASE, 'renderer', 'assets', 'user-icon.png'))    # 标题栏/关于 logo 统一 64 源
pngs[64].save(os.path.join(BASE, 'renderer', 'assets', 'game-icon.png'))    # 游戏卡片图标（CSS 会放大到 64，源 64 足够）
pngs[32].save(os.path.join(BASE, 'renderer', 'assets', 'tray-icon.png'))    # 托盘 32x32
pngs[64].save(os.path.join(BASE, 'assets', 'user-icon.png'))                # 项目根 assets 备份

# 桌面快捷方式额外资源
pngs[48].save(os.path.join(BASE, 'build', 'icon-48.png'))
pngs[32].save(os.path.join(BASE, 'build', 'icon-32.png'))

print('ICONS_ROUNDED_OK')
