// ============================================================
// TRACKER GPS LIVE - Version complète finale
// ============================================================

const BACKEND_URL = 'https://localisation-backend-sm3t.onrender.com';
const REFRESH_INTERVAL = 2000;
const SEND_INTERVAL = 2000;
const TRAIL_MAX_POINTS = 150;
const MAX_ZOOM = 21;
const MAX_ACCURACY = 20;
const TRAIL_MIN_MOVE = 8;
const MIN_MOVE_UPDATE = 2;
const PRECISION_SAMPLES = 5;
const GEOCODE_CACHE = {};

fetch(BACKEND_URL + '/api/ping').catch(() => {});

// ============================================================
// CARTE
// ============================================================
const map = L.map('map', { maxZoom: MAX_ZOOM, zoomControl: false }).setView([6.13, 1.22], 15);

const planLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap', maxZoom: MAX_ZOOM, maxNativeZoom: 19
});
const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri', maxZoom: MAX_ZOOM, maxNativeZoom: 19
});

let currentMode = 'plan';
planLayer.addTo(map);

function toggleSatellite() {
    if (currentMode === 'plan') {
        map.removeLayer(planLayer);
        satelliteLayer.addTo(map);
        currentMode = 'satellite';
        document.getElementById('satBtn').innerHTML = '<i class="fas fa-map"></i>';
    } else {
        map.removeLayer(satelliteLayer);
        planLayer.addTo(map);
        currentMode = 'plan';
        document.getElementById('satBtn').innerHTML = '<i class="fas fa-satellite"></i>';
    }
}

L.control.zoom({ position: 'bottomright' }).addTo(map);

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ============================================================
// FILTRE KALMAN
// ============================================================
class KalmanFilter {
    constructor() { this.reset(); }
    reset() { this.lat = null; this.lng = null; this.variance = -1; }
    process(lat, lng, accuracy) {
        if (this.lat === null) {
            this.lat = lat; this.lng = lng;
            this.variance = accuracy * accuracy;
            return { lat, lng };
        }
        const variance = this.variance + 0.01;
        const gain = variance / (variance + accuracy * accuracy);
        this.lat = this.lat + gain * (lat - this.lat);
        this.lng = this.lng + gain * (lng - this.lng);
        this.variance = (1 - gain) * variance;
        return { lat: this.lat, lng: this.lng };
    }
}

// ============================================================
// FILTRE STABILITÉ
// ============================================================
class StabilityFilter {
    constructor() {
        this.samples = [];
        this.lastStable = null;
    }
    add(lat, lng, accuracy) {
        if (accuracy > 25) return null;
        this.samples.push({ lat, lng, accuracy });
        if (this.samples.length > 8) this.samples.shift();
        
        let totalWeight = 0, weightedLat = 0, weightedLng = 0, totalAcc = 0;
        for (const s of this.samples) {
            const weight = 1 / (s.accuracy * s.accuracy);
            totalWeight += weight;
            weightedLat += s.lat * weight;
            weightedLng += s.lng * weight;
            totalAcc += s.accuracy;
        }
        if (totalWeight === 0) return null;
        
        const avgLat = weightedLat / totalWeight;
        const avgLng = weightedLng / totalWeight;
        const avgAcc = totalAcc / this.samples.length;
        
        if (this.lastStable) {
            const dist = calcDistance(this.lastStable.lat, this.lastStable.lng, avgLat, avgLng);
            if (dist < 5) return { ...this.lastStable, unchanged: true };
        }
        
        this.lastStable = { lat: avgLat, lng: avgLng, accuracy: avgAcc };
        return this.lastStable;
    }
}

const kalmanFilters = {};
const stabilityFilters = {};

// ============================================================
// THÈME
// ============================================================
function toggleTheme() {
    document.body.classList.toggle('light');
    const icon = document.getElementById('themeIcon');
    icon.className = document.body.classList.contains('light') ? 'fas fa-sun' : 'fas fa-moon';
    localStorage.setItem('tracker_theme', document.body.classList.contains('light') ? 'light' : 'dark');
}
if (localStorage.getItem('tracker_theme') === 'light') {
    document.body.classList.add('light');
    document.getElementById('themeIcon').className = 'fas fa-sun';
}

