#!/usr/bin/env node
// Legt für alle Music-Assistant-Player die Items, Links, Such-Items und die Regel an,
// die das Widget ma_nowplaying braucht. Benötigt Node.js 18+ (keine weiteren Pakete).
//
//   OH_URL=http://192.168.1.10:8080 OH_TOKEN=oh.xxx node setup.js [--approve] [--group Name] [--bridge UID]
//
//   --approve   Player aus der Inbox übernehmen (Browser-Webplayer werden übersprungen)
//   --group     Equipment-Gruppe, in die die Player kommen (Standard: MusicAssistant_Player, wird angelegt)
//   --bridge    UID des Music-Assistant-Servers, falls mehrere vorhanden sind
//   --dry       Nur anzeigen, nichts ändern

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const DRY = args.includes('--dry');
const BASE = (process.env.OH_URL || 'http://localhost:8080').replace(/\/$/, '') + '/rest';
const TOKEN = process.env.OH_TOKEN;
if (!TOKEN) { console.error('Bitte OH_TOKEN (openHAB API-Token) setzen.'); process.exit(1); }

const H = { Authorization: 'Bearer ' + TOKEN };
const enc = encodeURIComponent;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, url, body, type = 'application/json') {
  if (DRY && method !== 'GET') { console.log('  [dry]', method, url); return null; }
  const r = await fetch(BASE + url, {
    method,
    headers: body !== undefined ? { ...H, 'Content-Type': type } : H,
    body: body === undefined ? undefined : (type === 'application/json' ? JSON.stringify(body) : body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${t.slice(0, 200)}`);
  try { return JSON.parse(t); } catch { return t; }
}
const san = s => s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe')
  .replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Channel -> [Item-Suffix, Label, Item-Typ, semantische Tags]
const POINTS = [
  ['power', 'Power', 'Power', 'Switch', ['Switch', 'Power']],
  ['volume', 'Volume', 'Lautstärke', 'Dimmer', ['Control', 'SoundVolume']],
  ['mute', 'Mute', 'Stumm', 'Switch', ['Switch', 'SoundVolume']],
  ['control', 'Control', 'Fernbedienung', 'Player', ['Control', 'MediaControl']],
  ['state', 'State', 'Status', 'String', ['Status']],
  ['currentTitle', 'CurrentTitle', 'Titel', 'String', ['Status', 'Info']],
  ['currentArtist', 'CurrentArtist', 'Künstler', 'String', ['Status', 'Info']],
  ['currentAlbum', 'CurrentAlbum', 'Album', 'String', ['Status', 'Info']],
  ['albumArt', 'AlbumArt', 'Cover', 'Image', ['Status']],
  ['currentImage', 'CurrentImage', 'Cover-URL', 'String', ['Status']],
  ['duration', 'Duration', 'Dauer', 'Number:Time', ['Status', 'Duration']],
  ['elapsed', 'Elapsed', 'Position', 'Number:Time', ['Status', 'Progress']],
  ['seek', 'Seek', 'Springen', 'Number:Time', ['Control', 'Progress']],
  ['shuffle', 'Shuffle', 'Zufall', 'Switch', ['Switch']],
  ['repeat', 'Repeat', 'Wiederholen', 'String', ['Control']],
  ['playlist', 'Playlist', 'Playlist starten', 'String', ['Control']],
];

(async () => {
  // 1. Server-Bridge finden
  const things = await api('GET', '/things');
  const bridges = things.filter(t => t.thingTypeUID === 'musicassistant:server');
  const bridge = opt('--bridge') ? bridges.find(b => b.UID === opt('--bridge')) : bridges[0];
  if (!bridge) throw new Error('Kein Music-Assistant-Server (musicassistant:server) gefunden.');
  if (!opt('--bridge') && bridges.length > 1) console.log('Mehrere Server gefunden, verwende', bridge.UID, '(mit --bridge wählbar)');
  console.log('Server:', bridge.label, bridge.UID);

  // 2. Optional Player aus der Inbox übernehmen
  if (args.includes('--approve')) {
    const inbox = (await api('GET', '/inbox')).filter(t => t.bridgeUID === bridge.UID && t.flag === 'NEW' && t.properties.provider !== 'sendspin');
    for (const t of inbox) { await api('POST', `/inbox/${enc(t.thingUID)}/approve`, t.label, 'text/plain'); console.log('  übernommen:', t.label); }
    if (inbox.length && !DRY) await sleep(3000);
  }

  // 3. API-Items der Bridge (für die Suche)
  const links = await api('GET', '/links');
  const linkedTo = ch => (links.find(l => l.channelUID === `${bridge.UID}:${ch}`) || {}).itemName;
  let req = linkedTo('apiRequest');
  let res = linkedTo('apiResponse');
  const newItems = [];
  const newLinks = [];
  if (!req) { req = 'MusicAssistant_API_Request'; newItems.push({ type: 'String', name: req, label: 'Music Assistant API Request', tags: [] }); newLinks.push([req, `${bridge.UID}:apiRequest`]); }
  if (!res) { res = 'MusicAssistant_API_Response'; newItems.push({ type: 'String', name: res, label: 'Music Assistant API Response', tags: [] }); newLinks.push([res, `${bridge.UID}:apiResponse`]); }

  // 4. Equipment-Gruppe
  const group = opt('--group') || 'MusicAssistant_Player';
  const allItems = await api('GET', '/items?fields=name');
  if (!allItems.some(i => i.name === group)) {
    newItems.push({ type: 'Group', name: group, label: 'Music Assistant Player', category: 'mediacontrol', tags: ['Speaker'], groupNames: [] });
  }

  // 5. Player-Equipments und Points
  const players = (await api('GET', '/things')).filter(t => t.thingTypeUID === 'musicassistant:player' && t.bridgeUID === bridge.UID);
  const count = {};
  players.forEach(p => (count[p.label] = (count[p.label] || 0) + 1));
  const used = new Set();
  for (const p of players) {
    let label = p.label;
    const PROVIDERS = { chromecast: 'Cast', universal_player: 'Universal', airplay: 'AirPlay', sonos: 'Sonos', squeezelite: 'Squeezelite', dlna: 'DLNA', snapcast: 'Snapcast' };
    if (count[label] > 1) label += ' (' + (PROVIDERS[p.properties.provider] || p.properties.provider || 'Player') + ')';
    let eq = 'MA_' + san(label);
    for (let n = 2; used.has(eq); n++) eq = 'MA_' + san(label) + '_' + n;
    used.add(eq);
    const tv = /\bTV\b/i.test(label);
    newItems.push({ type: 'Group', name: eq, label, category: tv ? 'screen' : 'soundvolume', tags: [tv ? 'Television' : 'Speaker'], groupNames: [group] });
    const channels = new Set(p.channels.map(c => c.id));
    for (const [ch, suffix, lbl, type, tags] of POINTS) {
      if (!channels.has(ch)) continue;
      newItems.push({ type, name: `${eq}_${suffix}`, label: `${label} ${lbl}`, tags, groupNames: [eq] });
      newLinks.push([`${eq}_${suffix}`, `${p.UID}:${ch}`]);
    }
    console.log('  Player:', label, '->', eq);
  }

  // 6. Such-Items
  newItems.push(
    { type: 'String', name: 'MA_Search_Query', label: 'Music Assistant Suche', tags: [] },
    { type: 'String', name: 'MA_Search_Results', label: 'Music Assistant Suchergebnisse', tags: [] },
    { type: 'String', name: 'MA_Search_Play', label: 'Music Assistant Abspielen', tags: [] },
  );

  await api('PUT', '/items', newItems);
  for (const [item, ch] of newLinks) await api('PUT', `/links/${enc(item)}/${enc(ch)}`, { itemName: item, channelUID: ch, configuration: {} });
  console.log(`Items: ${newItems.length}, Links: ${newLinks.length}`);

  // 7. Regel für Suche & Abspielen
  const script = fs.readFileSync(path.join(__dirname, 'ma_search_rule.js'), 'utf8')
    .replace(/var REQ = '[^']*';/, `var REQ = '${req}';`)
    .replace(/var RES = '[^']*';/, `var RES = '${res}';`);
  const rule = {
    uid: 'ma_search_play', name: 'Music Assistant Suche & Abspielen', tags: ['musicassistant'],
    description: 'Suche und Abspielen für das Widget ma_nowplaying',
    triggers: [
      { id: '1', type: 'core.ItemCommandTrigger', configuration: { itemName: 'MA_Search_Query' } },
      { id: '2', type: 'core.ItemCommandTrigger', configuration: { itemName: 'MA_Search_Play' } },
      { id: '3', type: 'core.ItemStateChangeTrigger', configuration: { itemName: res } },
    ],
    conditions: [],
    actions: [{ id: '4', type: 'script.ScriptAction', configuration: { type: 'application/javascript', script } }],
  };
  let exists = true;
  try { await api('GET', '/rules/ma_search_play'); } catch { exists = false; }
  await api(exists ? 'PUT' : 'POST', exists ? '/rules/ma_search_play' : '/rules', rule);
  console.log('Regel ma_search_play', exists ? 'aktualisiert' : 'angelegt');

  // 8. Player-Things neu starten, damit die neuen Items ihre Werte bekommen
  for (const p of players) await api('PUT', `/things/${enc(p.UID)}/enable`, 'false', 'text/plain');
  if (!DRY) await sleep(3000);
  for (const p of players) await api('PUT', `/things/${enc(p.UID)}/enable`, 'true', 'text/plain');
  console.log(`\nFertig. Im Widget als "Player-Gruppe" eintragen: ${group}`);
})().catch(e => { console.error('Fehler:', e.message); process.exit(1); });
