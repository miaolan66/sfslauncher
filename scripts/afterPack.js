'use strict';

const path = require('path');
const fs = require('fs');

module.exports = async function afterPack(context) {
  try {
    const { appOutDir, packager } = context;
    const productName = packager.appInfo.productFilename || 'SFS启动器';
    const exePath = path.join(appOutDir, productName + '.exe');
    if (!fs.existsSync(exePath)) { console.log('AFTERPACK_SKIP'); return; }
    const rceditMod = require('rcedit');
    const rcedit = typeof rceditMod === 'function' ? rceditMod : rceditMod.rcedit;
    const buildDir = packager.info.buildResourcesDir || packager.buildResourcesDir;
    const iconPath = path.join(buildDir, 'icon.ico');
    const version = packager.appInfo.version || '1.2.0';
    // rcedit 写 exe 资源时若目标文件仍被安全软件/上层工具短暂占用，会报
    // "Unable to commit changes"，这里退避重试几次再判定失败
    const opts = {
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      'version-string': {
        ProductName: 'SFS启动器',
        FileDescription: 'SFS Launcher',
        CompanyName: 'ml / a future star',
        LegalCopyright: 'MIT',
        OriginalFilename: productName + '.exe',
        ProductVersion: version,
        FileVersion: version,
        InternalName: productName,
        Comments: ''
      }
    };
    let ok = false, lastErr = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await rcedit(exePath, opts);
        ok = true;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    console.log(ok ? 'AFTERPACK_RCEDIT_OK' : ('AFTERPACK_WARN ' + (lastErr && lastErr.message)));
  } catch (e) {
    console.log('AFTERPACK_WARN ' + e.message);
  }
};
