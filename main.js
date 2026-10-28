// Fix EMFILE (too many open files) during Minecraft asset download
try { require('graceful-fs').gracefulify(require('fs')); } catch (e) { console.warn('graceful-fs missing, run: npm install'); }
const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, net } = require('electron');
const { execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Client, Authenticator } = require('minecraft-launcher-core');
/* ---- saved launcher preferences (mirrored from the UI) ---- */
let PREFS = {}, mainWin = null, tray = null, quitting = false;
const prefsFile = () => path.join(app.getPath('userData'), 'settings.json');
const loadPrefs = () => { try { PREFS = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')); } catch { PREFS = {}; } };

function showWin() {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show(); mainWin.focus();
}
function ensureTray(on) {
  if (on && !tray) {
    try {
      const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'avatar.png'));
      if (img.isEmpty()) throw new Error('tray icon missing (assets/avatar.png)');
      tray = new Tray(img.resize({ width: 16, height: 16 }));
      tray.setToolTip('DEAL DEATH');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open DEAL DEATH', click: showWin },
        { label: 'Quit', click: () => { quitting = true; app.quit(); } }
      ]));
      tray.on('click', showWin);
    } catch (err) { console.warn('[tray]', err.message); tray = null; }
  } else if (!on && tray) { tray.destroy(); tray = null; }
}
function applyDns() {
  try {
    app.configureHostResolver({ secureDnsMode: PREFS.secureDns ? 'secure' : 'automatic', secureDnsServers: ['https://cloudflare-dns.com/dns-query'] });
  } catch (err) { console.warn('[dns]', err.message); }
}

function createWindow() {
  const startHidden = process.argv.includes('--hidden') && !!PREFS.startMinimized;
  mainWin = new BrowserWindow({
    title: 'DEAL DEATH', width: 1400, height: 860, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0d0d12', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWin.once('ready-to-show', () => {
    if (!startHidden) mainWin.show();
    else if (!tray) { mainWin.showInactive(); mainWin.minimize(); }
  });
  mainWin.on('close', (ev) => { if (PREFS.tray && tray && !quitting) { ev.preventDefault(); mainWin.hide(); } });
  mainWin.on('closed', () => { mainWin = null; });
  mainWin.loadFile('index.html');
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWin);
  app.whenReady().then(() => { loadPrefs(); applyDns(); ensureTray(!!PREFS.tray); createWindow(); });
}
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
process.on('uncaughtException', (err) => console.error('[uncaught]', err));

