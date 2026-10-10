/**
 * JalRakshak — front-end application logic.
 *
 * Wires the existing UI (index.html + styles.css) to the real backend via
 * window.JalApi (see api.js). Responsibilities:
 *   - load and render live community reports onto the map + feed
 *   - quick-report flow with real GPS, photo capture, and offline queue
 *   - community verification (still-flooded / cleared)
 *   - route & destination flood check
 *   - saved places with live status
 *
 * Safety-first copy and the "community-reported, not official" disclaimer are
 * preserved from the original design.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* --------------------------------- state ------------------------------------- */

const state = {
  reports: [],          // live reports from the API
  verified: new Set(),  // report ids this device has confirmed this session
  depth: 'knee',
  routeChecked: false,
  modalStep: 'safety',
  photoDataUrl: null,   // captured photo (data URL) for the pending report
  gps: null,            // { lat, lng } from the device, if granted
  cityBBox: null
};

/* ------------------------------- level mapping -------------------------------- */

// API depth values → the depth selector's data-depth attributes.
const DEPTH_TO_KEY = {
  'ankle': 'Ankle deep', 'knee': 'Knee deep', 'waist': 'Waist deep',
  'vehicle-stalling': 'Vehicles stall', 'impassable': 'Impassable'
};

/* --------------------------------- toasts ------------------------------------ */

function showToast(message) {
  const toast = $('#toast');
  $('#toastMessage').textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 2800);
}

/* ------------------------------ render: feed ---------------------------------- */

function avatarStack(seed) {
  // Deterministic pseudo-avatars from the report id so the UI looks alive.
  const pool = ['RA', 'SK', 'PM', 'NV', 'AR', 'JT'];
  const n = Math.min(3, 1 + (seed % 3));
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool[(seed + i) % pool.length]);
  return `<span class="verified-avatars">${out.map((a) => `<i>${a}</i>`).join('')}</span>`;
}

function seedFromId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

function tagForLevel(level) {
  return level === 'red' ? 'AVOID' : level === 'amber' ? 'CAUTION' : 'PASSABLE';
}

function reportMarkup(report) {
  const isVerified = state.verified.has(report.id);
  const actionText = isVerified ? 'Confirmed' : 'Still flooded';
  const seed = seedFromId(report.id);
  const road = report.roadBlocked ? 'Traffic stalled'
    : report.level === 'green' ? 'Moving normally'
    : report.level === 'amber' ? 'Passable slowly' : 'One lane open';
  const people = report.confirmations || 0;
  return `<div class="report-row" data-report-row="${report.id}">
    <span class="report-level ${report.level}"></span>
    <div class="report-main">
      <div class="report-title-line"><strong>${escapeHtml(report.place)}</strong><span class="report-tag ${tagForLevel(report.level).toLowerCase()}">${tagForLevel(report.level)}</span></div>
      <div class="report-meta"><b>${escapeHtml(report.depthLabel)}</b> · ${road} · ${escapeHtml(report.age)}</div>
    </div>
    <div class="report-confirmed">${avatarStack(seed)} <span>${people} confirmed</span></div>
    <div class="report-actions"><button class="report-action ${isVerified ? 'confirmed' : ''}" data-confirm-report="${report.id}">${actionText}</button><button class="report-action" data-clear-report="${report.id}">Cleared</button></div>
  </div>`;
}

