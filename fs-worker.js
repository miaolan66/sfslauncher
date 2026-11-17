'use strict';

/* fs-worker.js —— 后台线程：执行解压/扫描/导出等重文件任务，避免主界面未响应 */
const { parentPort } = require('worker_threads');
const fs = require('fs');
const tasks = require('./fileTasks');

const handlers = {
  detectType: (a) => tasks.detectType(a.zipPath),
  deploy: (a) => tasks.deploy(a),
  scanInstalled: (a) => tasks.scanInstalled(a.dataDir),
  blueprintTree: (a) => tasks.blueprintTree(a.dataDir),
  exportZip: (a) => tasks.exportZip(a),
  // 递归删除（蓝图大文件夹等）放后台线程，避免阻塞主进程导致界面未响应
  removePath: (a) => fs.promises.rm(a.path, { recursive: true, force: true }).then(() => ({ success: true }))
};

parentPort.on('message', async (m) => {
  try {
    const fn = handlers[m.task];
    if (!fn) throw new Error('未知任务：' + m.task);
    const r = await fn(m.arg);
    parentPort.postMessage({ id: m.id, ok: true, r });
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, err: (e && e.message) || String(e) });
  }
});
