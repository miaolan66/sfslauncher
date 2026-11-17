'use strict';

// 毛玻璃材质参数集中配置（仅主进程使用）。
// DWM 亚克力(state4)/Aero(state3) 的底色与 tint 不透明度：alpha 越小越透。
// 白色 tint 视觉权重高于黑色；浅色 Aero 模糊弱于亚克力，深后方易把卡片压灰，
// 故浅色白霜需更厚（整窗乳白把深背景洗浅，卡片 .24 半透在乳白底上才显白净）；
// 只调材质整窗 tint，渲染端卡片/弹窗等锁定的半透 alpha 不在此改动，保持“又透又白”。
// 渲染端的动画档位策略见 renderer/app-theme.js，与本文件互不耦合。
module.exports = {
  baseColor: { dark: '#0d1117', light: '#ffffff' },
  solidColor: { dark: '#0d1117', light: '#f5f7fa' },
  tintAlpha: {
    dark: { acrylic: 0x26, aero: 0x22 },
    light: { acrylic: 0x22, aero: 0x28 } // 浅色 Aero 白霜略厚洗浅深后方；亚克力/深色整体更透
  }
};