function renderReports() {
  const list = $('#reportList');
  if (!list) return;
  if (!state.reports.length) {
    list.innerHTML = `<div class="report-empty" style="padding:18px;color:var(--muted);font-size:12px;">No active reports yet. Be the first to share what you see.</div>`;
    return;
  }
  list.innerHTML = state.reports.map(reportMarkup).join('');
  // Wire the per-row action buttons.
  $$('[data-confirm-report], [data-clear-report]').forEach((btn) => {
    btn.onclick = () => handleReportAction(btn);
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------- render: map ---------------------------------- */

function renderMapPins() {
  const stage = $('.map-stage');
  if (!stage) return;
  // Remove previously rendered live pins (keep decorative layers/labels).
  $$('.map-pin.dynamic').forEach((p) => p.remove());

  const levelIcon = { red: '!', amber: '!', green: '✓' };
  for (const r of state.reports.slice(0, 12)) {
    const pin = document.createElement('div');
    pin.className = `map-pin pin-${r.level} dynamic`;
    pin.style.left = `${(r.mapX * 100).toFixed(2)}%`;
    pin.style.top = `${(r.mapY * 100).toFixed(2)}%`;
    pin.dataset.report = r.place;
    pin.innerHTML = `<span>${levelIcon[r.level] || '!'}</span><label>${escapeHtml(r.place)}</label>`;
    pin.addEventListener('click', () => {
      const tooltip = $('#mapTooltip');
      tooltip.innerHTML = `<strong>${escapeHtml(r.place)}</strong><span>${escapeHtml(r.depthLabel)} · ${escapeHtml(r.age)} · ${r.confirmations} confirmed</span>`;
      tooltip.classList.add('visible');
      clearTimeout(tooltip.timer);
      tooltip.timer = setTimeout(() => tooltip.classList.remove('visible'), 3600);
    });
    stage.appendChild(pin);
  }

  // Update the "active reports" summary chip.
  const summary = $('.map-summary strong');
  if (summary) summary.innerHTML = `<span class="summary-icon">≈</span> ${state.reports.length} active report${state.reports.length === 1 ? '' : 's'}`;

  // Update the sidebar badge count.
  const badge = $('.nav-item[data-nav="reports"] .nav-count');
  if (badge) badge.textContent = String(state.reports.length);
}

/* ------------------------------- data loading -------------------------------- */

async function loadReports() {
  try {
    const { reports } = await JalApi.listReports();
    state.reports = reports || [];
  } catch (e) {
    // Offline or server down: keep whatever we have; show a gentle note once.
    if (!state.reports.length) showToast('Showing saved view — reconnect for live reports');
  }
  renderReports();
  renderMapPins();
}

async function loadConfig() {
  try {
    const cfg = await JalApi.getConfig();
    state.cityBBox = cfg.cityBBox;
  } catch {}
}

async function loadPlaces() {
  try {
    const { places } = await JalApi.listPlaces();
    renderPlaces(places || []);
  } catch { /* not signed in yet — leave the demo places */ }
}

function renderPlaces(places) {
  const wrap = $('.place-list');
  if (!wrap || !places.length) return;
  const symbol = { Home: '⌂', Work: '▦', School: '□' };
  const statusClass = { clear: 'safe', watch: 'watch', danger: 'watch' };
  const statusText = { clear: 'Clear', watch: 'Watch', danger: 'Alert' };
  wrap.innerHTML = places.map((p) => {
    const near = p.nearest ? `<small>${escapeHtml(p.nearest.place)} · ${p.nearest.distanceM}m</small>` : '<small>No reports nearby</small>';
    return `<button class="place-row" data-place="${escapeHtml(p.label)}" data-place-id="${p.id}">
      <span class="place-symbol ${(p.label || '').toLowerCase()}">${symbol[p.label] || '◌'}</span>
      <span><strong>${escapeHtml(p.label)}</strong>${near}</span>
      <span class="place-status ${statusClass[p.status] || 'safe'}">${statusText[p.status] || 'Clear'}</span>
    </button>`;
  }).join('');
  $$('.place-row').forEach((row) => {
    row.onclick = () => {
      const p = places.find((x) => x.id === row.dataset.placeId);
      if (p && p.nearest) showToast(`${p.label}: ${p.nearest.level === 'red' ? 'flooding' : 'water'} reported ${p.nearest.distanceM}m away`);
      else showToast(`${row.dataset.place} — clear nearby`);
    };
  });
}


/* --------------------------------- modal ------------------------------------- */

function openReport() {
  state.modalStep = 'safety';
  $('#reportModal').classList.remove('hidden');
  showModalStep('safety');
  document.body.style.overflow = 'hidden';
  requestGps();
}
function closeReport() {
  $('#reportModal').classList.add('hidden');
  document.body.style.overflow = '';
}
function showModalStep(step) {
  state.modalStep = step;
  $$('.modal-step').forEach((s) => s.classList.remove('active-step'));
  const el = $(`#reportStep${step.charAt(0).toUpperCase()}${step.slice(1)}`);
  if (el) el.classList.add('active-step');
  const bars = $$('.modal-progress span');
  const order = ['safety', 'form', 'done'];
  bars.forEach((b, i) => b.classList.toggle('active', i <= order.indexOf(step)));
}

/* --------------------------- GPS + photo capture ------------------------------ */

function requestGps() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.gps = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const input = $('#reportLocation');
      if (input && state.gps) {
        input.value = `${state.gps.lat.toFixed(4)}, ${state.gps.lng.toFixed(4)}`;
      }
    },
    () => { /* user denied or unavailable — they can still type a location */ },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
  );
}

