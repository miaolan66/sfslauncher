'use strict';

/* ================================================================
 * fileTasks.js —— 在 worker 线程中执行的重文件任务
 * 解压部署 / 已装扫描 / 蓝图树 / 模组导出，规则与主进程原逻辑保持一致
 * 本模块不依赖 electron，可被 worker_threads 直接 require
 * ================================================================ */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
let iconv = null;
try { iconv = require('iconv-lite'); } catch (e) {}

// 正确解码 ZIP 内文件名：UTF-8 标志位未置位时按 GBK 解码，解决中文乱码
function entryNameOf(entry) {
  try {
    if (entry.efs) return entry.entryName;
    const buf = entry.rawEntryName;
    if (iconv && buf) return iconv.decode(buf, 'gbk');
  } catch (e) {}
  return entry.entryName;
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const dir = path.dirname(p);
  const base = path.basename(p, ext);
  let i = 1;
  while (fs.existsSync(path.join(dir, `${base}_${i}${ext}`))) i++;
  return path.join(dir, `${base}_${i}${ext}`);
}

function relPath(root, p) { return path.relative(root, p).replace(/\//g, '\\'); }

// 防 zip slip：拼接结果必须仍在 baseDir 之内，否则判定为恶意/损坏压缩包
function safeJoin(baseDir, rel) {
  const root = path.resolve(baseDir);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('压缩包内含非法路径（目录穿越），已中止导入');
  }
  return target;
}

function dirsFor(dataDir) {
  const modsDir = path.join(dataDir, 'Mods');
  return {
    modsDir,
    partsDir: path.join(modsDir, 'Custom_Assets', 'Parts'),
    texPackRoot: path.join(modsDir, 'Custom_Assets', 'Texture Packs'),
    bpDir: path.join(dataDir, 'Saving', 'Blueprints')
  };
}

function zipEntries(zipPath) {
  const zip = new AdmZip(zipPath);
  return zip.getEntries().filter(e => !e.isDirectory);
}

function detectType(zipPath) {
  try {
    const entries = zipEntries(zipPath);
    const hasBp = entries.some(e => /(^|\/)blueprints\//i.test(entryNameOf(e)));
    if (hasBp) return 'blueprint';
    const hasTex = entries.some(e => /(^|\/)textures\//i.test(entryNameOf(e)));
    if (hasTex) return 'texture';
    if (entries.some(e => /\.pack$/i.test(path.basename(entryNameOf(e))))) return 'parts';
    if (entries.some(e => /\.dll$/i.test(path.basename(entryNameOf(e))))) return 'dll';
    return 'unknown';
  } catch (e) { return 'unknown'; }
}

// ---------- 模组部署（原 deployModFile，逐行保留规则） ----------
function deploy({ zipPath, type, dataDir }) {
  const { modsDir, partsDir, texPackRoot, bpDir } = dirsFor(dataDir);
  const results = { type, files: [], target: '', errors: [] };

  const writeOne = (dest, buf) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const final = uniquePath(dest);
    fs.writeFileSync(final, buf);
    results.files.push(final);
  };

  // 非 ZIP：按所选导入类型严格校验，类型不匹配直接拒绝、不写任何文件
  if (!/\.zip$/i.test(zipPath)) {
    const buf = fs.readFileSync(zipPath);
    const base = path.basename(zipPath);
    const ext = path.extname(zipPath).toLowerCase();
    if (type === 'parts') {
      if (ext !== '.pack') throw new Error('当前是「自定义部件」导入，仅接受 .pack 文件或含 .pack 的 ZIP，类型不匹配，已取消');
      writeOne(safeJoin(partsDir, base), buf);
      results.target = partsDir;
      results.summary = `已导入部件 → Parts\\${base}`;
    } else if (type === 'dll') {
      if (ext !== '.dll') throw new Error('当前是「DLL 模组」导入，仅接受 .dll 文件或含 .dll 的 ZIP，类型不匹配，已取消');
      writeOne(safeJoin(modsDir, base), buf);
      results.target = modsDir;
      results.summary = `已导入 DLL → Mods\\${base}`;
    } else if (type === 'blueprint') {
      throw new Error('蓝图仅支持 ZIP 压缩包（内含 Blueprints 文件夹），请重新选择 ZIP 文件');
    } else if (type === 'texture') {
      throw new Error('涂装包仅支持 ZIP 压缩包（内含 textures 文件夹），请重新选择 ZIP 文件');
    } else if (ext === '.pack') {
      writeOne(safeJoin(partsDir, base), buf);
      results.target = partsDir;
      results.summary = `已导入部件 → Parts\\${base}`;
    } else if (ext === '.dll') {
      writeOne(safeJoin(modsDir, base), buf);
      results.target = modsDir;
      results.summary = `已导入 DLL → Mods\\${base}`;
    } else {
      throw new Error('无法识别文件类型，请通过对应导入按钮选择 .pack / .dll 或 ZIP 压缩包');
    }
    return results;
  }

  // ZIP：解压部署
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter(e => !e.isDirectory);

  if (type === 'parts') {
    fs.mkdirSync(partsDir, { recursive: true });
    fs.mkdirSync(modsDir, { recursive: true });
    let packed = 0, dlls = 0;
    for (const e of entries) {
      const base = path.basename(entryNameOf(e));
      if (/\.pack$/i.test(base)) { writeOne(safeJoin(partsDir, base), e.getData()); packed++; }
      else if (/\.dll$/i.test(base)) { writeOne(safeJoin(modsDir, base), e.getData()); dlls++; }
    }
    if (packed === 0) throw new Error('ZIP 中未找到 .pack 部件文件');
    results.target = partsDir;
    results.summary = `已导入 ${packed} 个部件` + (dlls ? `，${dlls} 个 DLL → Mods 根目录` : '');
  } else if (type === 'texture') {
    const hasTex = entries.some(e => /(^|\/)textures\//i.test(entryNameOf(e)));
    if (!hasTex) throw new Error('ZIP 中未找到 textures 文件夹，请确认这是涂装包');
    const packName = path.basename(zipPath, path.extname(zipPath)) || 'TexturePack';
    const packDir = uniquePath(path.join(texPackRoot, packName));
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(modsDir, { recursive: true });
    let copied = 0, dlls = 0;
    for (const e of entries) {
      const base = path.basename(entryNameOf(e));
      if (/\.dll$/i.test(base)) { writeOne(safeJoin(modsDir, base), e.getData()); dlls++; continue; }
      const segs = entryNameOf(e).split(/[\\/]/);
      const ti = segs.findIndex(s => s.toLowerCase() === 'textures');
      if (ti < 0) continue;
      const relSegs = segs.slice(ti).filter(s => s !== '');
      if (!relSegs.length || relSegs.some(s => s === '..')) throw new Error('压缩包内含非法路径，已中止导入');
      const rel = relSegs.join(path.sep);
      writeOne(safeJoin(packDir, rel), e.getData());
      copied++;
    }
    if (copied === 0) throw new Error('textures 文件夹为空或无法读取');
    results.target = packDir;
    results.summary = `涂装包已导入 → Texture Packs\\${path.basename(packDir)}` + (dlls ? `，${dlls} 个 DLL → Mods 根目录` : '');
  } else if (type === 'blueprint') {
    const hasBp = entries.some(e => /(^|\/)blueprints\//i.test(entryNameOf(e)));
    if (!hasBp) throw new Error('ZIP 中未找到 Blueprints 文件夹，请确认这是蓝图包');
    fs.mkdirSync(bpDir, { recursive: true });
    let copied = 0;
    for (const e of entries) {
      const segs = entryNameOf(e).split(/[\\/]/);
      const bi = segs.findIndex(s => s.toLowerCase() === 'blueprints');
      if (bi < 0) continue;
      // 剥掉 zip 外层目录与 Blueprints 壳，保留蓝图自身文件夹（与扫描口径一致，不拍平、不嵌套多余层级）
      const relSegs = segs.slice(bi + 1).filter(s => s !== '');
      if (!relSegs.length) continue;
      if (relSegs.some(s => s === '..')) throw new Error('压缩包内含非法路径，已中止导入');
      const rel = relSegs.join(path.sep);
      writeOne(safeJoin(bpDir, rel), e.getData());
      copied++;
    }
    if (copied === 0) throw new Error('Blueprints 文件夹为空或无法读取');
    results.target = bpDir;
    results.summary = `已导入蓝图文件夹 → Saving\\Blueprints`;
  } else if (type === 'dll') {
    fs.mkdirSync(modsDir, { recursive: true });
    let dlls = 0;
    for (const e of entries) {
      const base = path.basename(entryNameOf(e));
      if (/\.dll$/i.test(base)) { writeOne(safeJoin(modsDir, base), e.getData()); dlls++; }
    }
    if (dlls === 0) throw new Error('ZIP 中未找到 .dll 文件');
    results.target = modsDir;
    results.summary = `已导入 ${dlls} 个 DLL → Mods 根目录`;
  } else {
    throw new Error('无法识别模组类型，请手动选择：部件 / 涂装包 / 蓝图');
  }
  return results;
}

// 游戏原版自带、不计入“已安装模组”的内置目录（Mods 根下，小写匹配，可按需扩展）
const BUILTIN_MOD_DIRS = ['custommusic'];

// ---------- 扫描已安装内容（原 mod:scanInstalled 的文件遍历部分） ----------
function scanInstalled(dataDir) {
  const found = [];
  const walkDir = (dir, exts) => {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) out.push(...walkDir(p, exts));
        else if (exts.test(name)) out.push(p);
      } catch (e) {}
    }
    return out;
  };
  // .pack 部件
  for (const p of walkDir(path.join(dataDir, 'Mods', 'Custom_Assets', 'Parts'), /\.(pack)$/i)) {
    found.push({ type: 'parts', abs: p, rel: relPath(dataDir, p), name: path.basename(p) });
  }
  // .dll（Mods 根的单独记录；子文件夹内的连同整个文件夹记录）
  const modsDir = path.join(dataDir, 'Mods');
  if (fs.existsSync(modsDir)) {
    for (const name of fs.readdirSync(modsDir)) {
      const p = path.join(modsDir, name);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) {
          if (name === 'Custom_Assets') continue;
          if (BUILTIN_MOD_DIRS.includes(name.toLowerCase())) continue;
          const dlls = [];
          const walk = (d) => {
            for (const n of fs.readdirSync(d)) {
              const fp = path.join(d, n);
              try { if (fs.statSync(fp).isDirectory()) walk(fp); else if (/\.dll$/i.test(n)) dlls.push(fp); } catch (e) {}
            }
          };
          walk(p);
          if (dlls.length) {
            const allFiles = walkDir(p, /.+/);
            found.push({ type: 'dll', abs: p, rel: relPath(dataDir, p), name: name + ' (模组)', files: allFiles });
          }
        } else if (/\.dll$/i.test(name)) {
          found.push({ type: 'dll', abs: p, rel: relPath(dataDir, p), name: name });
        }
      } catch (e) {}
    }
  }
  // 涂装包：每个子目录一个
  const texRoot = path.join(dataDir, 'Mods', 'Custom_Assets', 'Texture Packs');
  if (fs.existsSync(texRoot)) {
    for (const name of fs.readdirSync(texRoot)) {
      const p = path.join(texRoot, name);
      try {
        if (fs.statSync(p).isDirectory()) {
          const files = walkDir(p, /.+/);
          found.push({ type: 'texture', abs: p, rel: relPath(dataDir, p), name: name + ' (涂装包)', files });
        }
      } catch (e) {}
    }
  }
  // 蓝图：只扫 Blueprints 下的文件夹（不扫根目录零散 txt/json）
  const bpDir = path.join(dataDir, 'Saving', 'Blueprints');
  if (fs.existsSync(bpDir)) {
    for (const name of fs.readdirSync(bpDir)) {
      const p = path.join(bpDir, name);
      try {
        if (fs.statSync(p).isDirectory()) {
          const files = walkDir(p, /\.(txt|json)$/i);
          if (files.length) {
            found.push({ type: 'blueprint', abs: p, rel: relPath(dataDir, p), name: name + ' (蓝图)', files });
          }
        }
      } catch (e) {}
    }
  }
  // 扩展包：Custom Solar Systems 下必须同时含 Heightmap Data / Planet Data / Texture Data 的文件夹
  const cspRoot = path.join(dataDir, 'Spaceflight Simulator_Data', 'Custom Solar Systems');
  if (fs.existsSync(cspRoot)) {
    for (const name of fs.readdirSync(cspRoot)) {
      const p = path.join(cspRoot, name);
      try {
        if (!fs.statSync(p).isDirectory()) continue;
        const subs = fs.readdirSync(p).filter(s => fs.statSync(path.join(p, s)).isDirectory())
          .map(s => s.replace(/\s+/g, '').toLowerCase());
        const norm = new Set(subs);
        const ok = ['heightmapdata', 'planetdata', 'texturedata'].every(n => norm.has(n));
        if (ok) {
          const files = walkDir(p, /.+/);
          found.push({ type: 'solar', abs: p, rel: relPath(dataDir, p), name: name + ' (扩展包)', files });
        }
      } catch (e) {}
    }
  }
  return found;
}

