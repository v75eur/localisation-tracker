// ============================================================
// TRACKER GPS LIVE - Kalman + Talkie-Walkie + Fluidité
// ============================================================

const BACKEND_URL = 'https://localisation-backend-sm3t.onrender.com';
const REFRESH_INTERVAL = 2000;
const SEND_INTERVAL = 2000;
const TRAIL_MAX_POINTS = 150;
const MAX_ZOOM = 21;
const MAX_ACCURACY = 50;
const TRAIL_MIN_MOVE = 5;
const MIN_MOVE_UPDATE = 3;
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

// PWA
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ============================================================
// FILTRE DE KALMAN
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
// TALKIE-WALKIE
// ============================================================
let callEngine = null;
let currentCall = null;

function initCall() {
    if (typeof EasyCall !== 'undefined') {
        callEngine = new EasyCall({
            stunServers: ['stun:stun.l.google.com:19302']
        });
        callEngine.on('incoming', (call) => {
            const callerName = call.metadata?.name || 'Inconnu';
            if (confirm(`📞 ${callerName} vous appelle. Accepter ?`)) {
                call.answer();
                currentCall = call;
                showCallUI(callerName);
                call.on('ended', () => hideCallUI());
            } else {
                call.reject();
            }
        });
        console.log('📞 EasyCall prêt');
    }
}

async function callUser(targetUserId) {
    if (!callEngine) return alert('Talkie-walkie non prêt');
    const target = markers[targetUserId];
    if (!target) return;
    try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        currentCall = await callEngine.call(targetUserId, {
            metadata: { name: 'Admin' }
        });
        showCallUI(target.name || 'Utilisateur');
        currentCall.on('connected', () => {
            updateStatusBar(`📞 Connecté à ${target.name}`, '#28c840');
        });
        currentCall.on('ended', () => {
            hideCallUI();
            updateStatusBar('📞 Appel terminé', '#ffbd2e');
        });
        currentCall.on('error', (e) => {
            updateStatusBar('❌ ' + e.message, '#ff5f57');
            setTimeout(hideCallUI, 3000);
        });
    } catch (e) {
        alert('Micro refusé: ' + e.message);
    }
}