function wirePhotoCapture() {
  const dz = $('#photoDropzone');
  if (!dz) return;
  // Replace the placeholder click with a real file input.
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment'; // prefer rear camera on phones
  input.style.display = 'none';
  dz.parentElement.appendChild(input);

  dz.onclick = () => input.click();
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    compressImage(file, 1024, 0.7).then((dataUrl) => {
      state.photoDataUrl = dataUrl;
      dz.innerHTML = `<span class="camera-icon">✓</span><div><strong>Photo ready</strong><small>${Math.round(dataUrl.length / 1370)} KB · tap to change</small></div><span class="dropzone-arrow">↻</span>`;
    }).catch(() => showToast('Could not read that photo'));
  };
}

/** Downscale an image file to a max dimension + JPEG quality (data URL). */
function compressImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}


/* --------------------------------- submit ------------------------------------ */

async function submitReport() {
  // Resolve coordinates: prefer GPS; else fall back to city centre so the
  // report still lands (user can refine). Never block submission on GPS.
  let lat = state.gps?.lat, lng = state.gps?.lng;
  if (lat == null && state.cityBBox) {
    lat = (state.cityBBox.minLat + state.cityBBox.maxLat) / 2;
    lng = (state.cityBBox.minLng + state.cityBBox.maxLng) / 2;
  }
  if (lat == null) { lat = 12.9141; lng = 74.8560; } // Mangaluru fallback

  const place = ($('#reportLocation')?.value || 'Reported location').trim();
  const depthKey = Object.keys(DEPTH_TO_KEY).find((k) => DEPTH_TO_KEY[k] === state.depth) || 'knee';
  const note = $('#reportNote')?.value || '';
  const roadBlocked = !!$('#blockedToggle')?.checked;

  const btn = $('#submitReport');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    const result = await JalApi.submitReport({
      lat, lng, place, depth: depthKey, roadBlocked, note,
      photo: state.photoDataUrl || undefined
    });
    showModalStep('done');
    if (result.queued) {
      $('#reportStepDone .queue-status strong').textContent = 'Saved — will send when online';
      $('#reportStepDone .queue-status small').textContent = 'No signal right now. Your report is safe on this device.';
    } else {
      $('#reportStepDone .queue-status strong').textContent = 'Report shared with your community';
      $('#reportStepDone .queue-status small').textContent = 'Neighbours nearby can now see it. Thank you.';
      loadReports();
    }
    // Reset capture state for next time.
    state.photoDataUrl = null;
  } catch (e) {
    showToast(e.message || 'Could not send report');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = 'Add to offline queue <span>↥</span>'; }
  }
}