// ---------- 蓝图文件夹树 ----------
function blueprintTree(dataDir) {
  const bpDir = path.join(dataDir, 'Saving', 'Blueprints');
  if (!fs.existsSync(bpDir)) return { success: true, root: null };
  const buildTree = (dir, rel) => {
    const children = [];
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        const childRel = rel ? rel + '/' + name : name;
        if (st.isDirectory()) {
          children.push({ name, type: 'dir', rel: childRel, children: buildTree(p, childRel) });
        } else if (/\.(txt|json)$/i.test(name)) {
          children.push({ name, type: 'file', rel: childRel });
        }
      } catch (e) {}
    }
    children.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name, 'zh'));
    return children;
  };
  return { success: true, root: { name: 'Blueprints', type: 'dir', rel: 'Saving/Blueprints', children: buildTree(bpDir, 'Saving/Blueprints') } };
}

// ---------- 模组导出为 zip ----------
function exportZip({ dataDir, entry, outPath }) {
  const zip = new AdmZip();
  const srcs = [];
  const root = dataDir;
  const rootResolved = path.resolve(root);
  const insideRoot = (p) => {
    const abs = path.resolve(p);
    return abs === rootResolved || abs.startsWith(rootResolved + path.sep);
  };
  if (entry.target) {
    const t = path.isAbsolute(entry.target) ? entry.target : path.join(root, entry.target);
    if (insideRoot(t) && fs.existsSync(t) && fs.statSync(t).isDirectory()) srcs.push({ abs: t, rel: path.basename(t) });
  }
  if (!srcs.length && Array.isArray(entry.files)) {
    for (const rel of entry.files) {
      const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
      if (insideRoot(abs) && fs.existsSync(abs)) srcs.push({ abs, rel: path.basename(abs) });
    }
  }
  if (!srcs.length) throw new Error('找不到模组源文件');
  for (const s2 of srcs) {
    const st = fs.statSync(s2.abs);
    if (st.isDirectory()) zip.addLocalFolder(s2.abs, s2.rel);
    else zip.addFile(s2.rel, fs.readFileSync(s2.abs));
  }
  zip.writeZip(outPath);
  return { success: true, path: outPath };
}

module.exports = { detectType, deploy, scanInstalled, blueprintTree, exportZip };
