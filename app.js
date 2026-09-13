// ============================================================
// TRACKER GPS - Version ULTRA PRÉCISION + TOUS BOUTONS
// ============================================================

const BACKEND_URL = 'https://localisation-backend-sm3t.onrender.com';
const REFRESH_INTERVAL = 2000;
const SEND_INTERVAL = 2000;
const TRAIL_MAX_POINTS = 200;
const MAX_ZOOM = 21;
const MAX_ACCURACY = 100;
const TRAIL_MIN_MOVE = 3;
const MIN_MOVE_UPDATE = 1;
const PRECISION_SAMPLES = 10;
const GEOCODE_CACHE = {};
const PLACES_KEY = 'tracker_places';

fetch(BACKEND_URL + '/api/ping').catch(() => {});

// CARTE
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
        map.removeLayer(planLayer); satelliteLayer.addTo(map);
        currentMode = 'satellite';
        document.getElementById('satBtn').innerHTML = '<i class="fas fa-map"></i>';
    } else {
        map.removeLayer(satelliteLayer); planLayer.addTo(map);
        currentMode = 'plan';
        document.getElementById('satBtn').innerHTML = '<i class="fas fa-satellite"></i>';
    }
}
L.control.zoom({ position: 'bottomright' }).addTo(map);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// KALMAN
class KalmanFilter {
    constructor() { this.reset(); }
    reset() { this.lat = null; this.lng = null; this.variance = -1; }
    process(lat, lng, accuracy) {
        if (this.lat === null) { this.lat = lat; this.lng = lng; this.variance = accuracy * accuracy; return { lat, lng }; }
        const variance = this.variance + 0.01;
        const gain = variance / (variance + accuracy * accuracy);
        this.lat = this.lat + gain * (lat - this.lat);
        this.lng = this.lng + gain * (lng - this.lng);
        this.variance = (1 - gain) * variance;
        return { lat: this.lat, lng: this.lng };
    }
}
const kalmanFilters = {};

// FILTRE PRÉCISION
const precisionBuffers = {};
function smoothPosition(uid, lat, lng, accuracy) {
    if (!precisionBuffers[uid]) precisionBuffers[uid] = [];
    const buffer = precisionBuffers[uid];
    buffer.push({ lat, lng, accuracy });
    if (buffer.length > PRECISION_SAMPLES) buffer.shift();
    let totalWeight = 0, weightedLat = 0, weightedLng = 0, totalAcc = 0;
    for (const s of buffer) {
        const weight = 1 / (s.accuracy * s.accuracy);
        totalWeight += weight;
        weightedLat += s.lat * weight;
        weightedLng += s.lng * weight;
        totalAcc += s.accuracy;
    }
    if (totalWeight === 0) return null;
    return {
        lat: weightedLat / totalWeight,
        lng: weightedLng / totalWeight,
        accuracy: totalAcc / buffer.length,
        samples: buffer.length
    };
}

// THÈME
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

// ID ADMIN
let userId = localStorage.getItem('tracker_user_id');
if (!userId) {
    userId = 'admin_' + Math.random().toString(36).substring(2, 10);
    localStorage.setItem('tracker_user_id', userId);
}

// WAKE LOCK
let wakeLock = null;
async function requestWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
window.addEventListener('load', requestWakeLock);
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && wakeLock === null) await requestWakeLock();
});

// UTILITAIRES
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

// ADRESSE
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

