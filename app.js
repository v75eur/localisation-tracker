// ============================================================
// TRACKER GPS - VERSION PROPRE ET STABLE
// ============================================================

const BACKEND_URL = 'https://localisation-backend-sm3t.onrender.com';
const REFRESH_INTERVAL = 2000;
const SEND_INTERVAL = 2000;
const TRAIL_MAX_POINTS = 100;
const MAX_ZOOM = 21;

// FILTRES
const MAX_ACCURACY = 50;         // Ignorer si précision > 50m
const TRAIL_MIN_MOVE = 10;       // Ne tracer que si bougé > 10m
const MIN_MOVE_UPDATE = 3;       // Mettre à jour seulement si bougé > 3m

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

// ============================================================
// ENVOI ADMIN
// ============================================================
let adminInterval = null;
let adminLastSent = null;

function getPosition() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) { reject(new Error('Non supportée')); return; }
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve(pos),
            (err) => reject(err),
            { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
        );
    });
}

async function sendAdminPosition() {
    try {
        const pos = await getPosition();
        const acc = pos.coords.accuracy;
        
        // Filtre : ignorer si précision trop faible
        if (acc > MAX_ACCURACY) {
            updateStatusBar(`❌ Précision faible (${Math.round(acc)}m)`, '#ff5f57');
            return;
        }
        
        // Filtre : n'envoyer que si bougé de plus de 3m
        if (adminLastSent) {
            const dist = calcDistance(adminLastSent.lat, adminLastSent.lng, pos.coords.latitude, pos.coords.longitude);
            if (dist < MIN_MOVE_UPDATE) {
                const label = getAccuracyLabel(acc);
                updateStatusBar(`📍 Stable ±${Math.round(acc)}m (${label.text})`, label.color);
                return;
            }
        }
        
        adminLastSent = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        
        const label = getAccuracyLabel(acc);
        updateStatusBar(`📍 ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)} — ${label.text} ±${Math.round(acc)}m`, label.color);
        
        await fetch(BACKEND_URL + '/api/position', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: userId, name: 'Admin',
                lat: pos.coords.latitude, lng: pos.coords.longitude,
                speed: pos.coords.speed || 0,
                accuracy: acc,
                heading: pos.coords.heading || 0,
                altitude: pos.coords.altitude || 0
            })
        });
    } catch (e) {
        updateStatusBar('❌ ' + e.message, '#ff5f57');
    }
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
const knownUsers = new Set();
const colors = ['#00d4ff', '#7b2ffc', '#ff5f57', '#ffbd2e', '#28c840',
                '#ff8c00', '#00ff88', '#ff00ff', '#ff69b4', '#00ced1'];
let colorIndex = 0;

function getColor(uid) {
    if (!markers[uid]) {
        colorIndex = (colorIndex + 1) % colors.length;
        return colors[colorIndex];
    }
    return markers[uid].color;
}