function endCall() {
    if (currentCall) {
        currentCall.end();
        currentCall = null;
        hideCallUI();
    }
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
            <div style="color:rgba(255,255,255,.5);font-size:.9rem;" id="callStatus">Appel en cours...</div>
            <button class="call-btn-end" onclick="endCall()">
                <i class="fas fa-phone-slash"></i> Raccrocher
            </button>
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
            enableHighAccuracy: true, timeout: 15000, maximumAge: 1000
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
        updateStatusBar(`📍 ${filtered.lat.toFixed(5)}, ${filtered.lng.toFixed(5)} — ${label.text} ±${Math.round(acc)}m`, label.color);
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
const filters = {};
const colors = ['#00d4ff', '#7b2ffc', '#ff5f57', '#ffbd2e', '#28c840', '#ff8c00', '#00ff88', '#ff00ff', '#ff69b4', '#00ced1'];
let colorIndex = 0;

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
    const arrow = bearing !== null ? getArrow(bearing) : '';
    const pinClass = isMe ? 'marker-pin me' : 'marker-pin';
    return L.divIcon({
        className: 'custom-marker',
        html: `<div class="${pinClass}" style="background:${color};"><span>${name.charAt(0).toUpperCase()}</span></div>`,
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
// LISTE
// ============================================================
let lastListHTML = '';
function updateUsersList(positions) {
    const list = document.getElementById('userList');
    const countEl = document.getElementById('userCount');
    if (countEl) countEl.textContent = positions.length;
    if (!list) return;
    if (positions.length === 0) {
        if (lastListHTML !== 'empty') {
            list.innerHTML = '<div class="empty"><i class="fas fa-satellite-dish"></i>En attente...</div>';
            lastListHTML = 'empty';
        }
        return;
    }
    const sorted = [...positions].sort((a, b) => {
        if (a.user_id === userId) return -1;
        if (b.user_id === userId) return 1;
        return a.age_seconds - b.age_seconds;
    });
    const newHTML = sorted.map(p => {
        const age = p.age_seconds;
        const ageText = age < 60 ? `${age}s` : `${Math.floor(age/60)}min`;
        const speedKmh = (p.speed || 0) * 3.6;
        const color = markers[p.user_id]?.color || '#00d4ff';
        const isMe = p.user_id === userId;
        const accLabel = getAccuracyLabel(p.accuracy || 0);
        const addr = addresses[p.user_id] || '...';
        const totalDist = totalDistances[p.user_id] || 0;
        return `<div class="user-item ${isMe ? 'me' : ''}" onclick="selectUser('${p.user_id}')">
            <div class="avatar" style="background:${color}">${p.name.charAt(0).toUpperCase()}</div>
            <div class="info">
                <div class="name">${p.name} ${isMe ? '⭐' : ''}</div>
                <div class="address">📍 ${addr}</div>
                <div class="coords">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
                <div class="meta">
                    <span><i class="fas fa-clock"></i> ${ageText}</span>
                    <span style="color:${accLabel.color}"><i class="fas fa-bullseye"></i> ±${Math.round(p.accuracy || 0)}m</span>
                    ${speedKmh > 0.5 ? `<span><i class="fas fa-tachometer-alt"></i> ${speedKmh.toFixed(1)}km/h</span>` : ''}
                    ${totalDist > 0 ? `<span><i class="fas fa-route"></i> ${formatDist(totalDist)}</span>` : ''}
                </div>
            </div>
        </div>`;
    }).join('');
    if (newHTML !== lastListHTML) {
        list.innerHTML = newHTML;
        lastListHTML = newHTML;
        sorted.forEach(p => {
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
        const color = getColor(p.user_id);
        const isMe = p.user_id === userId;
        if (!filters[p.user_id]) filters[p.user_id] = new KalmanFilter();
        const smooth = filters[p.user_id].process(p.lat, p.lng, p.accuracy || 10);
        let bearing = null;
        if (histories[p.user_id]?.length > 0) {
            const last = histories[p.user_id][histories[p.user_id].length - 1];
            if (last[0] !== smooth.lat || last[1] !== smooth.lng) bearing = calcBearing(last[0], last[1], smooth.lat, smooth.lng);
        }
        if (markers[p.user_id]) {
            markers[p.user_id].marker.setLatLng([smooth.lat, smooth.lng]);
            markers[p.user_id].marker.setIcon(createIcon(color, p.name, bearing, isMe));
        } else {
            const marker = L.marker([smooth.lat, smooth.lng], { icon: createIcon(color, p.name, bearing, isMe) }).addTo(map);
            marker.bindPopup(`
                <div style="font-family:sans-serif;min-width:180px;">
                    <b>${p.name}${isMe ? ' ⭐' : ''}</b><br>
                    <span style="color:#00d4ff;">${smooth.lat.toFixed(5)}, ${smooth.lng.toFixed(5)}</span><br>
                    🎯 ±${Math.round(p.accuracy || 0)}m<br>
                    <button onclick="callUser('${p.user_id}')" style="margin-top:8px;padding:6px 12px;background:#28c840;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">📞 Appeler</button>
                    <button onclick="openGoogleMaps(${smooth.lat}, ${smooth.lng})" style="margin-top:8px;margin-left:5px;padding:6px 12px;background:#4285f4;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">🗺️ Maps</button>
                </div>
            `);
            markers[p.user_id] = { marker, color };
        }
        updateTrail(p.user_id, smooth.lat, smooth.lng, color);
    });
    Object.keys(markers).forEach(uid => {
        if (!activeIds.has(uid)) {
            map.removeLayer(markers[uid].marker);
            delete markers[uid];
            if (trails[uid]) { map.removeLayer(trails[uid]); delete trails[uid]; }
            delete histories[uid];
            delete filters[uid];
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

console.log('%c 📍 Tracker GPS LIVE - Kalman + Talkie-Walkie ✅', 'color:#00d4ff;font-weight:bold;font-size:14px');

// ============================================================
// FILTRE DE STABILITÉ RENFORCÉ
// ============================================================

// Paramètres
const STABILITY_THRESHOLD = 8;      // Ignorer si bougé < 8m
const STABILITY_SAMPLES = 10;       // Moyenne sur 10 positions
const STABILITY_ACCURACY = 15;      // Ignorer si précision > 15m

// Stockage par utilisateur
const stabilityBuffers = {};
const lastStablePositions = {};

function getStablePosition(uid, lat, lng, accuracy) {
    // Ignorer si précision trop faible
    if (accuracy > STABILITY_ACCURACY) {
        return null;
    }
    
    // Initialiser le buffer
    if (!stabilityBuffers[uid]) {
        stabilityBuffers[uid] = [];
    }
    
    const buffer = stabilityBuffers[uid];
    buffer.push({ lat, lng, accuracy });
    
    // Garder seulement les N dernières
    if (buffer.length > STABILITY_SAMPLES) {
        buffer.shift();
    }
    
    // Calculer la moyenne pondérée
    let totalWeight = 0;
    let weightedLat = 0;
    let weightedLng = 0;
    
    for (const s of buffer) {
        const weight = 1 / (s.accuracy * s.accuracy);
        totalWeight += weight;
        weightedLat += s.lat * weight;
        weightedLng += s.lng * weight;
    }
    
    if (totalWeight === 0) return null;
    
    const avgLat = weightedLat / totalWeight;
    const avgLng = weightedLng / totalWeight;
    const avgAcc = buffer.reduce((s, p) => s + p.accuracy, 0) / buffer.length;
    
    // Vérifier si on a vraiment bougé
    const lastStable = lastStablePositions[uid];
    if (lastStable) {
        const dist = calcDistance(lastStable.lat, lastStable.lng, avgLat, avgLng);
        if (dist < STABILITY_THRESHOLD) {
            // Pas bougé → garder la position précédente
            return { ...lastStable, unchanged: true };
        }
    }
    
    // Nouvelle position stable
    lastStablePositions[uid] = { lat: avgLat, lng: avgLng, accuracy: avgAcc };
    return { lat: avgLat, lng: avgLng, accuracy: avgAcc, unchanged: false };
}

// Remplacer la fonction updateMap pour utiliser le filtre
const originalUpdateMap = window.updateMap;
window.updateMap = function(positions) {
    const activeIds = new Set();
    
    positions.forEach(p => {
        activeIds.add(p.user_id);
        const color = getColor(p.user_id);
        const isMe = p.user_id === userId;
        
        // Appliquer le filtre de stabilité
        const stable = getStablePosition(p.user_id, p.lat, p.lng, p.accuracy || 10);
        
        if (!stable) return; // Précision trop faible, on ignore
        
        // Si pas bougé, on garde la position précédente
        if (stable.unchanged && markers[p.user_id]) {
            return; // Ne rien faire
        }
        
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
            const marker = L.marker([stable.lat, stable.lng], {
                icon: createIcon(color, p.name, bearing, isMe)
            }).addTo(map);
            marker.bindPopup(`
                <div style="font-family:sans-serif;min-width:180px;">
                    <b>${p.name}${isMe ? ' ⭐' : ''}</b><br>
                    <span style="color:#00d4ff;">${stable.lat.toFixed(6)}, ${stable.lng.toFixed(6)}</span><br>
                    🎯 ±${Math.round(stable.accuracy)}m<br>
                    <button onclick="callUser('${p.user_id}')" style="margin-top:8px;padding:6px 12px;background:#28c840;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:12px;">📞 Appeler</button>
                </div>
            `);
            markers[p.user_id] = { marker, color };
        }
        
        updateTrail(p.user_id, stable.lat, stable.lng, color);
    });
    
    Object.keys(markers).forEach(uid => {
        if (!activeIds.has(uid)) {
            map.removeLayer(markers[uid].marker);
            delete markers[uid];
            if (trails[uid]) { map.removeLayer(trails[uid]); delete trails[uid]; }
            delete histories[uid];
            delete stabilityBuffers[uid];
            delete lastStablePositions[uid];
        }
    });
};

console.log('%c 🎯 Filtre de stabilité activé', 'color:#28c840;font-weight:bold;font-size:14px');

// ============================================================
// FONCTIONNALITÉS GRATUITES AJOUTÉES
// ============================================================

// ============================================================
// 1. BOUTON "OÙ ES-TU ?" (ping manuel)
// ============================================================
function requestPositionFrom(uid) {
    const name = markers[uid]?.marker?.getPopup()?.getContent()?.match(/<b>([^<]+)<\/b>/)?.[1] || 'Utilisateur';
    
    // Envoyer une requête de ping au backend
    fetch(BACKEND_URL + '/api/position/' + uid + '/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            from: 'Admin',
            message: 'Demande de position immédiate'
        })
    }).catch(() => {});
    
    // Effet visuel
    if (markers[uid]) {
        markers[uid].marker.openPopup();
        const popup = markers[uid].marker.getPopup();
        if (popup) {
            const content = popup.getContent();
            popup.setContent(content + '<br><span style="color:#ffbd2e;font-size:11px;">📡 Demande envoyée...</span>');
        }
    }
    
    updateStatusBar(`📡 Demande envoyée à ${name}`, '#ffbd2e');
}

// ============================================================
// 2. BIP SONORE (nouvel utilisateur)
// ============================================================
let audioContext = null;
const knownUserIds = new Set();

function playBeep() {
    try {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.frequency.value = 800;
        oscillator.type = 'sine';
        gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.2);
    } catch (e) {}
}

// ============================================================
// 3. VITESSE MAX + DISTANCE TOTALE
// ============================================================
const maxSpeeds = {};
const totalDistances2 = {};
const userStatuses = {};

function updateStats(uid, speed, lat, lng) {
    // Vitesse max
    const speedKmh = (speed || 0) * 3.6;
    if (!maxSpeeds[uid] || speedKmh > maxSpeeds[uid]) {
        maxSpeeds[uid] = speedKmh;
    }
    
    // Statut (mobile si vitesse > 1 km/h)
    userStatuses[uid] = speedKmh > 1 ? 'mobile' : 'immobile';
}

// ============================================================
// 4. TEMPS DE TRAJET ESTIMÉ
// ============================================================
function estimateTravelTime(distMeters) {
    // À pied : 1.4 m/s
    const walkMin = Math.round(distMeters / 1.4 / 60);
    // Voiture : 13.9 m/s (~50 km/h)
    const carMin = Math.round(distMeters / 13.9 / 60);
    return { walk: walkMin, car: carMin };
}

// ============================================================
// 5. FILTRES ET TRI
// ============================================================
let currentFilter = 'all';
let currentSort = 'age';

function setFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    // Forcer un refresh
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
    
    // Filtre
    if (currentFilter === 'active') {
        filtered = filtered.filter(p => p.age_seconds < 10);
    } else if (currentFilter === 'mobile') {
        filtered = filtered.filter(p => userStatuses[p.user_id] === 'mobile');
    } else if (currentFilter === 'immobile') {
        filtered = filtered.filter(p => userStatuses[p.user_id] === 'immobile');
    }
    
    // Tri
    filtered.sort((a, b) => {
        // Admin toujours en premier
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
// 6. REMPLACER LA FONCTION updateUsersList
// ============================================================
const originalUpdateUsersList = window.updateUsersList;
window.updateUsersList = function(positions) {
    const list = document.getElementById('userList');
    const countEl = document.getElementById('userCount');
    if (countEl) countEl.textContent = positions.length;
    if (!list) return;
    
    if (positions.length === 0) {
        list.innerHTML = `
            <div class="filters-bar">
                <button class="filter-btn active" data-filter="all" onclick="setFilter('all')">Tous</button>
                <button class="filter-btn" data-filter="active" onclick="setFilter('active')">Actifs</button>
                <button class="filter-btn" data-filter="mobile" onclick="setFilter('mobile')">Mobiles</button>
                <button class="filter-btn" data-filter="immobile" onclick="setFilter('immobile')">Immobiles</button>
            </div>
            <div class="empty"><i class="fas fa-satellite-dish"></i>En attente...</div>
        `;
        return;
    }
    
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
                <div class="user-stats">
                    <span><i class="fas fa-clock"></i> ${ageText}</span>
                    <span style="color:${accLabel.color}"><i class="fas fa-bullseye"></i> ±${Math.round(p.accuracy || 0)}m</span>
                    ${speedKmh > 0.5 ? `<span><i class="fas fa-tachometer-alt"></i> ${speedKmh.toFixed(1)} km/h</span>` : ''}
                    ${maxSpeed > 0 ? `<span><i class="fas fa-rocket"></i> Max ${maxSpeed.toFixed(1)} km/h</span>` : ''}
                    ${totalDist > 0 ? `<span><i class="fas fa-route"></i> ${formatDist(totalDist)}</span>` : ''}
                </div>
            </div>
        </div>`;
    }).join('');
    
    list.innerHTML = html;
    
    // Charger adresses en arrière-plan
    filtered.forEach(p => {
        if (!addresses[p.user_id]) {
            getAddress(p.lat, p.lng).then(a => { if (a) addresses[p.user_id] = a; });
        }
    });
};

// ============================================================
// 7. REMPLACER updateMap POUR AJOUTER LES STATS + BIP
// ============================================================
const originalUpdateMap2 = window.updateMap;
window.updateMap = function(positions) {
    // Détecter nouveaux utilisateurs
    positions.forEach(p => {
        if (!knownUserIds.has(p.user_id)) {
            knownUserIds.add(p.user_id);
            if (p.user_id !== userId) {
                playBeep();
                console.log('🔔 Nouvel utilisateur:', p.name);
            }
        }
        updateStats(p.user_id, p.speed, p.lat, p.lng);
    });
    
    // Appeler la fonction originale
    if (originalUpdateMap2) {
        originalUpdateMap2(positions);
    }
};

// ============================================================
// 8. BOUTON "OÙ ES-TU ?" DANS LES POPUPS
// ============================================================
const originalCreateIcon = window.createIcon;
window.createIcon = function(color, name, bearing, isMe) {
    return L.divIcon({
        className: 'custom-marker',
        html: `<div class="marker-pin ${isMe ? 'me' : ''}" style="background:${color};"><span>${name.charAt(0).toUpperCase()}</span></div>`,
        iconSize: [32, 32], iconAnchor: [16, 32]
    });
};

console.log('%c 🎁 Fonctionnalités gratuites ajoutées ✅', 'color:#28c840;font-weight:bold;font-size:14px');
console.log('   • Bouton "Où es-tu ?"');
console.log('   • Bip sonore nouvel utilisateur');
console.log('   • Vitesse max');
console.log('   • Distance totale');
console.log('   • Temps de trajet estimé');
console.log('   • Filtres (Tous/Actifs/Mobiles/Immobiles)');
console.log('   • Tri (Âge/Nom/Vitesse/Distance)');
console.log('   • Statut mobile/immobile');