// BIP
let audioContext = null;
function playBeep() {
    try {
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.connect(gain); gain.connect(audioContext.destination);
        osc.frequency.value = 800; osc.type = 'sine';
        gain.gain.setValueAtTime(0.1, audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
        osc.start(); osc.stop(audioContext.currentTime + 0.2);
    } catch (e) {}
}

// ENVOI ADMIN
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
        const smoothed = smoothPosition(userId, pos.coords.latitude, pos.coords.longitude, acc);
        if (!smoothed) return;
        const filtered = adminFilter.process(smoothed.lat, smoothed.lng, smoothed.accuracy);
        if (adminLastSent) {
            const dist = calcDistance(adminLastSent.lat, adminLastSent.lng, filtered.lat, filtered.lng);
            if (dist < MIN_MOVE_UPDATE) {
                const label = getAccuracyLabel(smoothed.accuracy);
                updateStatusBar(`📍 Stable ±${smoothed.accuracy.toFixed(1)}m (${smoothed.samples} éch.)`, label.color);
                return;
            }
        }
        adminLastSent = filtered;
        const label = getAccuracyLabel(smoothed.accuracy);
        updateStatusBar(`📍 ±${smoothed.accuracy.toFixed(1)}m — ${label.text} (${smoothed.samples} éch.)`, label.color);
        await fetch(BACKEND_URL + '/api/position', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: userId, name: 'Admin', whatsapp: '',
                lat: filtered.lat, lng: filtered.lng,
                speed: pos.coords.speed || 0, accuracy: smoothed.accuracy,
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

// BOUTON ACTUALISER
async function forceRefresh() {
    const btn = document.getElementById('refreshBtn');
    if (btn) btn.style.animation = 'spin 1s linear infinite';
    updateStatusBar('🔄 Actualisation...', '#00d4ff');
    await sendAdminPosition();
    await fetchPositions();
    setTimeout(() => {
        if (markers[userId]) map.setView(markers[userId].marker.getLatLng(), 17, { animate: true });
    }, 500);
    setTimeout(() => {
        if (btn) btn.style.animation = '';
        updateStatusBar('✅ Carte actualisée', '#28c840');
    }, 1500);
}

// STOCKAGE
const markers = {};
const trails = {};
const histories = {};
const totalDistances = {};
const addresses = {};
const knownUsers = new Set();
const maxSpeeds = {};
const userStatuses = {};
const bearings = {};
const whatsappNumbers = {};
const colors = ['#00d4ff', '#7b2ffc', '#ff5f57', '#ffbd2e', '#28c840', '#ff8c00', '#00ff88', '#ff00ff', '#ff69b4', '#00ced1'];
let colorIndex = 0;
let currentFilter = 'all';
let currentSort = 'age';
let routingControl = null;
let placeRouteControl = null;
let targetRouteControl = null;

function getColor(uid) {
    if (!markers[uid]) { colorIndex = (colorIndex + 1) % colors.length; return colors[colorIndex]; }
    return markers[uid].color;
}

// ICÔNE
function createIcon(color, name, bearing, isMe) {
    const arrow = bearing !== null ? getArrow(bearing) : '';
    return L.divIcon({
        className: 'custom-marker',
        html: `<div class="marker-direction">${arrow}</div><div class="marker-pin ${isMe ? 'me' : ''}" style="background:${color};"><span>${name.charAt(0).toUpperCase()}</span></div>`,
        iconSize: [32, 42], iconAnchor: [16, 32]
    });
}

// TRAJECTOIRE
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

// WHATSAPP
function callWhatsAppDirect(uid) {
    const phone = whatsappNumbers[uid];
    const marker = markers[uid];
    if (!phone) { alert('Numéro WhatsApp non disponible'); return; }
    const name = marker?.name || 'Utilisateur';
    const message = encodeURIComponent(`Bonjour ${name}, je te contacte depuis le tracker GPS.`);
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    window.open(`https://wa.me/${cleanPhone}?text=${message}`, '_blank');
    updateStatusBar(`📞 WhatsApp ouvert vers ${name}`, '#25d366');
}

// ITINÉRAIRE UTILISATEUR
function showRouteTo(targetUserId) {
    const me = markers[userId];
    const target = markers[targetUserId];
    if (!me || !target) { updateStatusBar('❌ Position manquante', '#ff5f57'); return; }
    if (routingControl) { map.removeControl(routingControl); routingControl = null; }
    const mePos = me.marker.getLatLng();
    const targetPos = target.marker.getLatLng();
    const targetName = target.name || 'Utilisateur';
    routingControl = L.Routing.control({
        waypoints: [L.latLng(mePos.lat, mePos.lng), L.latLng(targetPos.lat, targetPos.lng)],
        routeWhileDragging: false, addWaypoints: false, fitSelectedRoutes: true, showAlternatives: false,
        lineOptions: { styles: [{ color: '#ffd700', weight: 4, opacity: 0.8 }] },
        createMarker: function() { return null; }, language: 'fr', show: false
    }).addTo(map);
    routingControl.on('routesfound', function(e) {
        const route = e.routes[0];
        const dist = (route.summary.totalDistance / 1000).toFixed(2);
        const time = Math.round(route.summary.totalTime / 60);
        updateStatusBar(`🛣️ Vers ${targetName}: ${dist} km — ${time} min`, '#ffd700');
    });
    updateStatusBar(`🛣️ Calcul vers ${targetName}...`, '#ffbd2e');
}

// CIBLAGE
let targetMode = false;
let targetMarker = null;

function toggleTargetMode() {
    targetMode = !targetMode;
    const btn = document.getElementById('targetBtn');
    if (btn) {
        btn.style.background = targetMode ? 'rgba(0,212,255,.3)' : '';
        btn.style.borderColor = targetMode ? '#00d4ff' : '';
    }
    updateStatusBar(targetMode ? '🎯 Cliquez sur la carte pour cibler un point' : '📍 Mode normal', targetMode ? '#00d4ff' : '#ffbd2e');
    document.body.style.cursor = targetMode ? 'crosshair' : '';
}

function createTargetPoint(lat, lng) {
    if (targetMarker) map.removeLayer(targetMarker);
    if (targetRouteControl) { map.removeControl(targetRouteControl); targetRouteControl = null; }
    const icon = L.divIcon({
        className: 'target-marker-wrapper',
        html: `<div class="target-marker"><span>🎯</span></div>`,
        iconSize: [28, 28], iconAnchor: [14, 14]
    });
    targetMarker = L.marker([lat, lng], { icon }).addTo(map);
    targetMarker.bindPopup(`
        <div class="target-popup">
            <b>🎯 Point ciblé</b><br>
            <span style="color:#00d4ff;font-size:11px;">${lat.toFixed(5)}, ${lng.toFixed(5)}</span><br>
            <button onclick="routeToTarget(${lat}, ${lng})" style="margin-top:8px;padding:6px 12px;background:#00d4ff;color:#000;border:0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">🛣️ Itinéraire</button>
            <button onclick="clearTarget()" style="margin-top:8px;margin-left:5px;padding:6px 12px;background:#ff5f57;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">🗑️ Effacer</button>
        </div>
    `);
    targetMarker.openPopup();
    updateStatusBar(`🎯 Point ciblé: ${lat.toFixed(5)}, ${lng.toFixed(5)}`, '#00d4ff');
}

function routeToTarget(lat, lng) {
    const me = markers[userId];
    if (!me) { updateStatusBar('❌ Ta position n\'est pas détectée', '#ff5f57'); return; }
    if (targetRouteControl) map.removeControl(targetRouteControl);
    const mePos = me.marker.getLatLng();
    targetRouteControl = L.Routing.control({
        waypoints: [L.latLng(mePos.lat, mePos.lng), L.latLng(lat, lng)],
        routeWhileDragging: false, addWaypoints: false, fitSelectedRoutes: true, showAlternatives: false,
        lineOptions: { styles: [{ color: '#00d4ff', weight: 4, opacity: 0.9 }] },
        createMarker: function() { return null; }, language: 'fr', show: false
    }).addTo(map);
    targetRouteControl.on('routesfound', function(e) {
        const route = e.routes[0];
        const dist = (route.summary.totalDistance / 1000).toFixed(2);
        const time = Math.round(route.summary.totalTime / 60);
        updateStatusBar(`🛣️ Itinéraire: ${dist} km — ${time} min`, '#00d4ff');
    });
    map.closePopup();
}

function clearTarget() {
    if (targetMarker) { map.removeLayer(targetMarker); targetMarker = null; }
    if (targetRouteControl) { map.removeControl(targetRouteControl); targetRouteControl = null; }
    updateStatusBar('🗑️ Point ciblé effacé', '#ffbd2e');
}

// LIEUX
let places = JSON.parse(localStorage.getItem(PLACES_KEY) || '[]');
let placeMarkers = {};
let placeMode = false;

function loadPlaces() {
    places.forEach(place => { addPlaceToMap(place.id, place.name, place.lat, place.lng, false); });
}

function addPlaceToMap(id, name, lat, lng, save = true) {
    if (placeMarkers[id]) map.removeLayer(placeMarkers[id]);
    const icon = L.divIcon({
        className: 'place-marker-wrapper',
        html: `<div class="place-marker"><span>📌</span></div>`,
        iconSize: [24, 24], iconAnchor: [12, 24]
    });
    const marker = L.marker([lat, lng], { icon }).addTo(map);
    marker.bindPopup(`
        <div class="place-popup">
            <input type="text" id="place-name-${id}" value="${name}" placeholder="Nom du lieu">
            <button class="btn-save" onclick="savePlace('${id}')">💾 Sauver</button>
            <button class="btn-route" onclick="routeToPlace('${id}')">🛣️ Itinéraire</button>
            <button class="btn-delete" onclick="deletePlace('${id}')">🗑️</button>
        </div>
    `);
    placeMarkers[id] = marker;
    if (save) {
        const existing = places.findIndex(p => p.id === id);
        if (existing === -1) places.push({ id, name, lat, lng });
        else places[existing] = { id, name, lat, lng };
        localStorage.setItem(PLACES_KEY, JSON.stringify(places));
    }
}

function savePlace(id) {
    const input = document.getElementById(`place-name-${id}`);
    if (!input) return;
    const newName = input.value.trim() || 'Lieu';
    const place = places.find(p => p.id === id);
    if (place) {
        place.name = newName;
        localStorage.setItem(PLACES_KEY, JSON.stringify(places));
        updateStatusBar(`💾 Lieu sauvegardé: ${newName}`, '#28c840');
        map.closePopup();
    }
}

function deletePlace(id) {
    if (!confirm('Supprimer ce lieu ?')) return;
    if (placeMarkers[id]) { map.removeLayer(placeMarkers[id]); delete placeMarkers[id]; }
    places = places.filter(p => p.id !== id);
    localStorage.setItem(PLACES_KEY, JSON.stringify(places));
    updateStatusBar('🗑️ Lieu supprimé', '#ff5f57');
}

function routeToPlace(id) {
    const place = places.find(p => p.id === id);
    if (!place) return;
    const me = markers[userId];
    if (!me) { updateStatusBar('❌ Ta position n\'est pas détectée', '#ff5f57'); return; }
    if (placeRouteControl) map.removeControl(placeRouteControl);
    const mePos = me.marker.getLatLng();
    placeRouteControl = L.Routing.control({
        waypoints: [L.latLng(mePos.lat, mePos.lng), L.latLng(place.lat, place.lng)],
        routeWhileDragging: false, addWaypoints: false, fitSelectedRoutes: true, showAlternatives: false,
        lineOptions: { styles: [{ color: '#ff5f57', weight: 4, opacity: 0.8 }] },
        createMarker: function() { return null; }, language: 'fr', show: false
    }).addTo(map);
    placeRouteControl.on('routesfound', function(e) {
        const route = e.routes[0];
        const dist = (route.summary.totalDistance / 1000).toFixed(2);
        const time = Math.round(route.summary.totalTime / 60);
        updateStatusBar(`🛣️ Vers ${place.name}: ${dist} km — ${time} min`, '#ff5f57');
    });
    map.closePopup();
}

function togglePlaceMode() {
    placeMode = !placeMode;
    const btn = document.getElementById('placeBtn');
    if (btn) {
        btn.style.background = placeMode ? 'rgba(255,95,87,.3)' : '';
        btn.style.borderColor = placeMode ? '#ff5f57' : '';
    }
    updateStatusBar(placeMode ? '📌 Cliquez sur la carte pour marquer un lieu' : '📍 Mode normal', placeMode ? '#ff5f57' : '#ffbd2e');
    document.body.style.cursor = placeMode ? 'crosshair' : '';
}

function clearRoute() {
    if (routingControl) { map.removeControl(routingControl); routingControl = null; }
    if (placeRouteControl) { map.removeControl(placeRouteControl); placeRouteControl = null; }
    if (targetRouteControl) { map.removeControl(targetRouteControl); targetRouteControl = null; }
    updateStatusBar('🗑️ Itinéraire effacé', '#ffbd2e');
}

map.on('click', function(e) {
    if (targetMode) {
        createTargetPoint(e.latlng.lat, e.latlng.lng);
        targetMode = false;
        const btn = document.getElementById('targetBtn');
        if (btn) { btn.style.background = ''; btn.style.borderColor = ''; }
        document.body.style.cursor = '';
        return;
    }
    if (placeMode) {
        const id = 'place_' + Date.now();
        const name = 'Lieu ' + (places.length + 1);
        addPlaceToMap(id, name, e.latlng.lat, e.latlng.lng, true);
        setTimeout(() => { if (placeMarkers[id]) placeMarkers[id].openPopup(); }, 100);
        placeMode = false;
        const btn = document.getElementById('placeBtn');
        if (btn) { btn.style.background = ''; btn.style.borderColor = ''; }
        document.body.style.cursor = '';
        updateStatusBar('✅ Lieu créé ! Renommez-le', '#28c840');
    }
});

// FILTRES
function setFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === filter));
    fetchPositions();
}
function setSort(sort) {
    currentSort = sort;
    document.querySelectorAll('.sort-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.sort === sort));
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

// LISTE
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
            const status = userStatuses[p.user_id] || 'immobile';
            const arrow = bearings[p.user_id] ? getArrow(bearings[p.user_id]) : '';
            const wa = p.whatsapp || '';
            return `<div class="user-item ${isMe ? 'me' : ''}" onclick="selectUser('${p.user_id}')">
                <div class="avatar" style="background:${color}">${p.name.charAt(0).toUpperCase()}</div>
                <div class="info">
                    <div class="name">${arrow} ${p.name} ${isMe ? '⭐' : ''}<span class="status-badge status-${status}">${status === 'mobile' ? '🚶' : '⏸️'}</span></div>
                    <div class="address">📍 ${addr}</div>
                    ${wa ? `<div class="whatsapp-line">📱 ${wa}</div>` : ''}
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
    }
    list.innerHTML = html;
    filtered.forEach(p => {
        if (!addresses[p.user_id]) getAddress(p.lat, p.lng).then(a => { if (a) addresses[p.user_id] = a; });
    });
}

// CARTE
function updateMap(positions) {
    const activeIds = new Set();
    positions.forEach(p => {
        activeIds.add(p.user_id);
        if (p.whatsapp) whatsappNumbers[p.user_id] = p.whatsapp;
        if (!knownUsers.has(p.user_id)) {
            knownUsers.add(p.user_id);
            if (p.user_id !== userId) { playBeep(); updateStatusBar(`🔔 Nouvel utilisateur: ${p.name}`, '#28c840'); }
        }
        const speedKmh = (p.speed || 0) * 3.6;
        if (!maxSpeeds[p.user_id] || speedKmh > maxSpeeds[p.user_id]) maxSpeeds[p.user_id] = speedKmh;
        userStatuses[p.user_id] = speedKmh > 1 ? 'mobile' : 'immobile';
        const color = getColor(p.user_id);
        const isMe = p.user_id === userId;
        if (!kalmanFilters[p.user_id]) kalmanFilters[p.user_id] = new KalmanFilter();
        const smooth = kalmanFilters[p.user_id].process(p.lat, p.lng, p.accuracy || 10);
        let bearing = null;
        if (histories[p.user_id]?.length > 0) {
            const last = histories[p.user_id][histories[p.user_id].length - 1];
            if (last[0] !== smooth.lat || last[1] !== smooth.lng) {
                bearing = calcBearing(last[0], last[1], smooth.lat, smooth.lng);
                bearings[p.user_id] = bearing;
            }
        }
        if (markers[p.user_id]) {
            markers[p.user_id].marker.setLatLng([smooth.lat, smooth.lng]);
            markers[p.user_id].marker.setIcon(createIcon(color, p.name, bearing, isMe));
        } else {
            const marker = L.marker([smooth.lat, smooth.lng], { icon: createIcon(color, p.name, bearing, isMe) }).addTo(map);
            const wa = p.whatsapp || '';
            marker.bindPopup(`
                <div style="font-family:sans-serif;min-width:200px;">
                    <b>${p.name}${isMe ? ' ⭐' : ''}</b><br>
                    <span style="color:#00d4ff;">${smooth.lat.toFixed(5)}, ${smooth.lng.toFixed(5)}</span><br>
                    🎯 Précision: ±${Math.round(p.accuracy || 0)}m<br>
                    ${speedKmh > 0.5 ? `🚀 Vitesse: ${speedKmh.toFixed(1)} km/h<br>` : ''}
                    ${wa ? `📱 WhatsApp: ${wa}<br>` : ''}
                    ${!isMe ? `<button onclick="showRouteTo('${p.user_id}')" style="margin-top:8px;padding:6px 12px;background:#ffd700;color:#000;border:0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">🛣️ Itinéraire</button>
                    ${wa ? `<button onclick="callWhatsAppDirect('${p.user_id}')" style="margin-top:8px;margin-left:5px;padding:6px 12px;background:#25d366;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">📞 WhatsApp</button>` : ''}` : ''}
                    <button onclick="openGoogleMaps(${smooth.lat}, ${smooth.lng})" style="margin-top:8px;margin-left:5px;padding:6px 12px;background:#4285f4;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">🗺️ Maps</button>
                </div>
            `);
            markers[p.user_id] = { marker, color, name: p.name };
        }
        updateTrail(p.user_id, smooth.lat, smooth.lng, color);
    });
    Object.keys(markers).forEach(uid => {
        if (!activeIds.has(uid)) {
            map.removeLayer(markers[uid].marker);
            delete markers[uid];
            if (trails[uid]) { map.removeLayer(trails[uid]); delete trails[uid]; }
            delete histories[uid];
            delete kalmanFilters[uid];
        }
    });
}

// ACTIONS
function focusUser(uid) { if (markers[uid]) { map.setView(markers[uid].marker.getLatLng(), 17, { animate: true }); markers[uid].marker.openPopup(); } }
function selectUser(uid) {
    focusUser(uid);
    if (uid !== userId) setTimeout(() => { if (confirm('🛣️ Afficher l\'itinéraire ?')) showRouteTo(uid); }, 500);
}
function openGoogleMaps(lat, lng) { window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank'); }
function resetView() { map.setView([6.13, 1.22], 2, { animate: true }); }
function followMe() { if (markers[userId]) map.setView(markers[userId].marker.getLatLng(), 18, { animate: true }); else alert('Position en cours...'); }
function fitAll() { const latlngs = Object.values(markers).map(m => m.marker.getLatLng()); if (latlngs.length > 0) map.fitBounds(latlngs, { padding: [50, 50], maxZoom: 18 }); }
function toggleFullscreen() { if (!document.fullscreenElement) document.documentElement.requestFullscreen(); else document.exitFullscreen(); }
function toggleSidebar() {
    const s = document.querySelector('.sidebar');
    const i = document.getElementById('toggleIcon');
    if (s) { s.classList.toggle('collapsed'); if (i) i.className = s.classList.contains('collapsed') ? 'fas fa-chevron-left' : 'fas fa-chevron-right'; }
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
function updateClock() { const el = document.getElementById('clock'); if (el) el.textContent = new Date().toLocaleTimeString('fr-FR'); }

// REFRESH
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

// DÉMARRAGE
updateClock();
setInterval(updateClock, 1000);
loadPlaces();
startAdminSharing();
fetchPositions();
setInterval(fetchPositions, REFRESH_INTERVAL);
setInterval(() => { sendAdminPosition(); }, 30000);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        sendAdminPosition();
        fetchPositions();
    }
});

console.log('%c 📍 Tracker COMPLET ULTRA PRÉCISION ✅', 'color:#00d4ff;font-weight:bold;font-size:14px');

// ============================================================
// COUCHE AVIONS EN TEMPS RÉEL (APIs gratuites, sans clé)
// ============================================================
let planesEnabled = false;
let planesInterval = null;
let planeMarkers = {};

// Miroirs ADS-B gratuits et sans clé [citation:6]
const ADSB_MIRRORS = [
    'https://api.adsb.lol/v2/lat/{lat}/lon/{lng}/dist/{dist}',
    'https://api.airplanes.live/v2/point/{lat}/{lng}/{dist}',
    'https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lng}/dist/{dist}'
];

function togglePlanes() {
    planesEnabled = !planesEnabled;
    const btn = document.getElementById('planesBtn');
    
    if (planesEnabled) {
        if (btn) {
            btn.style.background = 'rgba(0,212,255,.3)';
            btn.style.borderColor = '#00d4ff';
        }
        updateStatusBar('✈️ Chargement des avions...', '#00d4ff');
        fetchPlanes();
        planesInterval = setInterval(fetchPlanes, 15000);
    } else {
        if (btn) {
            btn.style.background = '';
            btn.style.borderColor = '';
        }
        if (planesInterval) clearInterval(planesInterval);
        // Supprimer tous les marqueurs d'avions
        Object.keys(planeMarkers).forEach(id => {
            map.removeLayer(planeMarkers[id]);
            delete planeMarkers[id];
        });
        updateStatusBar('✈️ Avions masqués', '#ffbd2e');
    }
}

async function fetchPlanes() {
    if (!planesEnabled) return;
    
    // Utiliser le centre de la carte
    const center = map.getCenter();
    const lat = center.lat.toFixed(4);
    const lng = center.lng.toFixed(4);
    const dist = 250; // Rayon en milles nautiques (~460 km)
    
    // Essayer chaque miroir jusqu'à ce qu'un fonctionne
    for (const mirror of ADSB_MIRRORS) {
        try {
            const url = mirror.replace('{lat}', lat).replace('{lng}', lng).replace('{dist}', dist);
            const c = new AbortController();
            const t = setTimeout(() => c.abort(), 10000);
            const r = await fetch(url, { signal: c.signal });
            clearTimeout(t);
            
            if (!r.ok) continue;
            
            const data = await r.json();
            const planes = data.ac || data.aircraft || [];
            
            updatePlanesOnMap(planes);
            updateStatusBar(`✈️ ${planes.length} avion(s) détecté(s)`, '#00d4ff');
            return;
        } catch (e) {
            continue;
        }
    }
    
    updateStatusBar('❌ Erreur chargement avions', '#ff5f57');
}

function updatePlanesOnMap(planes) {
    const activeIds = new Set();
    
    planes.forEach(plane => {
        const id = plane.hex || plane.icao24;
        if (!id) return;
        
        const lat = plane.lat;
        const lng = plane.lon;
        if (!lat || !lng) return;
        
        activeIds.add(id);
        
        const callsign = (plane.flight || plane.callsign || '').trim() || id;
        const altitude = plane.alt_baro || plane.altitude || 0;
        const speed = plane.gs || plane.speed || 0;
        const heading = plane.track || plane.heading || 0;
        
        // Icône avion avec rotation
        const icon = L.divIcon({
            className: 'plane-marker',
            html: `<div style="font-size:18px;color:#00d4ff;transform:rotate(${heading}deg);text-shadow:0 0 6px #00d4ff;">✈</div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });
        
        if (planeMarkers[id]) {
            planeMarkers[id].setLatLng([lat, lng]);
            planeMarkers[id].setIcon(icon);
        } else {
            const marker = L.marker([lat, lng], { icon }).addTo(map);
            marker.bindPopup(`
                <div style="font-family:monospace;font-size:12px;min-width:150px;">
                    <b style="color:#00d4ff;">✈️ ${callsign}</b><br>
                    Alt: ${Math.round(altitude)} ft<br>
                    Vitesse: ${Math.round(speed)} kt<br>
                    Cap: ${Math.round(heading)}°<br>
                    <small style="color:#888;">${id}</small>
                </div>
            `);
            planeMarkers[id] = marker;
        }
    });
    
    // Supprimer les avions qui ne sont plus visibles
    Object.keys(planeMarkers).forEach(id => {
        if (!activeIds.has(id)) {
            map.removeLayer(planeMarkers[id]);
            delete planeMarkers[id];
        }
    });
}

