// Mock backend for OG-Panel UI — intercepts /api/* fetch calls and serves from localStorage.
(function () {
  const LS_ORDERS = 'ogp_orders';
  const LS_PROVIDERS = 'ogp_providers';
  const LS_LOGS = 'ogp_logs';

  function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
  function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  function now() { return Math.floor(Date.now() / 1000); }
  function uid() { return Math.random().toString(36).slice(2, 10); }

  // Seed default providers (from data/providers.json)
  if (!localStorage.getItem(LS_PROVIDERS)) {
    save(LS_PROVIDERS, {
      '8f4b06c4': { id: '8f4b06c4', name: 'yoyo', api_url: 'https://yoyomedia.in/api/v2', api_key: '959a3133***' },
      '965216c3': { id: '965216c3', name: 'Just Smm', api_url: 'https://justsmm.com/api/v2', api_key: 'c1119b69***' },
    });
  }
  if (!localStorage.getItem(LS_ORDERS)) save(LS_ORDERS, {});
  if (!localStorage.getItem(LS_LOGS)) save(LS_LOGS, {});

  function appendLog(id, line) {
    const logs = load(LS_LOGS, {});
    logs[id] = (logs[id] || '') + `[${new Date().toLocaleTimeString()}] ${line}\n`;
    save(LS_LOGS, logs);
  }

  function orderList() {
    const orders = load(LS_ORDERS, {});
    const providers = load(LS_PROVIDERS, {});
    return Object.values(orders).map(o => ({
      ...o,
      provider_name: o.provider_id && providers[o.provider_id] ? providers[o.provider_id].name : '',
      created_str: new Date(o.created_at * 1000).toLocaleString(),
    })).sort((a, b) => b.created_at - a.created_at);
  }

  // Real growth pattern (mirrors app.py simulate_growth)
  const VIEW_PATTERN = [
    100,120,135,196,150,170,190,136,200,230,
    210,192,260,280,100,196,135,120,150,136,
    190,213,353,393,400,441,443,491,534,613,
    714,832,818,938,1013,978,1123,1089,1132,1022,
    1209,1091,1376,1160,1159,1074,1132,1082,1069,1134,
    1141,1157,1089,1083,978,947,904,936,911,859,
    816,757
  ];
  // Fixed delay schedule (seconds between steps).
  const DELAYS_MIN = [60,70,50,35,70,55,40,60,70,50,35,70,55,40,60,70,50,35,70,55];
  try { window.OGP_PATTERN = VIEW_PATTERN; window.OGP_DELAYS_MIN = DELAYS_MIN; window.OGP_MIN_VIEW_BATCH = 100; } catch(_) {}

  // Optional speed-up: set window.OGP_TIME_SCALE = 60 in console for 1 sec = 1 sec (default 1)
  function delayFor(step) {
    const scale = (typeof window !== 'undefined' && window.OGP_TIME_SCALE) || 1;
    const v = DELAYS_MIN[step % DELAYS_MIN.length];
    return Math.max(1, Math.round(v / scale));
  }


  function tsStr() { return new Date().toLocaleTimeString('en-GB'); }

  // Send a real batch to the provider via our /api/public/smm/add proxy route.
  // Runs in background; logs the provider order id (or error) when it comes back.
  async function sendRealBatch(o, providers, label, sid, qty) {
    if (!qty || qty <= 0 || !sid) return;
    const prov = providers[o.provider_id];
    if (!prov || !prov.api_url || !prov.api_key) {
      appendLog(o.id, `[${tsStr()}] ⚠ ${label}: no provider configured, skipped`);
      return;
    }
    try {
      const r = await originalFetch('/api/public/smm/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_url: prov.api_url,
          api_key: prov.api_key,
          service: sid,
          link: o.link,
          quantity: qty,
        }),
      });
      const j = await r.json().catch(() => ({}));
      const resp = j && j.response;
      if (resp && (resp.order || resp.order_id)) {
        appendLog(o.id, `[${tsStr()}] ✓ ${label} order #${resp.order || resp.order_id} sent (qty ${qty})`);
      } else if (resp && resp.error) {
        appendLog(o.id, `[${tsStr()}] ✗ ${label} provider error: ${resp.error}`);
      } else {
        appendLog(o.id, `[${tsStr()}] ${label} response: ${JSON.stringify(resp).slice(0,180)}`);
      }
    } catch (e) {
      appendLog(o.id, `[${tsStr()}] ✗ ${label} network error: ${e.message || e}`);
    }
  }

  // Provider minimum order qty — derived metrics queue up until this threshold.
  const MIN_VIEW_BATCH = 100;   // last view batch will never be smaller than this (overshoot allowed)
  const MIN_DERIVED    = 10;    // likes/shares/saves/reposts only sent when accrual >= 10

  // Helper: compute "due so far" for a derived metric using per-1k rule.
  // Rule: pct% means (pct * 10) per 1000 views  →  floor(views * pct / 100). Same math.
  function dueFor(views, pct) { return Math.floor((views || 0) * (pct || 0) / 100); }

  // Try to flush an accrued derived metric if its pending delta >= MIN_DERIVED (or if forceFinal).
  function flushDerived(o, providers, label, sidKey, sentKey, pctKey, enabledKey, forceFinal) {
    if (!o[enabledKey]) return;
    const due  = dueFor(o.current_views, o[pctKey]);
    const sent = o[sentKey] || 0;
    const pending = due - sent;
    if (pending <= 0) return;
    if (pending >= MIN_DERIVED || forceFinal) {
      if (pending < MIN_DERIVED && forceFinal) {
        appendLog(o.id, `[${tsStr()}] ⓘ ${label} final pending ${pending} < provider min ${MIN_DERIVED}, skipped`);
        return;
      }
      o[sentKey] = due;
      sendRealBatch(o, providers, label, o[sidKey], pending);
    }
    // else: hold until next step accumulates more
  }

  // Simulate progress for running orders (pattern-based, like Flask app.py)
  setInterval(() => {
    const orders = load(LS_ORDERS, {});
    const providers = load(LS_PROVIDERS, {});
    let changed = false;
    Object.values(orders).forEach(o => {
      if (o.status === 'scheduled' && o.scheduled_ts && now() >= o.scheduled_ts) {
        o.status = 'running'; o.current_step = 0; o.next_step_at = now() + delayFor(0); changed = true;
        appendLog(o.id, 'Order started (scheduled time reached)');
      }
      if (o.status !== 'running') return;
      if (o.next_step_at && now() < o.next_step_at) return;

      const tv = o.target_views || 0;
      const cv = o.current_views || 0;
      const remaining = tv - cv;
      if (remaining <= 0) {
        o.status = 'completed'; o.next_step_at = 0;
        appendLog(o.id, 'COMPLETED'); changed = true; return;
      }
      const batchNum = o.current_step || 0;
      const patternBatch = Math.max(1, VIEW_PATTERN[batchNum % VIEW_PATTERN.length]);

      // 🎯 LAST-BATCH RULE: if remaining is <= patternBatch + MIN_VIEW_BATCH,
      // absorb it all into THIS batch (overshoot allowed up to ~MIN_VIEW_BATCH-1).
      // Guarantees the final view batch is always >= MIN_VIEW_BATCH and never a tiny leftover.
      let batch;
      if (remaining <= patternBatch + MIN_VIEW_BATCH) {
        batch = remaining;            // final batch — finishes the order
      } else {
        batch = patternBatch;
      }
      const newCv = cv + batch;       // may equal tv exactly (no overshoot of target)

      o.current_views = newCv;
      // Display totals (what the panel shows) — accrue toward "due"
      if (o.likes_enabled)   o.current_likes   = dueFor(newCv, o.like_pct);
      if (o.shares_enabled)  o.current_shares  = dueFor(newCv, o.share_pct);
      if (o.saves_enabled)   o.current_saves   = dueFor(newCv, o.save_pct);
      if (o.reposts_enabled) o.current_reposts = dueFor(newCv, o.repost_pct);
      o.current_step = batchNum + 1;

      const isFinal = newCv >= tv;
      let line = `[${tsStr()}] Step ${batchNum + 1} +${batch}V (${newCv}/${tv})${isFinal ? ' [final]' : ''}`;
      if (o.likes_enabled)   line += ` L:${o.current_likes}`;
      if (o.shares_enabled)  line += ` S:${o.current_shares}`;
      if (o.saves_enabled)   line += ` Sa:${o.current_saves}`;
      if (o.reposts_enabled) line += ` R:${o.current_reposts}`;
      appendLog(o.id, line);

      // 🔥 REAL DELIVERY
      if (o.views_enabled !== false) sendRealBatch(o, providers, 'Views', o.views_sid, batch);
      // Derived metrics: only fire when accrued pending >= MIN_DERIVED (or on final step)
      flushDerived(o, providers, 'Likes',   'likes_sid',   'sent_likes',   'like_pct',   'likes_enabled',   isFinal);
      flushDerived(o, providers, 'Shares',  'shares_sid',  'sent_shares',  'share_pct',  'shares_enabled',  isFinal);
      flushDerived(o, providers, 'Saves',   'saves_sid',   'sent_saves',   'save_pct',   'saves_enabled',   isFinal);
      flushDerived(o, providers, 'Reposts', 'reposts_sid', 'sent_reposts', 'repost_pct', 'reposts_enabled', isFinal);

      if (isFinal) {
        o.status = 'completed'; o.next_step_at = 0;
        appendLog(o.id, 'COMPLETED');
      } else {
        o.next_step_at = now() + delayFor(batchNum + 1);
      }
      changed = true;
    });
    if (changed) save(LS_ORDERS, orders);
  }, 1000);

  const originalFetch = window.fetch.bind(window);
  function reply(data, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(data), {
      status, headers: { 'Content-Type': 'application/json' }
    }));
  }
  function text(t, status = 200) {
    return Promise.resolve(new Response(t, { status, headers: { 'Content-Type': 'text/plain' } }));
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const method = ((init && init.method) || 'GET').toUpperCase();
    if (!url.startsWith('/api/')) return originalFetch(input, init);

    const orders = load(LS_ORDERS, {});
    const providers = load(LS_PROVIDERS, {});
    const logs = load(LS_LOGS, {});

    // GET /api/stats
    if (url === '/api/stats') {
      const list = Object.values(orders);
      return reply({
        running: list.filter(o => o.status === 'running').length,
        pending: list.filter(o => o.status === 'pending').length,
        scheduled: list.filter(o => o.status === 'scheduled').length,
        paused: list.filter(o => o.status === 'paused').length,
        completed: list.filter(o => o.status === 'completed').length,
        stopped: list.filter(o => o.status === 'stopped').length,
        providers: Object.keys(providers).length,
        total_delivered: list.reduce((s, o) => s + (o.current_views || 0), 0),
      });
    }

    // GET /api/providers
    if (url === '/api/providers' && method === 'GET') {
      return reply({ providers: Object.values(providers) });
    }
    // POST /api/providers
    if (url === '/api/providers' && method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      const id = uid();
      providers[id] = { id, name: body.name, api_url: body.api_url, api_key: body.api_key };
      save(LS_PROVIDERS, providers);
      return reply({ ok: true, id });
    }
    // GET /api/providers/:id, DELETE
    const provMatch = url.match(/^\/api\/providers\/([^/]+)$/);
    if (provMatch) {
      const id = provMatch[1];
      if (method === 'DELETE') { delete providers[id]; save(LS_PROVIDERS, providers); return reply({ ok: true }); }
      if (providers[id]) return reply({ provider: providers[id] });
      return reply({ error: 'Not found' }, 404);
    }

    // GET /api/orders
    if (url === '/api/orders' && method === 'GET') {
      return reply({ orders: orderList() });
    }
    // POST /api/orders
    if (url === '/api/orders' && method === 'POST') {
      const b = JSON.parse(init.body || '{}');
      const id = uid();
      const o = {
        id,
        order_name: b.order_name,
        link: b.link,
        target_views: b.views,
        mode: b.mode,
        provider_id: b.provider_id || '',
        views_sid: b.views_sid, likes_sid: b.likes_sid, shares_sid: b.shares_sid, saves_sid: b.saves_sid, reposts_sid: b.reposts_sid,
        views_enabled: !!b.views_enabled, likes_enabled: !!b.likes_enabled,
        shares_enabled: !!b.shares_enabled, saves_enabled: !!b.saves_enabled, reposts_enabled: !!b.reposts_enabled,
        like_pct: b.like_pct, share_pct: b.share_pct, save_pct: b.save_pct, repost_pct: b.repost_pct,
        current_views: 0, current_likes: 0, current_shares: 0, current_saves: 0, current_reposts: 0,
        status: b.is_scheduled ? 'scheduled' : 'pending',
        next_step_at: 0,
        created_at: now(),
        scheduled_ts: b.is_scheduled && b.scheduled_time ? Math.floor(new Date(b.scheduled_time).getTime() / 1000) : 0,
        is_scheduled: !!b.is_scheduled,
      };
      orders[id] = o; save(LS_ORDERS, orders);
      appendLog(id, `Order created (${o.target_views} views target)`);
      return reply({ order_id: id, is_scheduled: o.is_scheduled });
    }

    // /api/orders/:id/{start,stop,pause,resume} & DELETE
    const om = url.match(/^\/api\/orders\/([^/]+)(?:\/(start|stop|pause|resume))?$/);
    if (om) {
      const id = om[1], action = om[2];
      const o = orders[id];
      if (!o) return reply({ error: 'Order not found' }, 404);
      if (method === 'DELETE') {
        delete orders[id]; save(LS_ORDERS, orders);
        delete logs[id]; save(LS_LOGS, logs);
        return reply({ ok: true });
      }
      if (action === 'start') { o.status = 'running'; o.next_step_at = now() + 2; appendLog(id, 'STARTED'); }
      if (action === 'stop')  { o.status = 'stopped'; o.next_step_at = 0; appendLog(id, 'STOPPED'); }
      if (action === 'pause') { o.status = 'paused';  appendLog(id, 'PAUSED'); }
      if (action === 'resume'){ o.status = 'running'; o.next_step_at = now() + 2; appendLog(id, 'RESUMED'); }
      save(LS_ORDERS, orders);
      return reply({ ok: true });
    }

    // GET /api/export/orders/:id/logs
    const logMatch = url.match(/^\/api\/export\/orders\/([^/]+)\/logs$/);
    if (logMatch) return text(logs[logMatch[1]] || '');

    // GET /api/export/orders, /api/export/providers
    if (url === '/api/export/orders') return reply(orderList());
    if (url === '/api/export/providers') return reply(Object.values(providers));

    // POST /api/backup
    if (url === '/api/backup') {
      return reply({ file: 'backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json' });
    }
    // POST /api/clear/completed
    if (url === '/api/clear/completed') {
      let n = 0;
      Object.keys(orders).forEach(id => { if (orders[id].status === 'completed' || orders[id].status === 'stopped') { delete orders[id]; n++; } });
      save(LS_ORDERS, orders);
      return reply({ message: `Cleared ${n} orders` });
    }

    return reply({ error: 'Mock: route not handled — ' + url }, 404);
  };

  console.info('[OG-Panel] Mock backend ready (localStorage-backed). Original Flask routes are intercepted.');
})();
