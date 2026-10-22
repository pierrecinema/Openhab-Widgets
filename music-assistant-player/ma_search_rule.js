// Music Assistant: Suche & Abspielen fuer das Widget ma_nowplaying
// Trigger: MA_Search_Query (Befehl), MA_Search_Play (Befehl), <API-Response-Item> (Aenderung)
// REQ/RES: Items, die mit den Channels apiRequest / apiResponse des Music-Assistant-Servers verlinkt sind.
var REQ = 'MusicAssistant_API_Request';
var RES = 'MusicAssistant_API_Response';
var RESULTS = 'MA_Search_Results';
var TYPES = { playlist: 'Playlist', track: 'Titel', album: 'Album', artist: 'Künstler', radio: 'Radio' };

function eventValue() {
  var v = event.receivedCommand !== undefined ? event.receivedCommand : (event.itemCommand !== undefined ? event.itemCommand : event.itemState);
  return v === undefined || v === null ? '' : v.toString();
}

function playerId(prefix) {
  var reg = osgi.getService('org.openhab.core.thing.link.ItemChannelLinkRegistry');
  var it = reg.getBoundChannels(prefix + '_Power').iterator();
  if (!it.hasNext()) return null;
  var thing = things.getThing(it.next().getThingUID().toString());
  return thing ? String(thing.rawThing.getConfiguration().get('playerId')) : null;
}

function imageOf(x) {
  var imgs = (x.metadata && x.metadata.images) || [];
  for (var i = 0; i < imgs.length; i++) {
    if (imgs[i].remotely_accessible && /^https?:/.test(imgs[i].path)) return imgs[i].path;
  }
  return '';
}

var name = event.itemName;

if (name === 'MA_Search_Query') {
  var q = eventValue().trim();
  if (q.length < 2) {
    items.getItem(RESULTS).postUpdate('[]');
  } else {
    items.getItem(RESULTS).postUpdate('"suche"');
    items.getItem(REQ).sendCommand(JSON.stringify({
      message_id: 'ohsearch-' + Date.now(),
      command: 'music/search',
      args: { search_query: q, media_types: ['playlist', 'track', 'album', 'artist', 'radio'], limit: 6 }
    }));
  }
} else if (name === 'MA_Search_Play') {
  // Befehl: "<Player-Equipment>|<URI>"
  var parts = eventValue().split('|');
  var pid = playerId(parts[0]);
  if (!pid || !parts[1]) {
    console.warn('MA_Search_Play: unbekannter Player oder URI: ' + eventValue());
  } else {
    items.getItem(REQ).sendCommand(JSON.stringify({
      message_id: 'ohplay-' + Date.now(),
      command: 'player_queues/play_media',
      args: { queue_id: pid, media: parts.slice(1).join('|'), option: 'replace' }
    }));
  }
} else if (name === RES) {
  var raw = items.getItem(RES).state;
  var msg = null;
  try { msg = JSON.parse(raw); } catch (e) { msg = null; }
  if (msg && String(msg.message_id || '').indexOf('ohsearch-') === 0) {
    var out = [];
    var r = msg.result || {};
    ['playlists', 'tracks', 'albums', 'artists', 'radio'].forEach(function (k) {
      (r[k] || []).forEach(function (x) {
        var who = (x.artists || []).map(function (a) { return a.name; }).join(', ') || x.owner || '';
        out.push({ n: x.name, s: (TYPES[x.media_type] || x.media_type) + (who ? ' · ' + who : ''), u: x.uri, i: imageOf(x) });
      });
    });
    items.getItem(RESULTS).postUpdate(JSON.stringify(out));
  } else if (msg && String(msg.message_id || '').indexOf('ohplay-') === 0 && msg.error_code) {
    console.warn('MA play_media Fehler: ' + (msg.details || msg.error_code));
  }
}