console.log('%c ✈️ Couche avions activée ✅', 'color:#00d4ff;font-weight:bold;font-size:14px');

// ============================================================
// 🛰️ SUIVI DE L'ISS (Open Notify API - Gratuit, sans clé)
// ============================================================
let issEnabled = false;
let issInterval = null;
let issMarker = null;
let issTrail = [];
let issTrailLine = null;

const ISS_API = 'http://api.open-notify.org/iss-now.json';
const ISS_CREW_API = 'http://api.open-notify.org/astros.json';

function toggleISS() {
    issEnabled = !issEnabled;
    const btn = document.getElementById('issBtn');
    
    if (issEnabled) {
        if (btn) {
            btn.style.background = 'rgba(0,212,255,.3)';
            btn.style.borderColor = '#00d4ff';
        }
        updateStatusBar('🛰️ Chargement de l\'ISS...', '#00d4ff');
        fetchISS();
        issInterval = setInterval(fetchISS, 5000);
    } else {
        if (btn) {
            btn.style.background = '';
            btn.style.borderColor = '';
        }
        if (issInterval) clearInterval(issInterval);
        if (issMarker) {
            map.removeLayer(issMarker);
            issMarker = null;
        }
        if (issTrailLine) {
            map.removeLayer(issTrailLine);
            issTrailLine = null;
        }
        issTrail = [];
        updateStatusBar('🛰️ ISS masquée', '#ffbd2e');
    }
}