const UA = { 'User-Agent': 'DealDeathLauncher/1.1' };
const doFetch = (u, o) => net.fetch(u, o);
const getJson = async (url, h = {}) => {
  const r = await doFetch(url, { headers: { ...UA, ...h } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + new URL(url).host);
  return r.json();
};
const download = async (url, dest) => {
  const r = await doFetch(url, { headers: UA });
  if (!r.ok) throw new Error('Download failed (HTTP ' + r.status + ')');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
};
const safeId = (s) => String(s).replace(/[^\w-]/g, '');
const base = (id) => path.join(app.getPath('userData'), 'instances', safeId(id));
const TAB = { Mods: 'mods', 'Resource Packs': 'resourcepacks', Shaders: 'shaderpacks', 'Data Packs': 'datapacks' };
const TYPE_DIR = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks' };
const inside = (root, p) => { const r = path.resolve(root), t = path.resolve(p); return t === r || t.startsWith(r + path.sep); };
const readMeta = (id) => { try { return JSON.parse(fs.readFileSync(path.join(base(id), 'meta.json'), 'utf8')); } catch { return {}; } };
const writeMeta = (id, m) => { fs.mkdirSync(base(id), { recursive: true }); fs.writeFileSync(path.join(base(id), 'meta.json'), JSON.stringify(m)); };

ipcMain.handle('versions', () => getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'));
ipcMain.handle('news', () => getJson('https://launchercontent.mojang.com/v2/javaPatchNotes.json'));

/* ---- search (Modrinth + CurseForge) ---- */
ipcMain.handle('search', async (e, o) => {
  if (o.src === 'curseforge') {
    if (!o.key) throw new Error('CurseForge needs an API key. Paste it in the filters panel.');
    const cls = { modpack: 4471, mod: 6, resourcepack: 12, shader: 6552, datapack: 6945 }[o.type];
    const ml = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 }[(o.loaders || [])[0]];
    const p = new URLSearchParams({ gameId: 432, classId: cls, pageSize: 30, sortOrder: 'desc', searchFilter: o.q || '',
      sortField: { downloads: 6, newest: 11, updated: 3 }[o.sort] || 2 });
    if (o.ver) p.set('gameVersion', o.ver);
    if (ml) p.set('modLoaderType', ml);
    const r = await getJson('https://api.curseforge.com/v1/mods/search?' + p, { 'x-api-key': o.key, Accept: 'application/json' });
    return { total: r.pagination?.totalCount ?? r.data.length, items: r.data.map((m) => ({ id: String(m.id), title: m.name, desc: m.summary, author: m.authors?.[0]?.name || '', downloads: m.downloadCount, icon: m.logo?.thumbnailUrl, image: m.screenshots?.[0]?.url, url: m.links?.websiteUrl, src: 'curseforge' })) };
  }
  const facets = [['project_type:' + o.type]];
  if ((o.loaders || []).length) facets.push(o.loaders.map((l) => 'categories:' + l));
  if (o.cat) facets.push(['categories:' + o.cat]);
  if (o.ver) facets.push(['versions:' + o.ver]);
  const r = await getJson('https://api.modrinth.com/v2/search?limit=30&index=' + encodeURIComponent(o.sort || 'downloads') +
    '&query=' + encodeURIComponent(o.q || '') + '&facets=' + encodeURIComponent(JSON.stringify(facets)));
  return { total: r.total_hits, items: r.hits.map((h) => ({ id: h.project_id, title: h.title, desc: h.description, author: h.author, downloads: h.downloads, icon: h.icon_url, image: h.featured_gallery || h.gallery?.[0], url: `https://modrinth.com/${h.project_type}/${h.slug}`, src: 'modrinth' })) };
});

/* ---- install one file into an instance ---- */
ipcMain.handle('install', async (e, o) => {
  const dir = TYPE_DIR[o.type]; if (!dir) throw new Error('Unsupported content type');
  const loader = String(o.loader || '').toLowerCase();
  if (o.type === 'mod' && (!loader || loader === 'vanilla')) throw new Error('This instance is Vanilla. Create an instance with a mod loader to install mods.');
  let filename, url;
  if (o.src === 'curseforge') {
    if (!o.key) throw new Error('CurseForge needs an API key.');
    const ml = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 }[loader];
    const q = new URLSearchParams({ gameVersion: o.ver, pageSize: 1 }); if (ml && o.type === 'mod') q.set('modLoaderType', ml);
    const r = await getJson(`https://api.curseforge.com/v1/mods/${encodeURIComponent(o.id)}/files?` + q, { 'x-api-key': o.key });
    const f = r.data?.[0]; if (!f) throw new Error('No file for Minecraft ' + o.ver + ' on CurseForge.');
    if (!f.downloadUrl) throw new Error('The author blocks third-party downloads. Open it on CurseForge instead.');
    filename = f.fileName; url = f.downloadUrl;
  } else {
    const q = new URLSearchParams({ game_versions: JSON.stringify([o.ver]) });
    if (o.type === 'mod') q.set('loaders', JSON.stringify([loader]));
    const vs = await getJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(o.id)}/version?` + q);
    if (!vs.length) throw new Error('No compatible file for Minecraft ' + o.ver + (o.type === 'mod' ? ' + ' + loader : '') + '.');
    const f = vs[0].files.find((x) => x.primary) || vs[0].files[0];
    filename = f.filename; url = f.url;
  }
  filename = path.basename(filename);
  await download(url, path.join(base(o.instId), dir, filename));
  const m = readMeta(o.instId); m[filename] = { title: o.title, icon: o.icon, desc: o.desc, url: o.url, pid: String(o.id) };
  writeMeta(o.instId, m);
  return { file: filename };
});

/* ---- install a Modrinth .mrpack: downloads its files + overrides ---- */
ipcMain.handle('installPack', async (e, o) => {
  if (o.src !== 'modrinth') throw new Error('Only Modrinth modpacks can be installed for now.');
  let AdmZip;
  try { AdmZip = require('adm-zip'); } catch { throw new Error('Modpack install needs a package. Run "npm install" in the project folder, then restart.'); }
  const vs = await getJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(o.id)}/version`);
  const v = vs[0]; if (!v) throw new Error('This modpack has no downloadable version.');
  const f = v.files.find((x) => x.filename.endsWith('.mrpack')) || v.files[0];
  const tmp = path.join(app.getPath('temp'), 'dd-' + Date.now() + '.mrpack');
  await download(f.url, tmp);
  const zip = new AdmZip(tmp), root = base(o.instId);
  const idx = JSON.parse(zip.readAsText('modrinth.index.json'));
  for (const file of idx.files || []) {
    if (file.env && file.env.client === 'unsupported') continue;
    const dest = path.join(root, file.path);
    if (!inside(root, dest)) continue;
    await download(file.downloads[0], dest);
  }
  for (const en of zip.getEntries()) {
    const m = en.entryName.match(/^(client-)?overrides\/(.+)$/);
    if (!m || en.isDirectory) continue;
    const dest = path.join(root, m[2]);
    if (!inside(root, dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, en.getData());
  }
  fs.unlinkSync(tmp);
  const d = idx.dependencies || {};
  const loader = d['fabric-loader'] ? 'Fabric' : d['quilt-loader'] ? 'Quilt' : d.neoforge ? 'NeoForge' : d.forge ? 'Forge' : 'Vanilla';
  return { name: idx.name, mc: d.minecraft, loader };
});

