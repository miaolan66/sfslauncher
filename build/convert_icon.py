from PIL import Image
img = Image.open(r'C:\Users\Administrator\Doubao\chats\2026-09-23\new-chat\sfs-launcher\build\icon_source.png').convert('RGBA')
datas = img.getdata()
newData = []
for item in datas:
    if item[0] > 240 and item[1] > 240 and item[2] > 240:
        newData.append((255, 255, 255, 0))
    else:
        newData.append(item)
img.putdata(newData)
img.save(r'C:\Users\Administrator\Doubao\chats\2026-09-23\new-chat\sfs-launcher\build\icon.ico',
         sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
print('Icon converted successfully')