async function fetchISS() {
    if (!issEnabled) return;
    
    try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 10000);
        const r = await fetch(ISS_API, { signal: c.signal });
        clearTimeout(t);
        
        if (!r.ok) throw new Error('Erreur API');
        
        const data = await r.json();
        const lat = parseFloat(data.iss_position.latitude);
        const lng = parseFloat(data.iss_position.longitude);
        
        // Mettre à jour le marqueur
        if (issMarker) {
            issMarker.setLatLng([lat, lng]);
        } else {
            const icon = L.divIcon({
                className: 'iss-marker',
                html: `<div style="font-size:24px;color:#fff;text-shadow:0 0 10px #00d4ff,0 0 20px #00d4ff;">🛰️</div>`,
                iconSize: [30, 30],
                iconAnchor: [15, 15]
            });
            issMarker = L.marker([lat, lng], { icon }).addTo(map);
            issMarker.bindPopup(`
                <div style="font-family:monospace;font-size:12px;min-width:150px;">
                    <b style="color:#00d4ff;">🛰️ ISS</b><br>
                    Lat: ${lat.toFixed(4)}<br>
                    Lng: ${lng.toFixed(4)}<br>
                    <small style="color:#888;">Mis à jour: ${new Date().toLocaleTimeString()}</small>
                </div>
            `);
        }
        
        // Trajectoire
        issTrail.push([lat, lng]);
        if (issTrail.length > 50) issTrail.shift();
        
        if (issTrailLine) map.removeLayer(issTrailLine);
        if (issTrail.length > 1) {
            issTrailLine = L.polyline(issTrail, {
                color: '#00d4ff',
                weight: 2,
                opacity: 0.6,
                dashArray: '5, 5'
            }).addTo(map);
        }
        
        updateStatusBar(`🛰️ ISS: ${lat.toFixed(4)}, ${lng.toFixed(4)}`, '#00d4ff');
        
    } catch (e) {
        updateStatusBar('❌ Erreur ISS (essai HTTPS)', '#ff5f57');
    }
}

