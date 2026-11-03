(function() {
  'use strict';
  if (window.__smartsubs) return;
  window.__smartsubs = true;

  var APP = 'http://127.0.0.1:47800';
  var pending = null;
  var bypass = false;

  function init() {
    var origPlaylist = Lampa.Player.playlist;
    Lampa.Player.playlist = function(p) {
      if (pending) pending.playlist = p;
      return origPlaylist.apply(this, arguments);
    };

    Lampa.Player.listener.follow('create', function(e) {
      if (bypass) { bypass = false; return; }
      var d = e.data || {};
      if (d.iptv || typeof d.url !== 'string' || d.url.indexOf('http') !== 0 || d.url.indexOf('youtube.com') !== -1) return;

      e.abort();
      pending = {
        data: d,
        playlist: null,
        movie: d.card || (Lampa.Activity.active() && Lampa.Activity.active().movie) || null,
      };
      var prev = Lampa.Controller.enabled().name;

      Lampa.Select.show({
        title: 'Как смотреть?',
        items: [
          { title: 'Smart Subtitles — учить английский', value: 'smart' },
          { title: 'Обычный плеер', value: 'normal' },
        ],
        onSelect: function(item) {
          Lampa.Controller.toggle(prev);
          var p = pending;
          pending = null;
          if (!p) return;
          if (item.value === 'normal') {
            bypass = true;
            Lampa.Player.play(p.data);
            if (p.playlist) Lampa.Player.playlist(p.playlist);
          } else {
            sendToApp(p);
          }
        },
        onBack: function() {
          pending = null;
          Lampa.Controller.toggle(prev);
        },
      });
    });
  }

  function play(u) { return typeof u === 'string' ? u.replace('&preload', '&play') : u; }

  function subs(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function(s) { return s && s.url; }).map(function(s) {
      return { label: String(s.label || ''), url: s.url };
    });
  }

  function seasonEpisode(s) {
    if (!s) return null;
    var m = /S(\d{1,2})E(\d{1,3})/i.exec(s) || /(\d{1,2})x(\d{2,3})/.exec(s);
    return m ? { season: +m[1], episode: +m[2] } : null;
  }

  function tmdb(path) {
    var ctl = new AbortController();
    var timer = setTimeout(function() { ctl.abort(); }, 6000);
    var url = Lampa.TMDB.api(path + (path.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' + Lampa.TMDB.key());
    return fetch(url, { signal: ctl.signal })
      .then(function(r) { return r.json(); })
      .catch(function() { return null; })
      .then(function(j) { clearTimeout(timer); return j; });
  }

  function buildPayload(p) {
    var d = p.data;
    var movie = p.movie || null;
    var se = seasonEpisode(d.path || d.title);
    var isTv = !!(movie && (movie.name || movie.first_air_date || movie.number_of_seasons));
    var card = null;
    if (movie && movie.id) {
      var date = movie.release_date || movie.first_air_date || '';
      card = {
        tmdbId: movie.id,
        type: isTv ? 'tv' : 'movie',
        title: movie.title || movie.name || d.title || '',
        originalTitle: movie.original_title || movie.original_name || null,
        year: date ? +date.slice(0, 4) || null : null,
        imdbId: movie.imdb_id || null,
        poster: movie.poster_path
          ? (Lampa.TMDB && typeof Lampa.TMDB.image === 'function'
            ? Lampa.TMDB.image('t/p/w500' + movie.poster_path)
            : 'https://image.tmdb.org/t/p/w500' + movie.poster_path)
          : null,
      };
    }
    var payload = {
      url: play(d.url),
      title: d.title || (card && card.title) || 'Video',
      path: d.path || null,
      subtitles: subs(d.subtitles),
      resumeAt: d.timeline && d.timeline.time > 0 ? d.timeline.time : null,
      card: card,
      season: se ? se.season : null,
      episode: se ? se.episode : null,
      episodes: [],
      playlist: (Array.isArray(p.playlist) ? p.playlist : []).filter(function(i) { return i && i.url; }).map(function(i) {
        return { title: i.title || '', url: play(i.url), path: i.path || null, subtitles: subs(i.subtitles) };
      }),
    };

    if (!card) return Promise.resolve(payload);
    var jobs = [];
    if (!isTv) {
      jobs.push(tmdb('movie/' + card.tmdbId).then(function(j) { if (j && j.imdb_id) card.imdbId = j.imdb_id; }));
    } else {
      jobs.push(tmdb('tv/' + card.tmdbId + '/external_ids').then(function(j) { if (j && j.imdb_id) card.imdbId = j.imdb_id; }));
      if (se) {
        var base = 'tv/' + card.tmdbId + '/season/' + se.season;
        jobs.push(Promise.all([tmdb(base + '?language=ru-RU'), tmdb(base + '?language=en-US')]).then(function(r) {
          var ru = (r[0] && r[0].episodes) || [];
          var en = (r[1] && r[1].episodes) || [];
          var map = {};
          ru.forEach(function(e) { map[e.episode_number] = { episode: e.episode_number, nameRu: e.name || null, nameEn: null }; });
          en.forEach(function(e) {
            map[e.episode_number] = map[e.episode_number] || { episode: e.episode_number, nameRu: null, nameEn: null };
            map[e.episode_number].nameEn = e.name || null;
          });
          payload.episodes = Object.keys(map).map(function(k) { return map[k]; });
        }));
      }
    }
    return Promise.all(jobs).then(function() { return payload; });
  }

  function post(payload) {
    return fetch(APP + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function waitForApp() {
    var deadline = Date.now() + 30000;
    function tick() {
      if (Date.now() > deadline) return Promise.reject(new Error('timeout'));
      return fetch(APP + '/api/health').then(function(r) {
        if (!r.ok) throw new Error('down');
      }).catch(function() { return wait(500).then(tick); });
    }
    return tick();
  }

  function sendToApp(p) {
    Lampa.Noty.show('Smart Subtitles: открываю…');
    buildPayload(p).then(function(payload) {
      return post(payload).catch(function() {
        window.open('smartsubs://open');
        return waitForApp().then(function() { return post(payload); });
      });
    }).catch(function() {
      Lampa.Noty.show('Smart Subtitles не запущен: установите пакет smart-subtitle (sudo dnf install ...rpm)');
    });
  }

  if (window.appready) init();
  else Lampa.Listener.follow('app', function(e) { if (e.type === 'ready') init(); });
})();