// ============================================================
// ICÔNE PROPRE (style Google Maps)
// ============================================================
function createIcon(color, name, bearing, isMe) {
    const arrow = bearing !== null ? getArrow(bearing) : '';
    const pinClass = isMe ? 'marker-pin me' : 'marker-pin';
    return L.divIcon({
        className: 'custom-marker',
        html: `<div class="marker-direction">${arrow}</div>
               <div class="${pinClass}" style="background:${color};">
                   ${name.charAt(0).toUpperCase()}
               </div>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18]
    });
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
// TRAJECTOIRE FILTRÉE
// ============================================================
function updateTrail(uid, lat, lng, color) {
    if (!histories[uid]) histories[uid] = [];
    const h = histories[uid];
    
    // Filtre STRICT : n'ajouter que si bougé de plus de 10m
    if (h.length > 0) {
        const last = h[h.length - 1];
        const dist = calcDistance(last[0], last[1], lat, lng);
        if (dist < TRAIL_MIN_MOVE) return;
    }
    
    h.push([lat, lng]);
    if (h.length > TRAIL_MAX_POINTS) h.shift();
    
    if (trails[uid]) map.removeLayer(trails[uid]);
    if (h.length > 1) {
        trails[uid] = L.polyline(h, {
            color, weight: 4, opacity: 0.7, smoothFactor: 2
        }).addTo(map);
    }
}

// ============================================================
// LISTE
// ============================================================
function updateUsersList(positions) {
    const list = document.getElementById('userList');
    const countEl = document.getElementById('userCount');
    if (countEl) countEl.textContent = positions.length;
    if (!list) return;
    
    if (positions.length === 0) {
        list.innerHTML = '<div class="empty"><i class="fas fa-satellite-dish"></i>En attente...</div>';
        return;
    }
    
    // Trier : Admin (moi) en premier, puis par âge
    const sorted = [...positions].sort((a, b) => {
        if (a.user_id === userId) return -1;
        if (b.user_id === userId) return 1;
        return a.age_seconds - b.age_seconds;
    });
    
    list.innerHTML = sorted.map(p => {
        const age = p.age_seconds;
        const ageText = age < 60 ? `${age}s` : `${Math.floor(age/60)}min`;
        const speedKmh = (p.speed || 0) * 3.6;
        const color = markers[p.user_id]?.color || '#00d4ff';
        const isMe = p.user_id === userId;
        const accLabel = getAccuracyLabel(p.accuracy || 0);
        
        return `<div class="user-item ${isMe ? 'me' : ''}" onclick="focusUser('${p.user_id}')">
            <div class="avatar" style="background:${color}">
                ${p.name.charAt(0).toUpperCase()}
            </div>
            <div class="info">
                <div class="name">${p.name} ${isMe ? '⭐' : ''}</div>
                <div class="coords">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
                <div class="meta">
                    <span><i class="fas fa-clock"></i> ${ageText}</span>
                    <span style="color:${accLabel.color}"><i class="fas fa-bullseye"></i> ±${Math.round(p.accuracy || 0)}m</span>
                    ${speedKmh > 0.5 ? `<span><i class="fas fa-tachometer-alt"></i> ${speedKmh.toFixed(1)} km/h</span>` : ''}
                </div>
            </div>
        </div>`;
    }).join('');
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
        
        let bearing = null;
        if (histories[p.user_id]?.length > 0) {
            const last = histories[p.user_id][histories[p.user_id].length - 1];
            if (last[0] !== p.lat || last[1] !== p.lng) {
                bearing = calcBearing(last[0], last[1], p.lat, p.lng);
            }
        }
        
        if (markers[p.user_id]) {
            markers[p.user_id].marker.setLatLng([p.lat, p.lng]);
            markers[p.user_id].marker.setIcon(createIcon(color, p.name, bearing, isMe));
        } else {
            const marker = L.marker([p.lat, p.lng], {
                icon: createIcon(color, p.name, bearing, isMe)
            }).addTo(map);
            marker.bindPopup(`<b>${p.name}${isMe ? ' ⭐' : ''}</b><br>${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`);
            markers[p.user_id] = { marker, color };
        }
        
        updateTrail(p.user_id, p.lat, p.lng, color);
    });
    
    Object.keys(markers).forEach(uid => {
        if (!activeIds.has(uid)) {
            map.removeLayer(markers[uid].marker);
            delete markers[uid];
            if (trails[uid]) { map.removeLayer(trails[uid]); delete trails[uid]; }
            delete histories[uid];
        }
    });
}

function focusUser(uid) {
    if (markers[uid]) {
        map.setView(markers[uid].marker.getLatLng(), 17, { animate: true });
        markers[uid].marker.openPopup();
    }
}

// ============================================================
// BOUTONS
// ============================================================
function resetView() { map.setView([6.13, 1.22], 2, { animate: true }); }
function followMe() {
    if (markers[userId]) {
        map.setView(markers[userId].marker.getLatLng(), 18, { animate: true });
        markers[userId].marker.openPopup();
    } else {
        alert('Position en cours de détection...');
    }
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
        const t = setTimeout(() => c.abort(), 30000);
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
startAdminSharing();
fetchPositions();
setInterval(fetchPositions, REFRESH_INTERVAL);

console.log('%c 📍 Tracker GPS - Propre et stable ✅', 'color:#00d4ff;font-weight:bold;font-size:14px');