console.log('%c 🛰️ ISS activée ✅', 'color:#00d4ff;font-weight:bold;font-size:14px');

// ============================================================
// 🌍 SÉISMES EN TEMPS RÉEL (GDACS API - Gratuit, sans clé)
// ============================================================
let eqEnabled = false;
let eqMarkers = [];
const GDACS_API = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ&alertlevel=orange;red';

function toggleEarthquakes() {
    eqEnabled = !eqEnabled;
    const btn = document.getElementById('eqBtn');
    
    if (eqEnabled) {
        if (btn) {
            btn.style.background = 'rgba(255,95,87,.3)';
            btn.style.borderColor = '#ff5f57';
        }
        updateStatusBar('🌍 Chargement des séismes...', '#ffbd2e');
        fetchEarthquakes();
    } else {
        if (btn) {
            btn.style.background = '';
            btn.style.borderColor = '';
        }
        eqMarkers.forEach(m => map.removeLayer(m));
        eqMarkers = [];
        updateStatusBar('🌍 Séismes masqués', '#ffbd2e');
    }
}

async function fetchEarthquakes() {
    if (!eqEnabled) return;
    
    try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 15000);
        const r = await fetch(GDACS_API, { signal: c.signal });
        clearTimeout(t);
        
        if (!r.ok) throw new Error('Erreur API');
        
        const data = await r.json();
        const events = data.features || [];
        
        // Nettoyer les anciens marqueurs
        eqMarkers.forEach(m => map.removeLayer(m));
        eqMarkers = [];
        
        events.forEach(event => {
            const props = event.properties;
            const coords = event.geometry?.coordinates;
            if (!coords) return;
            
            const [lng, lat] = coords;
            const magnitude = props.severitydata?.severity || 0;
            const alertLevel = props.alertlevel || 'Green';
            const name = props.name || 'Séisme';
            
            let color = '#28c840';
            if (alertLevel === 'Orange') color = '#ffbd2e';
            if (alertLevel === 'Red') color = '#ff5f57';
            
            const icon = L.divIcon({
                className: 'eq-marker',
                html: `<div style="width:20px;height:20px;background:${color};border-radius:50%;border:2px solid #fff;box-shadow:0 0 10px ${color};opacity:0.8;"></div>`,
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });
            
            const marker = L.marker([lat, lng], { icon }).addTo(map);
            marker.bindPopup(`
                <div style="font-family:sans-serif;font-size:12px;min-width:180px;">
                    <b style="color:${color};">🌍 ${name}</b><br>
                    Magnitude: ${magnitude.toFixed(1)}<br>
                    Alerte: ${alertLevel}<br>
                    <small>${props.fromdate || ''}</small>
                </div>
            `);
            eqMarkers.push(marker);
        });
        
        updateStatusBar(`🌍 ${events.length} séisme(s) détecté(s)`, '#ff5f57');
        
    } catch (e) {
        updateStatusBar('❌ Erreur séismes', '#ff5f57');
    }
}

