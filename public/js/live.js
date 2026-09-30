/**
 * @file        packages/coordinator/public/js/live.js
 * @description Dashboard live updates: listens to GET /live and, when the page's topics change, re-fetches the page and swaps its [data-live] regions
 *
 * @author      Andrian Yablonskyy
 * @copyright   Copyright (c) 2026 Andrian Yablonskyy. All rights reserved.
 *
 * This file is part of TestHub and is proprietary and confidential.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without prior written permission
 * from AdSystem.PRO.
 */

'use strict';

// README §10 "Live updates". The stream only says which topics changed; the
// data comes from re-fetching this very URL (same filters, search, paging and
// templates) with X-Thub-Live: 1, which the server treats as passive — it
// doesn't extend the session's idle timeout. Only [data-live] regions are
// replaced, and never while someone is using them.
(function (){
  const topics = (document.body.dataset.liveTopics || '').split(/\s+/).filter(Boolean),
    indicator = document.getElementById('thub-live');
  if (!topics.length || !window.EventSource || !window.DOMParser){
    return;
  }

  const MIN_GAP_MS = 2000, // at most one re-fetch per 2 s per tab
    RETRY_BLOCKED_MS = 2000,
    RECONNECT_MS = 5000,
    // One stream per browser, not per tab (browsers allow only 6 connections
    // per site over HTTP/1.1): the tab holding the lock opens it and relays
    // what it hears to the others.
    channel = 'BroadcastChannel' in window ? new BroadcastChannel('thub-live') : null;
  let dirty = false,
    fetching = false,
    streamStatus = null, // set only in the tab holding the stream
    ended = false,
    lastFetch = 0,
    lastUpdate = Date.now(),
    timer = null;

  // --- status indicator (navbar) -----------------------------------------
  const LABELS = {
    connecting: ['Live', 'Connecting to live updates…'],
    live: ['Live', 'Live updates on'],
    paused: ['Paused', 'Live updates paused while you edit — they resume when you’re done'],
    offline: ['Offline', 'Coordinator unreachable — reconnecting…'],
    ended: ['Session ended', 'Your session ended — reload the page to sign in again']
  };
  let state = 'connecting';
  function setState(next){
    state = next;
    if (!indicator){
      return;
    }
    const [label, title] = LABELS[next];
    indicator.dataset.state = next;
    indicator.querySelector('.thub-live-label').textContent = label;
    indicator.title = next === 'live' ? `${title} · updated ${ago()}` : title;
  }
  function ago(){
    const s = Math.round((Date.now() - lastUpdate) / 1000);
    return s < 5 ? 'just now' : s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
  }
  if (indicator){
    indicator.addEventListener('mouseenter', () => setState(state));
    indicator.addEventListener('click', () => {
      if (ended){
        window.location.reload();
      }
    });
  }

  // --- deciding when a region may be replaced ----------------------------
  // Everything waits while a confirmation is open: it submits a form that
  // may sit in a region, and must not lose it.
  function globallyBlocked(){
    return Boolean(document.querySelector('#thub-confirm-modal.show, #remove-resource-modal.show, .thub-overlay'));
  }
  // A region waits while it's in use: a field or form in it has focus (not
  // just a row — focus returns to the row after its resource card closes),
  // an open collapse with fields (inline rename), a dropdown, or a modal
  // inside it (agent Edit).
  function regionBusy(region){
    const active = document.activeElement,
      editing = active && region.contains(active) &&
        (active.matches('input, select, textarea, [contenteditable]') || active.closest('form'));
    return Boolean(editing) || Boolean(region.querySelector(
      '.collapse.show :is(input, select, textarea), .collapsing, .dropdown-menu.show, .modal.show'
    ));
  }

  // --- applying a fresh copy of the page ---------------------------------
  function disposeTooltips(root){
    root.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => bootstrap.Tooltip.getInstance(el)?.dispose());
  }

  function apply(doc){
    // Resources added or removed: their card modals (with the config tabs'
    // own scripts) exist only on a full page load.
    const cards = (d) => [...d.querySelectorAll('.thub-resource-card')].map((m) => m.id).sort().join(','),
      structureChanged = cards(document) !== cards(doc);
    if (structureChanged && !document.querySelector('.modal.show')){
      window.location.reload();
      return true;
    }
    let deferred = false;
    document.querySelectorAll('[data-live]').forEach((region) => {
      const fresh = doc.querySelector(`[data-live="${CSS.escape(region.dataset.live)}"]`);
      if (!fresh || fresh.innerHTML === region.innerHTML){
        return;
      }
      if (regionBusy(region)){
        deferred = true;
        return;
      }
      disposeTooltips(region);
      region.innerHTML = fresh.innerHTML;
    });
    return !deferred;
  }

  async function refresh(){
    timer = null;
    if (ended || fetching){
      return;
    }
    if (document.hidden){
      dirty = true; // caught up on visibilitychange
      return;
    }
    if (globallyBlocked()){
      dirty = true;
      setState('paused');
      schedule(RETRY_BLOCKED_MS);
      return;
    }
    fetching = true;
    dirty = false;
    lastFetch = Date.now();
    try {
      const res = await fetch(window.location.href, {
        headers: { 'X-Thub-Live': '1' },
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'manual'
      });
      if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403){
        sessionEnded();
        return;
      }
      if (!res.ok){
        throw new Error(`HTTP ${res.status}`);
      }
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      if (apply(doc)){
        lastUpdate = Date.now();
        setState('live');
      }
      else {
        // Something was in use: try again shortly, until it's free.
        dirty = true;
        setState('paused');
        schedule(RETRY_BLOCKED_MS);
      }
    }
    catch {
      dirty = true;
      setState('offline');
      schedule(RECONNECT_MS);
    }
    finally {
      fetching = false;
    }
  }

  function schedule(delay){
    if (ended || timer){
      return;
    }
    const wait = Math.max(delay ?? 0, lastFetch + MIN_GAP_MS - Date.now());
    timer = setTimeout(refresh, Math.max(0, wait));
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && dirty){
      schedule(0);
    }
  });
  // Leaving a field or closing a modal may be what a deferred update waits for.
  document.addEventListener('focusout', () => dirty && schedule(300));
  document.addEventListener('hidden.bs.modal', () => dirty && schedule(300));
  document.addEventListener('hidden.bs.collapse', () => dirty && schedule(300));

  function sessionEnded(){
    ended = true;
    clearTimeout(timer);
    setState('ended');
  }

  // --- messages (from our own stream, or relayed from the tab holding it) -
  function onMessage(msg){
    if (msg.type === 'changed' && msg.topics.some((t) => topics.includes(t))){
      schedule(0);
    }
    else if (msg.type === 'resync'){
      schedule(0); // (re)connected: whatever happened meanwhile, catch up
    }
    else if (msg.type === 'status' && !ended && state !== 'paused'){
      setState(msg.status);
    }
    else if (msg.type === 'session-ended'){
      sessionEnded();
    }
    else if (msg.type === 'status-request' && streamStatus){
      channel.postMessage({ type: 'status', status: streamStatus }); // a tab opened later asks
    }
  }
  function broadcast(msg){
    if (msg.type === 'status'){
      streamStatus = msg.status;
    }
    channel?.postMessage(msg);
    onMessage(msg);
  }
  if (channel){
    channel.onmessage = (e) => onMessage(e.data);
    channel.postMessage({ type: 'status-request' });
  }

  // --- the stream (only in the tab that holds the lock) ------------------
  // Resolves when this tab should give the stream up for good: session ended.
  function runStream(){
    return new Promise((resolve) => {
      let connectedBefore = false,
        source = null;
      function connect(){
        source = new EventSource('/live');
        source.addEventListener('hello', () => {
          broadcast({ type: 'status', status: 'live' });
          if (connectedBefore){
            broadcast({ type: 'resync' });
          }
          connectedBefore = true;
        });
        source.addEventListener('changed', (e) => broadcast({ type: 'changed', topics: JSON.parse(e.data).topics }));
        source.addEventListener('session-ended', () => {
          source.close();
          broadcast({ type: 'session-ended' });
          resolve();
        });
        source.onerror = async () => {
          if (source.readyState !== EventSource.CLOSED){
            broadcast({ type: 'status', status: 'offline' }); // EventSource retries by itself
            return;
          }
          // Closed for good (an HTTP error, e.g. 401 or a proxy's 502 during
          // a restart): signed out, or just down for now?
          broadcast({ type: 'status', status: 'offline' });
          try {
            const res = await fetch('/live', { method: 'HEAD', redirect: 'manual', credentials: 'same-origin', headers: { 'X-Thub-Live': '1' } });
            if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403){
              broadcast({ type: 'session-ended' });
              resolve();
              return;
            }
          }
          catch {
            // unreachable: retry below
          }
          setTimeout(connect, RECONNECT_MS);
        };
      }
      connect();
    });
  }

  if (navigator.locks && channel){
    // Held until the stream ends for good; if this tab closes, the browser
    // releases it and the next waiting tab takes over.
    navigator.locks.request('thub-live-stream', runStream);
  }
  else {
    runStream();
  }
})();