/* ---- instance folders ---- */
ipcMain.handle('scan', (e, id) => {
  const meta = readMeta(id), out = {};
  for (const [tab, dir] of Object.entries(TAB)) {
    const p = path.join(base(id), dir);
    let files = []; try { files = fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name); } catch {}
    out[tab] = files.map((file) => { const name = file.replace(/\.disabled$/, ''); return { file, name, enabled: !file.endsWith('.disabled'), ...(meta[name] || {}) }; });
  }
  return out;
});
ipcMain.handle('toggle', (e, o) => {
  const dir = path.join(base(o.instId), TAB[o.tab] || 'x'), f = path.basename(o.file);
  const to = f.endsWith('.disabled') ? f.slice(0, -9) : f + '.disabled';
  fs.renameSync(path.join(dir, f), path.join(dir, to)); return true;
});
ipcMain.handle('remove', (e, o) => {
  const dir = path.join(base(o.instId), TAB[o.tab] || 'x'), f = path.basename(o.file);
  fs.unlinkSync(path.join(dir, f));
  const m = readMeta(o.instId); delete m[f.replace(/\.disabled$/, '')]; writeMeta(o.instId, m); return true;
});
ipcMain.handle('openFolder', async (e, id) => { fs.mkdirSync(base(id), { recursive: true }); return shell.openPath(base(id)); });
ipcMain.handle('deleteInstance', (e, id) => { fs.rmSync(base(id), { recursive: true, force: true }); return true; });

/* ---- Settings helpers ---- */
ipcMain.handle('pickJava', async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile'], filters: [{ name: 'Java executable', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }] });
  return r.canceled ? '' : r.filePaths[0];
});
ipcMain.handle('javaCheck', (e, p) => new Promise((resolve, reject) => {
  const bin = String(p || '').trim() || 'java';
  execFile(bin, ['-version'], { timeout: 8000, windowsHide: true }, (err, so, se) => {
    const out = String(se || so || '').split('\n')[0].trim();
    if (err && !out) return reject(new Error('Java not found. Install Java or choose the java.exe path.'));
    resolve(out || 'Java found.');
  });
}));

ipcMain.handle('setPrefs', (e, p) => {
  PREFS = { ...PREFS, ...(p || {}) };
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(prefsFile(), JSON.stringify(PREFS)); } catch {}
  ensureTray(!!PREFS.tray);
  if (app.isPackaged) { try { app.setLoginItemSettings({ openAtLogin: !!PREFS.startup, args: ['--hidden'] }); } catch {} }
  return true;
});

ipcMain.handle('about', () => ({
  version: app.getVersion(), electron: process.versions.electron, node: process.versions.node,
  platform: process.platform, arch: process.arch, userData: app.getPath('userData'), packaged: app.isPackaged
}));