/* ------------------------- verification (confirm/clear) ----------------------- */

async function handleReportAction(button) {
  const confirmId = button.dataset.confirmReport;
  const clearId = button.dataset.clearReport;
  const id = Number(confirmId || clearId);
  const report = state.reports.find((r) => r.id === id);
  if (!report) return;

  const kind = confirmId ? 'still-flooded' : 'cleared';
  try {
    const result = await JalApi.confirm(id, kind);
    // Update local state from the server's authoritative response.
    const idx = state.reports.findIndex((r) => r.id === id);
    if (idx >= 0 && result.report) state.reports[idx] = result.report;
    if (kind === 'still-flooded') state.verified.add(id);
    renderReports();
    renderMapPins();
    showToast(kind === 'still-flooded'
      ? `Thanks — ${report.place} marked as still flooded`
      : `${report.place} marked as cleared`);
  } catch (e) {
    showToast(e.message || 'Could not record that');
  }
}

/* ------------------------------- route check --------------------------------- */

async function checkRoute() {
  const from = ($('#routeFrom')?.value || '').trim();
  const to = ($('#routeTo')?.value || '').trim();
  const result = $('#routeResult');
  if (!from || !to) { showToast('Enter a start and a destination'); return; }

  // Geocode the free-text endpoints against seeded hotspots (best-effort).
  const fromPt = await geocode(from);
  const toPt = await geocode(to);
  if (!fromPt || !toPt) {
    result.classList.remove('hidden');
    result.innerHTML = `<strong>Couldn't find those places.</strong> Try a known area like Kottara, Pumpwell, or Hampankatta.`;
    return;
  }

  try {
    const data = await JalApi.routeCheck(fromPt, toPt);
    state.routeChecked = true;
    result.classList.remove('hidden', 'success');
    const levelWord = data.worstLevel === 'red' ? 'Avoid' : data.worstLevel === 'amber' ? 'Caution' : 'Clear';
    const list = data.affected.slice(0, 3).map((a) => `${a.report.place} (${a.distanceToRouteM}m)`).join(', ');
    result.innerHTML = `<strong>${levelWord}:</strong> ${escapeHtml(data.advisory)}${list ? `<br><small>Near route: ${escapeHtml(list)}</small>` : ''}`;
    showToast(`Route checked: ${from} → ${to}`);
  } catch (e) {
    showToast(e.message || 'Route check failed');
  }
}

// Simple name → coordinates resolver using seeded hotspots + a few aliases.
async function geocode(name) {
  const n = name.toLowerCase();
  const aliases = {
    'kadri': { lat: 12.8890, lng: 74.8600 }, 'kadri park': { lat: 12.8890, lng: 74.8600 },
    'hampankatta': { lat: 12.8720, lng: 74.8430 }, 'bunder': { lat: 12.8720, lng: 74.8430 },
    'kottara': { lat: 12.9505, lng: 74.8840 }, 'pumpwell': { lat: 12.8920, lng: 74.8730 },
    'bejai': { lat: 12.8790, lng: 74.8520 }, 'padil': { lat: 12.8420, lng: 74.8610 },
    'bajal': { lat: 12.8230, lng: 74.8700 }, 'kulur': { lat: 12.9330, lng: 74.8580 }
  };
  if (aliases[n]) return aliases[n];
  try {
    const { hotspots } = await JalApi.listHotspots();
    const hit = hotspots.find((h) => h.name.toLowerCase().includes(n) || (h.area || '').toLowerCase().includes(n));
    if (hit) return { lat: hit.lat, lng: hit.lng };
  } catch {}
  return null;
}

/* ----------------------------- offline indicators ---------------------------- */