// ============================================================
// ID ADMIN
// ============================================================
let userId = localStorage.getItem('tracker_user_id');
if (!userId) {
    userId = 'admin_' + Math.random().toString(36).substring(2, 10);
    localStorage.setItem('tracker_user_id', userId);
}

// ============================================================
// WAKE LOCK
// ============================================================
let wakeLock = null;
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {}
}
window.addEventListener('load', requestWakeLock);
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && wakeLock === null) await requestWakeLock();
});

// ============================================================
// UTILITAIRES
// ============================================================
function calcDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function formatDist(m) {
    if (m < 1) return '0 m';
    if (m < 1000) return Math.round(m) + ' m';
    return (m/1000).toFixed(2) + ' km';
}
function getAccuracyLabel(acc) {
    if (acc <= 10) return { text: 'Excellent', color: '#28c840' };
    if (acc <= 25) return { text: 'Bon', color: '#28c840' };
    if (acc <= 50) return { text: 'Moyen', color: '#ffbd2e' };
    return { text: 'Faible', color: '#ff5f57' };
}
function getArrow(bearing) {
    if (bearing >= 337.5 || bearing < 22.5) return '↑';
    if (bearing >= 22.5 && bearing < 67.5) return '↗';
    if (bearing >= 67.5 && bearing < 112.5) return '→';
    if (bearing >= 112.5 && bearing < 157.5) return '↘';
    if (bearing >= 157.5 && bearing < 202.5) return '↓';
    if (bearing >= 202.5 && bearing < 247.5) return '↙';
    if (bearing >= 247.5 && bearing < 292.5) return '←';
    return '↖';
}
function calcBearing(lat1, lng1, lat2, lng2) {
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const l1 = lat1 * Math.PI / 180, l2 = lat2 * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(l2);
    const x = Math.cos(l1) * Math.sin(l2) - Math.sin(l1) * Math.cos(l2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ============================================================
// ADRESSE
// ============================================================
async function getAddress(lat, lng) {
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (GEOCODE_CACHE[key]) return GEOCODE_CACHE[key];
    try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 5000);
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=fr`, {
            signal: c.signal, headers: { 'User-Agent': 'TrackerGPS/1.0' }
        });
        clearTimeout(t);
        const data = await r.json();
        const addr = data.display_name?.split(',').slice(0, 2).join(',') || '';
        GEOCODE_CACHE[key] = addr;
        return addr;
    } catch (e) { return ''; }
}

// ============================================================
// BIP SONORE
// ============================================================
let audioContext = null;
function playBeep() {
    try {
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.connect(gain);
        gain.connect(audioContext.destination);
        osc.frequency.value = 800;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.1, audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
        osc.start();
        osc.stop(audioContext.currentTime + 0.2);
    } catch (e) {}
}

// ============================================================
// TALKIE-WALKIE
// ============================================================
let callEngine = null;
let currentCall = null;

function initCall() {
    if (typeof EasyCall !== 'undefined') {
        callEngine = new EasyCall({ stunServers: ['stun:stun.l.google.com:19302'] });
        callEngine.on('incoming', (call) => {
            const callerName = call.metadata?.name || 'Inconnu';
            if (confirm(`📞 ${callerName} vous appelle. Accepter ?`)) {
                call.answer();
                currentCall = call;
                showCallUI(callerName);
                call.on('ended', () => hideCallUI());
            } else call.reject();
        });
    }
}

async function callUser(targetUserId) {
    if (!callEngine) return alert('Talkie-walkie non prêt');
    const target = markers[targetUserId];
    if (!target) return;
    try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        currentCall = await callEngine.call(targetUserId, { metadata: { name: 'Admin' } });
        showCallUI(target.name || 'Utilisateur');
        currentCall.on('connected', () => updateStatusBar(`📞 Connecté à ${target.name}`, '#28c840'));
        currentCall.on('ended', () => { hideCallUI(); updateStatusBar('📞 Appel terminé', '#ffbd2e'); });
        currentCall.on('error', (e) => { updateStatusBar('❌ ' + e.message, '#ff5f57'); setTimeout(hideCallUI, 3000); });
    } catch (e) { alert('Micro refusé: ' + e.message); }
}

function endCall() {
    if (currentCall) { currentCall.end(); currentCall = null; hideCallUI(); }
}

function showCallUI(name) {
    let ui = document.getElementById('callUI');
    if (!ui) {
        ui = document.createElement('div');
        ui.id = 'callUI';
        ui.className = 'call-ui';
        ui.innerHTML = `
            <div class="call-avatar">📞</div>
            <div style="font-size:1.2rem;font-weight:700;margin-bottom:.5rem;" id="callName"></div>
            <div style="color:rgba(255,255,255,.5);font-size:.9rem;">Appel en cours...</div>
            <button class="call-btn-end" onclick="endCall()"><i class="fas fa-phone-slash"></i> Raccrocher</button>
        `;
        document.body.appendChild(ui);
    }
    document.getElementById('callName').textContent = name;
    ui.classList.add('show');
}

function hideCallUI() {
    const ui = document.getElementById('callUI');
    if (ui) ui.classList.remove('show');
    if (currentCall) { currentCall.end(); currentCall = null; }
}

// ============================================================
// ENVOI ADMIN
// ============================================================
let adminInterval = null;
let adminLastSent = null;
let isSendingAdmin = false;
const adminFilter = new KalmanFilter();

function getPosition() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) { reject(new Error('Non supportée')); return; }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true, timeout: 30000, maximumAge: 0
        });
    });
}

async function sendAdminPosition() {
    if (isSendingAdmin) return;
    isSendingAdmin = true;
    try {
        const pos = await getPosition();
        const acc = pos.coords.accuracy;
        if (acc > MAX_ACCURACY) {
            updateStatusBar(`❌ Précision ${Math.round(acc)}m`, '#ff5f57');
            return;
        }
        const filtered = adminFilter.process(pos.coords.latitude, pos.coords.longitude, acc);
        if (adminLastSent) {
            const dist = calcDistance(adminLastSent.lat, adminLastSent.lng, filtered.lat, filtered.lng);
            if (dist < MIN_MOVE_UPDATE) {
                const label = getAccuracyLabel(acc);
                updateStatusBar(`📍 Stable ±${Math.round(acc)}m (${label.text})`, label.color);
                return;
            }
        }
        adminLastSent = filtered;
        const label = getAccuracyLabel(acc);
        updateStatusBar(`📍 ${filtered.lat.toFixed(6)}, ${filtered.lng.toFixed(6)} — ${label.text} ±${Math.round(acc)}m`, label.color);
        await fetch(BACKEND_URL + '/api/position', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: userId, name: 'Admin',
                lat: filtered.lat, lng: filtered.lng,
                speed: pos.coords.speed || 0, accuracy: acc,
                heading: pos.coords.heading || 0, altitude: pos.coords.altitude || 0
            })
        });
    } catch (e) {
        updateStatusBar('❌ ' + e.message, '#ff5f57');
    } finally { isSendingAdmin = false; }
}

function updateStatusBar(msg, color) {
    const el = document.getElementById('statusBar');
    if (el) { el.textContent = msg; el.style.color = color || '#ffbd2e'; }
}

function startAdminSharing() {
    if (adminInterval) return;
    sendAdminPosition();
    adminInterval = setInterval(sendAdminPosition, SEND_INTERVAL);
}

// ============================================================
// STOCKAGE
// ============================================================
const markers = {};
const trails = {};
const histories = {};
const totalDistances = {};
const addresses = {};
const knownUsers = new Set();
const maxSpeeds = {};
const userStatuses = {};
const colors = ['#00d4ff', '#7b2ffc', '#ff5f57', '#ffbd2e', '#28c840', '#ff8c00', '#00ff88', '#ff00ff', '#ff69b4', '#00ced1'];
let colorIndex = 0;
let currentFilter = 'all';
let currentSort = 'age';

function getColor(uid) {
    if (!markers[uid]) {
        colorIndex = (colorIndex + 1) % colors.length;
        return colors[colorIndex];
    }
    return markers[uid].color;
}

// ============================================================
// ICÔNE
// ============================================================
function createIcon(color, name, bearing, isMe) {
    return L.divIcon({
        className: 'custom-marker',
        html: `<div class="marker-pin ${isMe ? 'me' : ''}" style="background:${color};"><span>${name.charAt(0).toUpperCase()}</span></div>`,
        iconSize: [32, 32], iconAnchor: [16, 32]
    });
}

// ============================================================
// TRAJECTOIRE
// ============================================================
function updateTrail(uid, lat, lng, color) {
    if (!histories[uid]) histories[uid] = [];
    const h = histories[uid];
    if (h.length > 0) {
        const last = h[h.length - 1];
        const dist = calcDistance(last[0], last[1], lat, lng);
        if (dist < TRAIL_MIN_MOVE) return;
        if (!totalDistances[uid]) totalDistances[uid] = 0;
        totalDistances[uid] += dist;
    }
    h.push([lat, lng]);
    if (h.length > TRAIL_MAX_POINTS) h.shift();
    if (trails[uid]) map.removeLayer(trails[uid]);
    if (h.length > 1) {
        trails[uid] = L.polyline(h, { color, weight: 3, opacity: 0.6, smoothFactor: 2 }).addTo(map);
    }
}

// ============================================================
// FILTRES ET TRI
// ============================================================
function setFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    fetchPositions();
}

function setSort(sort) {
    currentSort = sort;
    document.querySelectorAll('.sort-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sort === sort);
    });
    fetchPositions();
}

function applyFilterAndSort(positions) {
    let filtered = [...positions];
    if (currentFilter === 'active') filtered = filtered.filter(p => p.age_seconds < 10);
    else if (currentFilter === 'mobile') filtered = filtered.filter(p => userStatuses[p.user_id] === 'mobile');
    else if (currentFilter === 'immobile') filtered = filtered.filter(p => userStatuses[p.user_id] === 'immobile');
    
    filtered.sort((a, b) => {
        if (a.user_id === userId) return -1;
        if (b.user_id === userId) return 1;
        switch (currentSort) {
            case 'age': return a.age_seconds - b.age_seconds;
            case 'name': return a.name.localeCompare(b.name);
            case 'speed': return (b.speed || 0) - (a.speed || 0);
            case 'distance': return (totalDistances[b.user_id] || 0) - (totalDistances[a.user_id] || 0);
            default: return 0;
        }
    });
    return filtered;
}

// ============================================================
// LISTE
// ============================================================
let lastListHTML = '';
function updateUsersList(positions) {
    const list = document.getElementById('userList');
    const countEl = document.getElementById('userCount');
    if (countEl) countEl.textContent = positions.length;
    if (!list) return;
    
    const filtered = applyFilterAndSort(positions);
    
    let html = `
        <div class="filters-bar">
            <button class="filter-btn ${currentFilter === 'all' ? 'active' : ''}" data-filter="all" onclick="setFilter('all')">Tous</button>
            <button class="filter-btn ${currentFilter === 'active' ? 'active' : ''}" data-filter="active" onclick="setFilter('active')">Actifs</button>
            <button class="filter-btn ${currentFilter === 'mobile' ? 'active' : ''}" data-filter="mobile" onclick="setFilter('mobile')">Mobiles</button>
            <button class="filter-btn ${currentFilter === 'immobile' ? 'active' : ''}" data-filter="immobile" onclick="setFilter('immobile')">Immobiles</button>
        </div>
        <div class="sort-bar">
            <button class="sort-btn ${currentSort === 'age' ? 'active' : ''}" onclick="setSort('age')">⏱️ Âge</button>
            <button class="sort-btn ${currentSort === 'name' ? 'active' : ''}" onclick="setSort('name')">🔤 Nom</button>
            <button class="sort-btn ${currentSort === 'speed' ? 'active' : ''}" onclick="setSort('speed')">🚀 Vitesse</button>
            <button class="sort-btn ${currentSort === 'distance' ? 'active' : ''}" onclick="setSort('distance')">📏 Distance</button>
        </div>
    `;
    
    if (filtered.length === 0) {
        html += '<div class="empty"><i class="fas fa-satellite-dish"></i>Aucun résultat</div>';
    } else {
        html += filtered.map(p => {
            const age = p.age_seconds;
            const ageText = age < 60 ? `${age}s` : `${Math.floor(age/60)}min`;
            const speedKmh = (p.speed || 0) * 3.6;
            const color = markers[p.user_id]?.color || '#00d4ff';
            const isMe = p.user_id === userId;
            const accLabel = getAccuracyLabel(p.accuracy || 0);
            const addr = addresses[p.user_id] || '...';
            const totalDist = totalDistances[p.user_id] || 0;
            const maxSpeed = maxSpeeds[p.user_id] || 0;
            const status = userStatuses[p.user_id] || 'immobile';
            
            return `<div class="user-item ${isMe ? 'me' : ''}" onclick="selectUser('${p.user_id}')">
                <div class="avatar" style="background:${color}">${p.name.charAt(0).toUpperCase()}</div>
                <div class="info">
                    <div class="name">
                        ${p.name} ${isMe ? '⭐' : ''}
                        <span class="status-badge status-${status}">${status === 'mobile' ? '🚶 Mobile' : '⏸️ Immobile'}</span>
                    </div>
                    <div class="address">📍 ${addr}</div>
                    <div class="coords">${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</div>
                    <div class="meta">
                        <span><i class="fas fa-clock"></i> ${ageText}</span>
                        <span style="color:${accLabel.color}"><i class="fas fa-bullseye"></i> ±${Math.round(p.accuracy || 0)}m</span>
                        ${speedKmh > 0.5 ? `<span><i class="fas fa-tachometer-alt"></i> ${speedKmh.toFixed(1)}km/h</span>` : ''}
                        ${maxSpeed > 0 ? `<span><i class="fas fa-rocket"></i> Max ${maxSpeed.toFixed(1)}</span>` : ''}
                        ${totalDist > 0 ? `<span><i class="fas fa-route"></i> ${formatDist(totalDist)}</span>` : ''}
                    </div>
                </div>
            </div>`;
        }).join('');
    }
    
    if (html !== lastListHTML) {
        list.innerHTML = html;
        lastListHTML = html;
        filtered.forEach(p => {
            if (!addresses[p.user_id]) {
                getAddress(p.lat, p.lng).then(a => { if (a) addresses[p.user_id] = a; });
            }
        });
    }
}

// ============================================================
// CARTE
// ============================================================
function updateMap(positions) {
    const activeIds = new Set();
    positions.forEach(p => {
        activeIds.add(p.user_id);
        
        // Détecter nouveaux utilisateurs
        if (!knownUsers.has(p.user_id)) {
            knownUsers.add(p.user_id);
            if (p.user_id !== userId) {
                playBeep();
                updateStatusBar(`🔔 Nouvel utilisateur: ${p.name}`, '#28c840');
            }
        }
        
        // Stats
        const speedKmh = (p.speed || 0) * 3.6;
        if (!maxSpeeds[p.user_id] || speedKmh > maxSpeeds[p.user_id]) {
            maxSpeeds[p.user_id] = speedKmh;
        }
        userStatuses[p.user_id] = speedKmh > 1 ? 'mobile' : 'immobile';
        
        const color = getColor(p.user_id);
        const isMe = p.user_id === userId;
        
        // Filtres
        if (!kalmanFilters[p.user_id]) kalmanFilters[p.user_id] = new KalmanFilter();
        if (!stabilityFilters[p.user_id]) stabilityFilters[p.user_id] = new StabilityFilter();
        
        const smooth = kalmanFilters[p.user_id].process(p.lat, p.lng, p.accuracy || 10);
        const stable = stabilityFilters[p.user_id].add(smooth.lat, smooth.lng, p.accuracy || 10);
        
        if (!stable) return;
        if (stable.unchanged && markers[p.user_id]) return;
        
        let bearing = null;
        if (histories[p.user_id]?.length > 0) {
            const last = histories[p.user_id][histories[p.user_id].length - 1];
            if (last[0] !== stable.lat || last[1] !== stable.lng) {
                bearing = calcBearing(last[0], last[1], stable.lat, stable.lng);
            }
        }
        
        if (markers[p.user_id]) {
            markers[p.user_id].marker.setLatLng([stable.lat, stable.lng]);
            markers[p.user_id].marker.setIcon(createIcon(color, p.name, bearing, isMe));
        } else {
            const marker = L.marker([stable.lat, stable.lng], { icon: createIcon(color, p.name, bearing, isMe) }).addTo(map);
            marker.bindPopup(`
                <div style="font-family:sans-serif;min-width:180px;">
                    <b>${p.name}${isMe ? ' ⭐' : ''}</b><br>
                    <span style="color:#00d4ff;">${stable.lat.toFixed(6)}, ${stable.lng.toFixed(6)}</span><br>
                    🎯 ±${Math.round(stable.accuracy)}m<br>
                    <button onclick="callUser('${p.user_id}')" style="margin-top:8px;padding:6px 12px;background:#28c840;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">📞 Appeler</button>
                    <button onclick="openGoogleMaps(${stable.lat}, ${stable.lng})" style="margin-top:8px;margin-left:5px;padding:6px 12px;background:#4285f4;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">🗺️ Maps</button>
                </div>
            `);
            markers[p.user_id] = { marker, color, name: p.name };
        }
        
        updateTrail(p.user_id, stable.lat, stable.lng, color);
    });
    
    Object.keys(markers).forEach(uid => {
        if (!activeIds.has(uid)) {
            map.removeLayer(markers[uid].marker);
            delete markers[uid];
            if (trails[uid]) { map.removeLayer(trails[uid]); delete trails[uid]; }
            delete histories[uid];
            delete kalmanFilters[uid];
            delete stabilityFilters[uid];
        }
    });
}

// ============================================================
// ACTIONS
// ============================================================
function focusUser(uid) {
    if (markers[uid]) {
        map.setView(markers[uid].marker.getLatLng(), 17, { animate: true });
        markers[uid].marker.openPopup();
    }
}
function selectUser(uid) { focusUser(uid); }
function openGoogleMaps(lat, lng) {
    window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank');
}
function resetView() { map.setView([6.13, 1.22], 2, { animate: true }); }
function followMe() {
    if (markers[userId]) map.setView(markers[userId].marker.getLatLng(), 18, { animate: true });
    else alert('Position en cours...');
}
function fitAll() {
    const latlngs = Object.values(markers).map(m => m.marker.getLatLng());
    if (latlngs.length > 0) map.fitBounds(latlngs, { padding: [50, 50], maxZoom: 18 });
}
function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
}
function toggleSidebar() {
    const s = document.querySelector('.sidebar');
    const i = document.getElementById('toggleIcon');
    if (s) {
        s.classList.toggle('collapsed');
        if (i) i.className = s.classList.contains('collapsed') ? 'fas fa-chevron-left' : 'fas fa-chevron-right';
    }
}
function exportGPX() {
    const h = histories[userId];
    if (!h || h.length < 2) { alert('Pas assez de points'); return; }
    let gpx = '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>';
    h.forEach(pt => { gpx += `<trkpt lat="${pt[0]}" lon="${pt[1]}"></trkpt>`; });
    gpx += '</trkseg></trk></gpx>';
    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trajectoire_${userId}.gpx`;
    a.click();
}
function updateClock() {
    const el = document.getElementById('clock');
    if (el) el.textContent = new Date().toLocaleTimeString('fr-FR');
}

// ============================================================
// REFRESH
// ============================================================
let attempts = 0;
async function fetchPositions() {
    try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 10000);
        const r = await fetch(BACKEND_URL + '/api/positions', { signal: c.signal });
        clearTimeout(t);
        if (!r.ok) throw new Error();
        const data = await r.json();
        updateMap(data.positions);
        updateUsersList(data.positions);
        attempts = 0;
        const d = document.getElementById('liveDot');
        if (d) d.style.background = '#28c840';
    } catch (e) {
        attempts++;
        const d = document.getElementById('liveDot');
        if (d) d.style.background = '#ff5f57';
        setTimeout(fetchPositions, Math.min(1000 * attempts, 3000));
    }
}

// ============================================================
// DÉMARRAGE
// ============================================================
updateClock();
setInterval(updateClock, 1000);
initCall();
startAdminSharing();
fetchPositions();
setInterval(fetchPositions, REFRESH_INTERVAL);

console.log('%c 📍 Tracker GPS LIVE - Version complète finale ✅', 'color:#00d4ff;font-weight:bold;font-size:14px');
console.log('%c Fonctionnalités:', 'color:#28c840;font-weight:bold');
console.log('• Position GPS temps réel');
console.log('• Kalman + Stabilité');
console.log('• Talkie-walkie EasyCall');
console.log('• OSRM itinéraire');
console.log('• Météo Open-Meteo');
console.log('• PWA installable');
console.log('• Export GPX');
console.log('• Thème sombre/clair');
console.log('• Filtres et tri');
console.log('• Vitesse max + distance');
console.log('• Statut mobile/immobile');
console.log('• Bip sonore');
console.log('• Google Maps');