/* ---- disk usage ---- */
const dirSize = async (p) => {
  let total = 0, list;
  try { list = await fs.promises.readdir(p, { withFileTypes: true }); } catch { return 0; }
  for (const d of list) {
    const f = path.join(p, d.name);
    if (d.isDirectory()) total += await dirSize(f);
    else if (d.isFile()) { try { total += (await fs.promises.stat(f)).size; } catch {} }
  }
  return total;
};
ipcMain.handle('storageInfo', async (e, ids) => {
  const out = { root: path.join(app.getPath('userData'), 'instances'), sizes: {}, runtimes: 0, free: 0, total: 0 };
  for (const id of Array.isArray(ids) ? ids : []) out.sizes[id] = await dirSize(base(id));
  out.runtimes = await dirSize(path.join(app.getPath('userData'), 'runtime'));
  try { const s = fs.statfsSync(app.getPath('userData')); out.free = s.bavail * s.bsize; out.total = s.blocks * s.bsize; } catch {}
  return out;
});

/* ---- Java runtimes (Temurin, installed into the launcher's own folder) ---- */
const JAVAS = [25, 21, 17, 16, 8];
const rtDir = (n) => path.join(app.getPath('userData'), 'runtime', 'temurin-' + n);
const javaExe = (n) => {
  const exe = process.platform === 'win32' ? (app.isPackaged ? 'javaw.exe' : 'java.exe') : 'java';
  const find = (dir, depth) => {
    let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
    for (const d of list) {
      if (!d.isDirectory()) continue;
      if (d.name === 'bin') { const p = path.join(dir, 'bin', exe); if (fs.existsSync(p)) return p; }
      if (depth < 3) { const r = find(path.join(dir, d.name), depth + 1); if (r) return r; }
    }
    return '';
  };
  return find(rtDir(n), 0);
};
const installing = {};
const installJava = (n) => (installing[n] ||= (async () => {
  if (process.platform !== 'win32') throw new Error('Automatic Java install only works on Windows for now. Install Java yourself and set its path.');
  let AdmZip; try { AdmZip = require('adm-zip'); } catch { throw new Error('Run "npm install" first (adm-zip is missing).'); }
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const tmp = path.join(app.getPath('temp'), `dd-java-${n}-${Date.now()}.zip`);
  await download(`https://api.adoptium.net/v3/binary/latest/${n}/ga/windows/${arch}/jre/hotspot/normal/eclipse`, tmp);
  const dir = rtDir(n);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  try { new AdmZip(tmp).extractAllTo(dir, true); } finally { try { fs.unlinkSync(tmp); } catch {} }
  const exe = javaExe(n); if (!exe) throw new Error('Java files were not found after install.');
  return exe;
})().finally(() => { delete installing[n]; }));
const ensureJava = async (n) => javaExe(n) || installJava(n);

ipcMain.handle('javaList', async () => {
  const items = [];
  for (const n of JAVAS) { const exe = javaExe(n); items.push({ n, installed: !!exe, busy: !!installing[n], size: exe ? await dirSize(rtDir(n)) : 0 }); }
  return { items, os: process.platform, arch: process.arch };
});
ipcMain.handle('javaInstall', async (e, n) => { n = Number(n); if (!JAVAS.includes(n)) throw new Error('Unknown Java version'); await installJava(n); return true; });
ipcMain.handle('javaRemove', (e, n) => { n = Number(n); if (!JAVAS.includes(n)) throw new Error('Unknown Java version'); fs.rmSync(rtDir(n), { recursive: true, force: true }); return true; });

// Which Java major does a Minecraft version need?
const needJava = (v) => {
  v = String(v);
  const y = /^(\d\d)w/.exec(v);
  if (y) return Number(y[1]) >= 26 ? 25 : 21;
  const p = v.split(/[.-]/).map(Number), a = p[0], b = p[1], c = p[2] || 0;
  if (a >= 26) return 25;
  if (a === 1) {
    if (b >= 22) return 25;
    if (b >= 21 || (b === 20 && c >= 5)) return 21;
    if (b >= 18) return 17;
    if (b === 17) return 16;
    return 8;
  }
  return 21;
};