console.log('%c 🌍 Séismes activés ✅', 'color:#ff5f57;font-weight:bold;font-size:14px');

// ============================================================
// 🌍 SÉISMES EN TEMPS RÉEL (GDACS API - Gratuit, sans clé)
// ============================================================
let eqEnabled = false;
let eqMarkers = [];
const GDACS_API = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ&alertlevel=orange;red';

function toggleEarthquakes() {
    eqEnabled = !eqEnabled;
    const btn = document.getElementById('eqBtn');
    
    if (eqEnabled) {
        if (btn) {
            btn.style.background = 'rgba(255,95,87,.3)';
            btn.style.borderColor = '#ff5f57';
        }
        updateStatusBar('🌍 Chargement des séismes...', '#ffbd2e');
        fetchEarthquakes();
    } else {
        if (btn) {
            btn.style.background = '';
            btn.style.borderColor = '';
        }
        eqMarkers.forEach(m => map.removeLayer(m));
        eqMarkers = [];
        updateStatusBar('🌍 Séismes masqués', '#ffbd2e');
    }
}

async function fetchEarthquakes() {
    if (!eqEnabled) return;
    
    try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 15000);
        const r = await fetch(GDACS_API, { signal: c.signal });
        clearTimeout(t);
        
        if (!r.ok) throw new Error('Erreur API');
        
        const data = await r.json();
        const events = data.features || [];
        
        // Nettoyer les anciens marqueurs
        eqMarkers.forEach(m => map.removeLayer(m));
        eqMarkers = [];
        
        events.forEach(event => {
            const props = event.properties;
            const coords = event.geometry?.coordinates;
            if (!coords) return;
            
            const [lng, lat] = coords;
            const magnitude = props.severitydata?.severity || 0;
            const alertLevel = props.alertlevel || 'Green';
            const name = props.name || 'Séisme';
            
            let color = '#28c840';
            if (alertLevel === 'Orange') color = '#ffbd2e';
            if (alertLevel === 'Red') color = '#ff5f57';
            
            const icon = L.divIcon({
                className: 'eq-marker',
                html: `<div style="width:20px;height:20px;background:${color};border-radius:50%;border:2px solid #fff;box-shadow:0 0 10px ${color};opacity:0.8;"></div>`,
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });
            
            const marker = L.marker([lat, lng], { icon }).addTo(map);
            marker.bindPopup(`
                <div style="font-family:sans-serif;font-size:12px;min-width:180px;">
                    <b style="color:${color};">🌍 ${name}</b><br>
                    Magnitude: ${magnitude.toFixed(1)}<br>
                    Alerte: ${alertLevel}<br>
                    <small>${props.fromdate || ''}</small>
                </div>
            `);
            eqMarkers.push(marker);
        });
        
        updateStatusBar(`🌍 ${events.length} séisme(s) détecté(s)`, '#ff5f57');
        
    } catch (e) {
        updateStatusBar('❌ Erreur séismes', '#ff5f57');
    }
}

