/**
 * 小智音乐固件 - 网易云音乐桥接服务
 *
 * 对设备提供与固件兼容的 /stream_pcm 接口：
 *   GET /stream_pcm?song=歌名&artist=歌手
 *     -> {"artist":"..","title":"..","audio_url":"..","lyric_url":".."}
 *
 * 内部依赖 NeteaseCloudMusicApi（同进程启动在 127.0.0.1:3000）。
 * 通过环境变量 NETEASE_COOKIE 传入网易云登录 cookie，才能播放会员歌曲。
 */
const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 10000);
const NCM_PORT = Number(process.env.NCM_PORT || 3000);
const COOKIE = (process.env.NETEASE_COOKIE || '').trim();
const LEVEL = process.env.LEVEL || 'exhigh';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** 调用本机的 NeteaseCloudMusicApi */
async function ncm(apiPath, params = {}) {
  const u = new URL('http://127.0.0.1:' + NCM_PORT + apiPath);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  }
  if (COOKIE) u.searchParams.set('cookie', COOKIE);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(u, { signal: ctrl.signal });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function clean(s) {
  return (s || '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function baseTitle(name) {
  return clean(name).replace(/[（(\[【].*?[)）\]】]/g, '').trim();
}

const BAD = ['伴奏', '纯音乐', '钢琴版', '吉他版', 'DJ版', 'dj版', '铃声',
  '片段', '串烧', '组曲', 'medley', '演唱会', '现场', '翻唱', 'cover',
  'Cover', 'remix', 'Remix', '连播', '合辑', 'KTV', 'ktv'];

function score(song, artist) {
  return (it) => {
    const name = clean(it.name);
    const base = baseTitle(name);
    const artists = (it.artists || it.ar || []).map(a => a.name).join('/');
    let s = 0;
    if (base === song) s += 300;
    else if (name === song) s += 240;
    else if (base.startsWith(song) || song.indexOf(base) === 0) s += 80;
    else if (base.includes(song) || song.includes(base)) s += 40;
    else s -= 120;
    if (artist) s += artists.includes(artist) ? 150 : -100;
    const hitBad = BAD.some(w => name.includes(w));
    if (hitBad && !BAD.some(w => song.includes(w))) s -= 220;
    return s;
  };
}

/** 搜索并挑出最可能的原曲候选（按分数降序，取前几个逐个试直链） */
async function findCandidates(song, artist) {
  const kw = artist ? song + ' ' + artist : song;
  const r = await ncm('/search', { keywords: kw, limit: 30 });
  let songs = (r.result && r.result.songs) || [];
  if (!songs.length && artist) {
    const r2 = await ncm('/search', { keywords: song, limit: 30 });
    songs = (r2.result && r2.result.songs) || [];
  }
  const sc = score(song, artist);
  return songs
    .map(s => ({ s, v: sc(s) }))
    .filter(x => x.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, 5)
    .map(x => x.s);
}

async function resolveUrl(id) {
  for (const api of ['/song/url/v1', '/song/url']) {
    try {
      const r = await ncm(api, api.endsWith('v1') ? { id, level: LEVEL } : { id });
      const d = (r.data || [])[0];
      if (d && d.url) return d.url;
    } catch (e) {
      log('[url]', api, 'error', e.message);
    }
  }
  return null;
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf-8');
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
}

async function handleStreamPcm(req, res, q) {
  const song = clean(q.get('song') || '').replace(/[《》"“”]/g, '');
  const artist = clean(q.get('artist') || '');
  if (!song) return send(res, 400, JSON.stringify({ error: 'missing song' }));

  log('[query]', JSON.stringify(song), JSON.stringify(artist));

  let cands = [];
  try {
    cands = await findCandidates(song, artist);
  } catch (e) {
    log('[search] failed', e.message);
    return send(res, 200, JSON.stringify({ artist: '', title: '', audio_url: '', lyric_url: '' }));
  }

  if (!cands.length) {
    log('[query] no candidate');
    return send(res, 200, JSON.stringify({ artist: '', title: '', audio_url: '', lyric_url: '' }));
  }

  for (const s of cands) {
    const url = await resolveUrl(s.id);
    if (!url) continue;
    const host = req.headers.host || 'localhost';
    const proto = req.headers['x-forwarded-proto']
      ? req.headers['x-forwarded-proto'].split(',')[0].trim()
      : 'http';
    const b64 = Buffer.from(url).toString('base64url');
    const audioUrl = `${proto}://${host}/audio?u=${b64}`;
    const lyricUrl = `${proto}://${host}/lyric?id=${s.id}`;
    const artistName = (s.artists || s.ar || []).map(a => a.name).join('/');
    log('[query] hit', s.id, clean(s.name), '|', artistName);
    return send(res, 200, JSON.stringify({
      artist: artistName,
      title: clean(s.name),
      audio_url: audioUrl,
      lyric_url: lyricUrl,
    }, null, 0));
  }

  log('[query] candidates found but none playable');
  const first = cands[0];
  return send(res, 200, JSON.stringify({
    artist: (first.artists || first.ar || []).map(a => a.name).join('/'),
    title: clean(first.name),
    audio_url: '',
    lyric_url: '',
  }));
}

async function handleAudio(req, res, q) {
  const b64 = q.get('u') || '';
  if (!b64) return send(res, 400, 'missing u', 'text/plain');
  let target;
  try {
    target = Buffer.from(b64, 'base64url').toString('utf-8');
  } catch {
    return send(res, 400, 'bad u', 'text/plain');
  }
  try {
    const r = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return send(res, 502, 'upstream ' + r.status, 'text/plain');
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    log('[audio] error', e.message);
    try { res.destroy(); } catch {}
  }
}

async function handleLyric(req, res, q) {
  const id = q.get('id') || '';
  if (!id) return send(res, 404, '', 'text/plain');
  try {
    const r = await ncm('/lyric', { id });
    const lrc = (r.lrc && r.lrc.lyric) || '';
    if (!lrc) return send(res, 404, '', 'text/plain');
    return send(res, 200, lrc, 'text/plain; charset=utf-8');
  } catch {
    return send(res, 404, '', 'text/plain');
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;
  try {
    if (p === '/health') return send(res, 200, 'ok', 'text/plain');
    if (p === '/stream_pcm') return await handleStreamPcm(req, res, u.searchParams);
    if (p === '/audio') return await handleAudio(req, res, u.searchParams);
    if (p === '/lyric') return await handleLyric(req, res, u.searchParams);
    return send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    log('[fatal]', e.stack || e.message);
    try { send(res, 500, 'error', 'text/plain'); } catch {}
  }
});

async function main() {
  log('starting NeteaseCloudMusicApi on', NCM_PORT, '| cookie:', COOKIE ? 'yes' : 'no');
  try {
    const generateConfig = require('NeteaseCloudMusicApi/generateConfig');
    await generateConfig();
  } catch (e) {
    log('generateConfig skipped:', e.message);
  }
  const { serveNcmApi } = require('NeteaseCloudMusicApi');
  serveNcmApi({ port: NCM_PORT, checkVersion: false });

  await new Promise(r => setTimeout(r, 1500));

  server.listen(PORT, '0.0.0.0', () => {
    log('bridge listening on', PORT);
    log('health: /health   stream: /stream_pcm?song=&artist=');
  });
}

main().catch(e => {
  console.error('startup failed', e);
  process.exit(1);
});