const runCmd = (cmd, cwd) => new Promise((resolve, reject) => {
  exec(cmd, { cwd, timeout: 60000, windowsHide: true }, (err, so, se) => err ? reject(new Error(String(se || err.message).trim().slice(0, 300))) : resolve(so));
});
const parseEnv = (txt) => {
  const out = {};
  for (const line of String(txt || '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].trim();
  }
  return out;
};

/* ---- Minecraft launch handler ---- */
ipcMain.handle('launch', async (e, o) => {
  const id = String(o?.instId || '');
  const version = String(o?.version || '');
  const username = String(o?.username || '').trim();

  if (!id || !version) throw new Error('Instance ID or Minecraft version is missing.');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username))
    throw new Error('Username must be 3-16 letters, numbers or underscores.');

  const root = base(id);
  fs.mkdirSync(root, { recursive: true });
  const w = BrowserWindow.fromWebContents(e.sender);
  const send = (ch, d) => { try { if (w && !w.isDestroyed()) w.webContents.send(ch, d); } catch {} };

  // ---- Mod loader (Fabric / Quilt) ----
  const loader = String(o?.loader || 'Vanilla').toLowerCase();
  let custom;
  if (loader === 'fabric' || loader === 'quilt') {
    const meta = loader === 'fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3';
    const list = await getJson(`${meta}/versions/loader/${encodeURIComponent(version)}`);
    if (!list.length) throw new Error(`${loader} does not support Minecraft ${version} yet.`);
    const pick = list.find((x) => x.loader && x.loader.stable) || list[0];
    const profile = await getJson(`${meta}/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(pick.loader.version)}/profile/json`);
    custom = profile.id;
    const vf = path.join(root, 'versions', custom, custom + '.json');
    if (!fs.existsSync(vf)) {
      fs.mkdirSync(path.dirname(vf), { recursive: true });
      fs.writeFileSync(vf, JSON.stringify(profile));
    }
  } else if (loader === 'forge' || loader === 'neoforge') {
    throw new Error('Forge/NeoForge are not supported yet. Use a Fabric or Quilt instance.');
  }

  // ---- preferences ----
  const pr = o?.prefs || {};
  const gb = (v, d) => { const n = Math.round(Number(v)); return n >= 1 && n <= 64 ? n : d; };
  const memMax = gb(pr.memMax, 4), memMin = Math.min(gb(pr.memMin, 2), memMax);
  const dim = (v, d) => { const n = Math.round(Number(v)); return n >= 200 && n <= 10000 ? n : d; };
  const customArgs = (Array.isArray(pr.jvmArgs) ? pr.jvmArgs : String(pr.jvmArgs || '').split(/\s+/)).map((s) => String(s).trim()).filter(Boolean);
  Object.assign(process.env, parseEnv(pr.env));

  // ---- Java: custom path > managed Temurin runtime > system Java ----
  let javaPath = typeof pr.javaPath === 'string' ? pr.javaPath.trim() : '';
  if (!javaPath && pr.autoJava !== false) {
    const need = needJava(version);
    try {
      if (!javaExe(need)) send('info', `Downloading Java ${need}... this happens once.`);
      javaPath = await ensureJava(need);
    } catch (er) {
      console.warn('[java] automatic setup failed:', er.message);
      send('info', `Could not set up Java ${need} (${er.message}). Trying system Java.`);
    }
  }
  if (!javaPath && app.isPackaged && process.platform === 'win32') javaPath = 'javaw';

  if (pr.preLaunch && String(pr.preLaunch).trim()) {
    try { await runCmd(String(pr.preLaunch), root); } catch (er) { throw new Error('Pre-launch command failed: ' + er.message); }
  }

  const launcher = new Client();
  launcher.on('debug', (m) => console.log('[MC debug]', m));
  launcher.on('data', (m) => console.log('[MC]', m));
  launcher.on('progress', (p) => console.log('[MC progress]', p.type, p.task, '/', p.total));
  launcher.on('close', (code) => {
    console.log('Minecraft closed:', code);
    send('game:closed', { instId: id, code });
    showWin();
    if (pr.postExit && String(pr.postExit).trim()) runCmd(String(pr.postExit), root).catch((er) => console.warn('[post-exit]', er.message));
  });

  const proc = await launcher.launch({
    authorization: Authenticator.getAuth(username), // offline mode
    root,
    version: custom ? { number: version, type: 'release', custom } : { number: version, type: 'release' },
    memory: { max: memMax + 'G', min: memMin + 'G' },
    window: { width: dim(pr.winW, 854), height: dim(pr.winH, 480) },
    overrides: { maxSockets: 2 },
    ...(javaPath ? { javaPath } : {}),
    ...(customArgs.length ? { customArgs } : {})
  });

  if (!proc) throw new Error('Minecraft failed to start. Is Java installed? Check the terminal logs.');
  if (pr.minimize && mainWin && !mainWin.isDestroyed()) { if (tray) mainWin.hide(); else mainWin.minimize(); }
  return true;
});
