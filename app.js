// ============================================================
// TRACKER GPS COMPLET - OSRM + Météo + PWA + Fluidité
// ============================================================

const BACKEND_URL = 'https://localisation-backend-sm3t.onrender.com';
const REFRESH_INTERVAL = 2000;
const SEND_INTERVAL = 2000;
const TRAIL_MAX_POINTS = 100;
const MAX_ZOOM = 21;
const MAX_ACCURACY = 50;
const TRAIL_MIN_MOVE = 10;
const MIN_MOVE_UPDATE = 3;
const GEOCODE_CACHE = {};
const WEATHER_CACHE = {};
const WEATHER_TTL = 10 * 60 * 1000;

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
// PWA
// ============================================================
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ============================================================
// THEME
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
// ADRESSE (Nominatim)
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
// MÉTÉO (Open-Meteo)
// ============================================================
async function getWeather(lat, lng) {
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    const cached = WEATHER_CACHE[key];
    if (cached && (Date.now() - cached.time < WEATHER_TTL)) return cached.data;
    try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 5000);
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code`, { signal: c.signal });
        clearTimeout(t);
        const data = await r.json();
        const temp = Math.round(data.current.temperature_2m);
        const code = data.current.weather_code;
        const emoji = getWeatherEmoji(code);
        const result = `${emoji} ${temp}°C`;
        WEATHER_CACHE[key] = { data: result, time: Date.now() };
        return result;
    } catch (e) { return ''; }
}
function getWeatherEmoji(code) {
    if (code === 0) return '☀️';
    if (code <= 3) return '⛅';
    if (code <= 48) return '🌫️';
    if (code <= 67) return '🌧️';
    if (code <= 77) return '❄️';
    if (code <= 82) return '🌧️';
    if (code <= 86) return '❄️';
    return '⛈️';
}

// ============================================================
// ENVOI ADMIN
// ============================================================
let adminInterval = null;
let adminLastSent = null;
let isSendingAdmin = false;

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
const weather = {};
const colors = ['#00d4ff', '#7b2ffc', '#ff5f57', '#ffbd2e', '#28c840', '#ff8c00', '#00ff88', '#ff00ff', '#ff69b4', '#00ced1'];
let colorIndex = 0;
let routingControl = null;

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
        html: `<div class="marker-direction">${arrow}</div>
               <div class="${pinClass}" style="background:${color};">
                   ${name.charAt(0).toUpperCase()}
               </div>`,
        iconSize: [36, 36], iconAnchor: [18, 18]
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
        trails[uid] = L.polyline(h, { color, weight: 4, opacity: 0.7, smoothFactor: 2 }).addTo(map);
    }
}

// ============================================================
// ITINÉRAIRE OSRM
// ============================================================
function showRoute(targetUserId) {
    const me = markers[userId];
    const target = markers[targetUserId];
    if (!me || !target) return;
    if (routingControl) map.removeControl(routingControl);
    const mePos = me.marker.getLatLng();
    const targetPos = target.marker.getLatLng();
    routingControl = L.Routing.control({
        waypoints: [L.latLng(mePos.lat, mePos.lng), L.latLng(targetPos.lat, targetPos.lng)],
        routeWhileDragging: false, addWaypoints: false, fitSelectedRoutes: true, showAlternatives: false,
        lineOptions: { styles: [{ color: '#ffd700', weight: 4, opacity: 0.8 }] },
        createMarker: () => null, language: 'fr', show: false
    }).addTo(map);
    routingControl.on('routesfound', e => {
        const r = e.routes[0];
        const dist = (r.summary.totalDistance / 1000).toFixed(2);
        const time = Math.round(r.summary.totalTime / 60);
        updateStatusBar(`🚗 ${dist} km — ${time} min`, '#ffd700');
    });
}

function clearRoute() {
    if (routingControl) { map.removeControl(routingControl); routingControl = null; }
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
        const addr = addresses[p.user_id] || '...';
        const wx = weather[p.user_id] || '';
        const totalDist = totalDistances[p.user_id] || 0;
        return `<div class="user-item ${isMe ? 'me' : ''}" onclick="selectUser('${p.user_id}')">
            <div class="avatar" style="background:${color}">${p.name.charAt(0).toUpperCase()}</div>
            <div class="info">
                <div class="name">${p.name} ${isMe ? '⭐' : ''} ${wx}</div>
                <div class="address">📍 ${addr}</div>
                <div class="coords">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
                <div class="meta">
                    <span><i class="fas fa-clock"></i> ${ageText}</span>
                    <span style="color:${accLabel.color}"><i class="fas fa-bullseye"></i> ±${Math.round(p.accuracy || 0)}m</span>
                    ${speedKmh > 0.5 ? `<span><i class="fas fa-tachometer-alt"></i> ${speedKmh.toFixed(1)}</span>` : ''}
                    ${totalDist > 0 ? `<span><i class="fas fa-route"></i> ${formatDist(totalDist)}</span>` : ''}
                </div>
            </div>
        </div>`;
    }).join('');
    
    // Charger adresses + météo en arrière-plan
    sorted.forEach(p => {
        if (!addresses[p.user_id]) {
            getAddress(p.lat, p.lng).then(a => { if (a) { addresses[p.user_id] = a; updateUsersList(positions); } });
        }
        if (!weather[p.user_id]) {
            getWeather(p.lat, p.lng).then(w => { if (w) { weather[p.user_id] = w; updateUsersList(positions); } });
        }
    });
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
            if (last[0] !== p.lat || last[1] !== p.lng) bearing = calcBearing(last[0], last[1], p.lat, p.lng);
        }
        if (markers[p.user_id]) {
            markers[p.user_id].marker.setLatLng([p.lat, p.lng]);
            markers[p.user_id].marker.setIcon(createIcon(color, p.name, bearing, isMe));
        } else {
            const marker = L.marker([p.lat, p.lng], { icon: createIcon(color, p.name, bearing, isMe) }).addTo(map);
            marker.bindPopup(`<b>${p.name}${isMe ? ' ⭐' : ''}</b><br>${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}<br><button onclick="openGoogleMaps(${p.lat}, ${p.lng})" style="margin-top:5px;padding:4px 10px;background:#4285f4;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:11px;">🗺️ Google Maps</button>`);
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

// ============================================================
// ACTIONS
// ============================================================
function focusUser(uid) {
    if (markers[uid]) {
        map.setView(markers[uid].marker.getLatLng(), 17, { animate: true });
        markers[uid].marker.openPopup();
    }
}
function selectUser(uid) {
    focusUser(uid);
    if (uid !== userId) showRoute(uid);
}
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
startAdminSharing();
fetchPositions();
setInterval(fetchPositions, REFRESH_INTERVAL);

console.log('%c 📍 Tracker COMPLET - OSRM + Météo + PWA ✅', 'color:#00d4ff;font-weight:bold;font-size:14px');