console.log('%c 🌍 Séismes activés ✅', 'color:#ff5f57;font-weight:bold;font-size:14px');

// ============================================================
// 🚢 NAVIRES (aisstream.io - Gratuit, sans clé pour démo)
// ============================================================
let shipsEnabled = false;
let shipMarkers = {};

function toggleShips() {
    shipsEnabled = !shipsEnabled;
    const btn = document.getElementById('shipBtn');
    
    if (shipsEnabled) {
        if (btn) {
            btn.style.background = 'rgba(0,212,255,.3)';
            btn.style.borderColor = '#00d4ff';
        }
        updateStatusBar('🚢 Chargement des navires (démo limitée)...', '#00d4ff');
        // Note: AIS nécessite souvent une clé ou une contribution
        // On utilise une démo publique limitée
        fetchShipsDemo();
    } else {
        if (btn) {
            btn.style.background = '';
            btn.style.borderColor = '';
        }
        Object.values(shipMarkers).forEach(m => map.removeLayer(m));
        shipMarkers = {};
        updateStatusBar('🚢 Navires masqués', '#ffbd2e');
    }
}

async function fetchShipsDemo() {
    // Les APIs AIS gratuites sans clé sont rares en 2026.
    // On affiche un message informatif pour l'instant.
    updateStatusBar('🚢 AIS: couverture limitée en Afrique (nécessite clé)', '#ffbd2e');
    
    // Exemple de données de démo (à remplacer par une vraie API plus tard)
    const demoShips = [
        { name: 'Cargo Demo', lat: 6.35, lng: 2.42, speed: 12 },
        { name: 'Tanker Demo', lat: 6.40, lng: 2.35, speed: 8 }
    ];
    
    demoShips.forEach(ship => {
        const icon = L.divIcon({
            className: 'ship-marker',
            html: `<div style="font-size:18px;color:#00d4ff;">🚢</div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });
        const marker = L.marker([ship.lat, ship.lng], { icon }).addTo(map);
        marker.bindPopup(`<b>🚢 ${ship.name}</b><br>Vitesse: ${ship.speed} kt`);
        shipMarkers[ship.name] = marker;
    });
}

console.log('%c 🚢 Navires activés (démo) ✅', 'color:#00d4ff;font-weight:bold;font-size:14px');

// ============================================================
// 🗺️ HEATMAP (Leaflet.heat - Gratuit)
// ============================================================
let heatEnabled = false;
let heatLayer = null;
let heatPoints = [];

function toggleHeatmap() {
    heatEnabled = !heatEnabled;
    const btn = document.getElementById('heatBtn');
    
    if (heatEnabled) {
        if (btn) {
            btn.style.background = 'rgba(255,189,46,.3)';
            btn.style.borderColor = '#ffbd2e';
        }
        // Collecter tous les points des trajectoires
        heatPoints = [];
        Object.keys(histories).forEach(uid => {
            (histories[uid] || []).forEach(pt => {
                heatPoints.push([pt[0], pt[1], 0.5]);
            });
        });
        
        if (heatPoints.length > 0) {
            if (heatLayer) map.removeLayer(heatLayer);
            heatLayer = L.heatLayer(heatPoints, {
                radius: 25,
                blur: 15,
                maxZoom: 17,
                gradient: { 0.4: 'blue', 0.65: 'lime', 1: 'red' }
            }).addTo(map);
            updateStatusBar(`🗺️ Heatmap: ${heatPoints.length} points`, '#ffbd2e');
        } else {
            updateStatusBar('🗺️ Aucune donnée de trajectoire', '#ffbd2e');
        }
    } else {
        if (btn) {
            btn.style.background = '';
            btn.style.borderColor = '';
        }
        if (heatLayer) {
            map.removeLayer(heatLayer);
            heatLayer = null;
        }
        updateStatusBar('🗺️ Heatmap masquée', '#ffbd2e');
    }
}

console.log('%c 🗺️ Heatmap activée ✅', 'color:#ffbd2e;font-weight:bold;font-size:14px');
