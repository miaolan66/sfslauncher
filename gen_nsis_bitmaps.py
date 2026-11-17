# -*- coding: utf-8 -*-
"""生成 NSIS 安装器位图：夸克风格深色侧边图 + 顶部 banner"""
from PIL import Image, ImageDraw, ImageFont
import os

out = r'C:\Users\Administrator\Doubao\chats\2026-09-23\new-chat\sfs-launcher\build'
os.makedirs(out, exist_ok=True)

# ---- 侧边图 164x314（MUI2 默认尺寸）----
W, H = 164, 314
sidebar = Image.new('RGB', (W, H))
draw = ImageDraw.Draw(sidebar)
# 深蓝→紫渐变
for y in range(H):
    r = int(18 + (70-18)*y/H)
    g = int(25 + (40-25)*y/H)
    b = int(48 + (120-48)*y/H)
    draw.line([(0,y),(W,y)], fill=(r,g,b))

# 中间画一个大圆角方块图标（模拟 SFS 蓝色图标）
cx, cy = W//2, 110
box = 44
draw.rounded_rectangle([cx-box, cy-box, cx+box, cy+box], radius=12, fill=(46,125,246))
# 图标内画火箭简笔
draw.rectangle([cx-4, cy-20, cx+4, cy+8], fill=(255,255,255))
draw.polygon([(cx-4,cy-20),(cx+4,cy-20),(cx,cy-30)], fill=(255,180,80))
draw.polygon([(cx-4,cy),(cx-14,cy+14),(cx-4,cy+14)], fill=(200,60,60))
draw.polygon([(cx+4,cy),(cx+14,cy+14),(cx+4,cy+14)], fill=(200,60,60))

# 标题文字
try:
    font_b = ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc", 16)
    font_s = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 10)
except:
    font_b = ImageFont.load_default()
    font_s = ImageFont.load_default()
draw.text((cx, 190), "SFS 启动器", fill=(255,255,255), font=font_b, anchor="mm")
draw.text((cx, 212), "Spaceflight Simulator", fill=(180,200,230), font=font_s, anchor="mm")
draw.text((cx, 228), "Launcher", fill=(150,170,200), font=font_s, anchor="mm")

sidebar.save(os.path.join(out, 'installerSidebar.bmp'), 'BMP')
print('sidebar OK', sidebar.size)

# ---- 顶部 header 150x57（MUI2）----
hw, hh = 150, 57
header = Image.new('RGB', (hw, hh), (18,25,48))
hd = ImageDraw.Draw(header)
hd.rectangle([0,0,hw,hh], fill=(18,25,48))
try:
    font_h = ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc", 12)
except:
    font_h = ImageFont.load_default()
hd.text((10, 18), "SFS 启动器", fill=(255,255,255), font=font_h)
header.save(os.path.join(out, 'installerHeader.bmp'), 'BMP')
print('header OK', header.size)

# ---- 卸载侧边图（复用）----
sidebar.save(os.path.join(out, 'uninstallerSidebar.bmp'), 'BMP')
header.save(os.path.join(out, 'uninstallerHeader.bmp'), 'BMP')
print('all done')
