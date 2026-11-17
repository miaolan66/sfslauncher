# -*- coding: utf-8 -*-
import io
p = r'C:\Users\Administrator\Doubao\chats\2026-09-23\new-chat\sfs-launcher\renderer\styles.css'
s = io.open(p, encoding='utf-8').read()

# 1) 标题栏 logo：emoji → 新图标图片，22px
old1 = ".logo { font-size: 18px; }"
new1 = ".logo { width: 22px; height: 22px; border-radius: 4px; object-fit: cover; }"
assert old1 in s, 'logo css missing'
s = s.replace(old1, new1, 1)

# 2) 游戏卡片图标：44 → 64px（和豆包图标差不多大）
old2 = """  width: 44px; height: 44px; border-radius: 8px;
  background: linear-gradient(135deg, #2e7df6, #6a3ef6);
  display: flex; align-items: center; justify-content: center;
  font-size: 22px; flex-shrink: 0;"""
new2 = """  width: 64px; height: 64px; border-radius: 12px;
  background: linear-gradient(135deg, #2e7df6, #6a3ef6);
  display: flex; align-items: center; justify-content: center;
  font-size: 28px; flex-shrink: 0;"""
assert old2 in s, 'game-icon css missing'
s = s.replace(old2, new2, 1)

# 3) 关于页 logo：emoji → 新图标图片，96px
old3 = ".about-logo { font-size: 56px; margin-bottom: 12px; }"
new3 = ".about-logo { width: 96px; height: 96px; border-radius: 22px; object-fit: cover; margin-bottom: 12px; }"
assert old3 in s, 'about-logo css missing'
s = s.replace(old3, new3, 1)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('CSS_ICONS_OK')
