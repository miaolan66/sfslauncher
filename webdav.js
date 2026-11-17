'use strict';
// 极简 WebDAV 客户端（坚果云等标准 WebDAV）：流式上传/下载，不依赖第三方库
const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

function authHeader(cfg) {
  return 'Basic ' + Buffer.from((cfg.user || '') + ':' + (cfg.pass || '')).toString('base64');
}

function request(method, urlStr, cfg, { headers = {}, bodyStream = null, outFile = null, maxRedirect = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('WebDAV 地址格式不正确')); }
    const lib = u.protocol === 'http:' ? http : https;
    const opt = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: Object.assign({ Authorization: authHeader(cfg), 'User-Agent': 'SFS-Launcher' }, headers)
    };
    const req = lib.request(opt, (res) => {
      // 重定向跟随
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirect > 0) {
        res.resume();
        const next = new URL(res.headers.location, urlStr).toString();
        return resolve(request(method === 'PUT' && res.statusCode === 303 ? 'POST' : method, next, cfg,
          { headers, bodyStream, outFile, maxRedirect: maxRedirect - 1 }));
      }
      if (outFile) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const ws = fs.createWriteStream(outFile);
          res.pipe(ws);
          ws.on('finish', () => ws.close((e) => e ? reject(e) : resolve({ status: res.statusCode, headers: res.headers })));
          ws.on('error', reject);
        } else {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode));
        }
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('WebDAV 请求超时')));
    if (bodyStream) {
      bodyStream.on('error', (e) => req.destroy(e));
      bodyStream.pipe(req);
    } else {
      req.end();
    }
  });
}

async function ensureCollection(cfg, baseUrl) {
  // 尝试 MKCOL 创建目录（已存在通常返回 405，视为成功）
  try {
    const r = await request('MKCOL', baseUrl, cfg, {});
    if (r.status === 201 || r.status === 405 || r.status === 301) return true;
  } catch (e) { /* 部分服务端不允许 MKCOL，忽略 */ }
  return true;
}

async function test(cfg) {
  if (!cfg.url) throw new Error('未填写服务器地址');
  const r = await request('PROPFIND', cfg.url.replace(/\/+$/, '') + '/', cfg, {
    headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
    bodyStream: null
  });
  // PROPFIND 需要 body；改用下面的 list 校验
  await list(cfg);
  return r.status;
}

async function list(cfg) {
  const base = cfg.url.replace(/\/+$/, '') + '/';
  const propfind = '<?xml version="1.0" encoding="utf-8"?>' +
    '<propfind xmlns="DAV:"><prop><getcontentlength/><getlastmodified/><resourcetype/></prop></propfind>';
  const { Readable } = require('stream');
  const r = await request('PROPFIND', base, cfg, {
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    bodyStream: Readable.from([Buffer.from(propfind)])
  });
  if (r.status < 200 || r.status >= 300) throw new Error('连接失败 HTTP ' + r.status + '（检查地址/账号/密码）');
  const xml = r.body.toString('utf8');
  const items = [];
  const reResp = /<(?:\w+:)?response[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/gi;
  let m;
  while ((m = reResp.exec(xml)) !== null) {
    const block = m[1];
    const hm = block.match(/<(?:\w+:)?href[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/i);
    if (!hm) continue;
    let href = hm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    let name;
    try { name = decodeURIComponent(href.split('/').filter(Boolean).pop() || ''); }
    catch { name = href.split('/').filter(Boolean).pop() || ''; }
    if (!/\.zip$/i.test(name)) continue;
    const isCollection = /<(?:\w+:)?collection\s*\/?>/i.test(block);
    if (isCollection) continue;
    const lm = block.match(/<(?:\w+:)?getcontentlength[^>]*>(\d+)</i);
    const tm = block.match(/<(?:\w+:)?getlastmodified[^>]*>([\s\S]*?)<\/(?:\w+:)?getlastmodified>/i);
    items.push({
      name,
      size: lm ? parseInt(lm[1], 10) : 0,
      time: tm ? Date.parse(tm[1]) || 0 : 0
    });
  }
  return items.sort((a, b) => b.time - a.time);
}

async function upload(cfg, localPath, remoteName, onProgress) {
  await ensureCollection(cfg, cfg.url.replace(/\/+$/, '') + '/');
  const url = cfg.url.replace(/\/+$/, '') + '/' + encodeURIComponent(remoteName).replace(/%2F/gi, '/');
  const stat = fs.statSync(localPath);
  let sent = 0;
  const rs = fs.createReadStream(localPath);
  rs.on('data', (c) => { sent += c.length; if (onProgress) onProgress(sent, stat.size); });
  const r = await request('PUT', url, cfg, {
    headers: { 'Content-Length': stat.size, 'Content-Type': 'application/zip' },
    bodyStream: rs
  });
  if (r.status < 200 || r.status >= 300) throw new Error('上传失败 HTTP ' + r.status);
  return true;
}

async function download(cfg, remoteName, outFile) {
  const url = cfg.url.replace(/\/+$/, '') + '/' + encodeURIComponent(remoteName);
  const r = await request('GET', url, cfg, { outFile });
  return r.status;
}

async function remove(cfg, remoteName) {
  const url = cfg.url.replace(/\/+$/, '') + '/' + encodeURIComponent(remoteName);
  const r = await request('DELETE', url, cfg, {});
  if (!(r.status >= 200 && r.status < 300) && r.status !== 404) throw new Error('删除失败 HTTP ' + r.status);
  return true;
}

module.exports = { test, list, upload, download, remove };