function wireConnectivity() {
  const chip = $('#networkStatus');
  const update = () => {
    const online = JalApi.isOnline();
    const queued = JalApi.offlineQueueCount();
    if (chip) {
      chip.innerHTML = online
        ? `<span class="status-dot"></span>${queued ? `${queued} to sync` : 'Monsoon mode'}`
        : `<span class="status-dot" style="background:var(--amber)"></span>Offline`;
    }
  };
  JalApi.on('online', update);
  JalApi.on('queue', update);
  JalApi.on('synced', (n) => { update(); showToast(`${n} queued report${n === 1 ? '' : 's'} sent`); loadReports(); });
  update();
}


/* ------------------------------- nav + wiring -------------------------------- */

function setActiveNav(target) {
  $$('.nav-item, .mobile-nav-item').forEach((item) => item.classList.toggle('active', item.dataset.nav === target));
  const map = { overview: '#mapCard', reports: '#reportsCard', route: '#routeCard', saved: '#savedCard' };
  const el = $(map[target]);
  if (el && target !== 'overview') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function wireUI() {
  // Open / close the report modal.
  $$('[data-open-report]').forEach((b) => (b.onclick = openReport));
  $$('[data-close-report]').forEach((b) => (b.onclick = closeReport));
  $('[data-back-safety]').onclick = () => showModalStep('safety');
  $('#continueReport').onclick = () => showModalStep('form');
  $('#submitReport').onclick = submitReport;

  // Route + saved places + misc.
  $('#checkRoute').onclick = checkRoute;
  $('#locateButton').onclick = () => showToast('Centering on your area…');
  $('#managePlaces').onclick = () => showToast('Saved places sync to your account');
  $('#offlineBanner .banner-close').onclick = () => $('#offlineBanner').classList.add('hidden');

  // Voice note (UI affordance; recording itself is a V2 item).
  $('#voiceButton').onclick = () => {
    const b = $('#voiceButton');
    b.classList.toggle('recording');
    b.querySelector('small').textContent = b.classList.contains('recording') ? 'Recording… tap to stop' : 'Tap to record';
    b.querySelector('.voice-time').textContent = b.classList.contains('recording') ? '0:05' : '0:00';
  };

  // Depth selector.
  $$('.depth-option').forEach((btn) => (btn.onclick = () => {
    state.depth = btn.dataset.depth;
    $$('.depth-option').forEach((o) => o.classList.toggle('active', o === btn));
  }));

  // Nav (sidebar, mobile, and in-page links).
  $$('.nav-item, .mobile-nav-item, .text-button[data-nav]').forEach((b) => (b.onclick = () => setActiveNav(b.dataset.nav)));

  // Feed segmented control.
  $$('.segment').forEach((seg) => (seg.onclick = () => {
    $$('.segment').forEach((s) => s.classList.toggle('active', s === seg));
    if (seg.textContent.trim() === 'Most confirmed') {
      state.reports = [...state.reports].sort((a, b) => (b.confirmations || 0) - (a.confirmations || 0));
    } else {
      state.reports = [...state.reports].sort((a, b) => b.createdAt - a.createdAt);
    }
    renderReports();
  }));

  $('#loadMore').onclick = () => showToast('All recent reports are shown');

  wirePhotoCapture();
}

/* ----------------------------------- boot ------------------------------------ */

async function boot() {
  wireUI();
  wireConnectivity();
  await loadConfig();
  await loadReports();
  await loadPlaces();

  // Live updates: fold new/updated reports into the current view.
  JalApi.subscribeLive(
    (report) => {
      if (!state.reports.some((r) => r.id === report.id)) {
        state.reports.unshift(report);
        renderReports();
        renderMapPins();
      }
    },
    (report) => {
      const idx = state.reports.findIndex((r) => r.id === report.id);
      if (idx >= 0) state.reports[idx] = report;
      else state.reports.unshift(report);
      renderReports();
      renderMapPins();
    }
  );

  // Periodic refresh so ages and expiry stay fresh without a manual reload.
  setInterval(loadReports, 60000);
}

document.addEventListener('DOMContentLoaded', boot);

