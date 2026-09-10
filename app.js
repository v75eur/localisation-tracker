// ============================================================
// TRACKER FBI - Mise à jour stable (pas de clignotement)
// ============================================================

const BACKEND_URL = 'https://localisation-backend-sm3t.onrender.com';
const REFRESH_INTERVAL = 5000;
const SEND_INTERVAL = 3000;
const TRAIL_MAX_POINTS = 200;
const MAX_ZOOM = 21;

fetch(BACKEND_URL + '/api/ping').catch(() => {});

// ============================================================
// CARTE
// ============================================================
const map = L.map('map', { maxZoom: MAX_ZOOM, zoomControl: false }).setView([6.13, 1.22], 2);

const planLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap', maxZoom: MAX_ZOOM, maxNativeZoom: 19
});

const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri', maxZoom: MAX_ZOOM, maxNativeZoom: 19
});

const labelsLayer = L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/toner-labels/{z}/{x}/{y}.png', {
    maxZoom: MAX_ZOOM, maxNativeZoom: 18, opacity: 0.7
});

let currentMode = 'plan';
planLayer.addTo(map);

function toggleSatellite() {
    if (currentMode === 'plan') {
        map.removeLayer(planLayer);
        satelliteLayer.addTo(map);
        labelsLayer.addTo(map);
        currentMode = 'satellite';
        document.getElementById('satBtn').innerHTML = '<i class="fas fa-map"></i>';
    } else {
        map.removeLayer(satelliteLayer);
        map.removeLayer(labelsLayer);
        planLayer.addTo(map);
        currentMode = 'plan';
        document.getElementById('satBtn').innerHTML = '<i class="fas fa-satellite"></i>';
    }
}
function zoomIn() { map.zoomIn(); }
function zoomOut() { map.zoomOut(); }

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
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (e) {}
}
window.addEventListener('load', requestWakeLock);
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && wakeLock === null) await requestWakeLock();
});

// ============================================================
// ENVOI AUTO ADMIN
// ============================================================
let adminInterval = null;
async function sendAdminPosition() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            try {
                const c = new AbortController();
                const t = setTimeout(() => c.abort(), 30000);
                await fetch(BACKEND_URL + '/api/position', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        user_id: userId, name: 'Admin',
                        lat: pos.coords.latitude, lng: pos.coords.longitude,
                        speed: pos.coords.speed || 0,
                        accuracy: pos.coords.accuracy || 0,
                        heading: pos.coords.heading || 0,
                        altitude: pos.coords.altitude || 0
                    }),
                    signal: c.signal
                });
                clearTimeout(t);
            } catch (e) {}
        },
        (err) => console.warn('Géoloc:', err.message),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
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
let itineraryLine = null;
let itineraryTarget = null;
let itineraryMode = false;
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

// CALCULS
function calcBearing(lat1, lng1, lat2, lng2) {
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const l1 = lat1 * Math.PI / 180, l2 = lat2 * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(l2);
    const x = Math.cos(l1) * Math.sin(l2) - Math.sin(l1) * Math.cos(l2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function bearingToArrow(b) {
    if (b >= 337.5 || b < 22.5) return '↑';
    if (b >= 22.5 && b < 67.5) return '↗';
    if (b >= 67.5 && b < 112.5) return '→';
    if (b >= 112.5 && b < 157.5) return '↘';
    if (b >= 157.5 && b < 202.5) return '↓';
    if (b >= 202.5 && b < 247.5) return '↙';
    if (b >= 247.5 && b < 292.5) return '←';
    return '↖';
}
function calcDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function formatDist(m) { return m < 1000 ? Math.round(m) + ' m' : (m/1000).toFixed(2) + ' km'; }
function formatSpeed(kmh) { return kmh.toFixed(1) + ' km/h'; }

// ICÔNE
function createIcon(color, name, bearing, isMe) {
    const arrow = bearing !== null ? bearingToArrow(bearing) : '';
    const border = isMe ? '4px solid #ffd700' : '3px solid #fff';
    const size = isMe ? '48px' : '44px';
    return L.divIcon({
        className: 'custom-marker',
        html: `<div class="marker-direction">${arrow}</div>
               <div class="marker-icon" style="background:${color};width:${size};height:${size};border:${border};">
                   ${name.charAt(0).toUpperCase()}
               </div>`,
        iconSize: [44, 60], iconAnchor: [22, 44]
    });
}

// TRAJECTOIRE
function updateTrail(uid, lat, lng, color) {
    if (!histories[uid]) histories[uid] = [];
    const h = histories[uid];
    if (h.length === 0 || h[h.length-1][0] !== lat || h[h.length-1][1] !== lng) {
        h.push([lat, lng]);
    }
    if (h.length > TRAIL_MAX_POINTS) h.shift();
    if (trails[uid]) map.removeLayer(trails[uid]);
    if (h.length > 1) {
        trails[uid] = L.polyline(h, {
            color, weight: 3, opacity: 0.6, smoothFactor: 1, dashArray: '5, 10'
        }).addTo(map);
    }
}

// ITINÉRAIRE
function updateItinerary(positions) {
    if (itineraryLine) { map.removeLayer(itineraryLine); itineraryLine = null; }
    if (!itineraryTarget) return;
    const me = positions.find(p => p.user_id === userId);
    const target = positions.find(p => p.user_id === itineraryTarget);
    if (!me || !target) return;
    const dist = calcDistance(me.lat, me.lng, target.lat, target.lng);
    const bearing = calcBearing(me.lat, me.lng, target.lat, target.lng);
    itineraryLine = L.polyline([[me.lat, me.lng], [target.lat, target.lng]], {
        color: '#ffd700', weight: 3, opacity: 0.8, dashArray: '10, 5'
    }).addTo(map);
    itineraryLine.bindPopup(`
        <b>Itinéraire vers ${target.name}</b><br>
        📏 ${formatDist(dist)}<br>
        🧭 ${Math.round(bearing)}°<br>
        ⏱️ À pied: ${Math.round(dist/1.4/60)} min<br>
        🚗 Voiture: ${Math.round(dist/13.9/60)} min
    `).openPopup();
}

// ============================================================
// MISE À JOUR SANS CLIGNOTEMENT
// ============================================================

// Cache pour éviter les réécritures inutiles
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
    
    const me = positions.find(p => p.user_id === userId);
    
    // Trier par âge (plus récent en haut)
    const sorted = [...positions].sort((a, b) => a.age_seconds - b.age_seconds);
    
    const newHTML = sorted.map(p => {
        const age = p.age_seconds;
        const ageText = age < 60 ? `${age}s` : `${Math.floor(age/60)}min`;
        let distance = 0, bearing = null, arrow = '';
        if (histories[p.user_id]?.length > 1) {
            const h = histories[p.user_id];
            const last = h[h.length-1], prev = h[h.length-2];
            distance = calcDistance(prev[0], prev[1], last[0], last[1]);
            bearing = calcBearing(prev[0], prev[1], last[0], last[1]);
            arrow = bearingToArrow(bearing);
        }
        const speedKmh = (p.speed || 0) * 3.6;
        const color = markers[p.user_id]?.color || '#00d4ff';
        const isMe = p.user_id === userId;
        const isTarget = p.user_id === itineraryTarget;
        let distToMe = null;
        if (me && !isMe) distToMe = calcDistance(me.lat, me.lng, p.lat, p.lng);
        
        // Détection changement de âge pour éviter le re-render
        return `<div class="user-item ${isMe ? 'me' : ''}" data-uid="${p.user_id}" onclick="selectUser('${p.user_id}')" style="${isTarget ? 'border-color:#ffd700;' : ''}">
            <div class="avatar" style="background:${color}">
                ${p.name.charAt(0).toUpperCase()}
                ${arrow ? `<div class="direction">${arrow}</div>` : ''}
            </div>
            <div class="info">
                <div class="name">${p.name} ${isMe ? '⭐' : ''}</div>
                <div class="coords">${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</div>
                <div class="stats">
                    <span><i class="fas fa-clock"></i> ${ageText}</span>
                    <span><i class="fas fa-bullseye"></i> ±${Math.round(p.accuracy || 0)}m</span>
                    ${speedKmh > 0.5 ? `<span><i class="fas fa-tachometer-alt"></i> ${formatSpeed(speedKmh)}</span>` : ''}
                    ${distToMe !== null ? `<span style="color:#ffd700"><i class="fas fa-arrows-alt-h"></i> ${formatDist(distToMe)}</span>` : ''}
                </div>
            </div>
        </div>`;
    }).join('');
    
    // Ne réécrire QUE si le contenu a changé
    if (newHTML !== lastListHTML) {
        // Mise à jour intelligente : remplacer uniquement les éléments modifiés
        const existingItems = {};
        list.querySelectorAll('.user-item').forEach(el => {
            existingItems[el.dataset.uid] = el;
        });
        
        sorted.forEach(p => {
            const uid = p.user_id;
            if (!existingItems[uid]) {
                // Nouvel utilisateur : ajouter
                const temp = document.createElement('div');
                temp.innerHTML = newHTML.match(new RegExp(`<div class="user-item[^>]*data-uid="${uid}"[\\s\\S]*?</div>\\s*</div>`, 'g'))?.[0] || '');
                if (temp.firstChild) list.appendChild(temp.firstChild);
            } else {
                // Mettre à jour les infos sans toucher au DOM principal
                const item = existingItems[uid];
                const stats = item.querySelector('.stats');
                const coords = item.querySelector('.coords');
                if (coords) coords.textContent = `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
                if (stats) {
                    const age = p.age_seconds;
                    const ageText = age < 60 ? `${age}s` : `${Math.floor(age/60)}min`;
                    const speedKmh = (p.speed || 0) * 3.6;
                    const me = positions.find(x => x.user_id === userId);
                    const isMe = uid === userId;
                    let distToMe = null;
                    if (me && !isMe) distToMe = calcDistance(me.lat, me.lng, p.lat, p.lng);
                    
                    let bearing = null, distance = 0;
                    if (histories[uid]?.length > 1) {
                        const h = histories[uid];
                        distance = calcDistance(h[h.length-2][0], h[h.length-2][1], h[h.length-1][0], h[h.length-1][1]);
                        bearing = calcBearing(h[h.length-2][0], h[h.length-2][1], h[h.length-1][0], h[h.length-1][1]);
                    }
                    
                    stats.innerHTML = `
                        <span><i class="fas fa-clock"></i> ${ageText}</span>
                        <span><i class="fas fa-bullseye"></i> ±${Math.round(p.accuracy || 0)}m</span>
                        ${speedKmh > 0.5 ? `<span><i class="fas fa-tachometer-alt"></i> ${formatSpeed(speedKmh)}</span>` : ''}
                        ${distToMe !== null ? `<span style="color:#ffd700"><i class="fas fa-arrows-alt-h"></i> ${formatDist(distToMe)}</span>` : ''}
                    `;
                }
            }
        });
        
        // Supprimer les utilisateurs disparus
        list.querySelectorAll('.user-item').forEach(el => {
            const uid = el.dataset.uid;
            if (!sorted.find(p => p.user_id === uid)) {
                el.remove();
            }
        });
        
        lastListHTML = newHTML;
    }
}

// ============================================================
// CARTE - Mise à jour SMOOTH des marqueurs
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
            // Mise à jour SMOOTH : glisser le marqueur
            const marker = markers[p.user_id].marker;
            const oldLatLng = marker.getLatLng();
            
            // Animation de glissement
            const steps = 10;
            const latStep = (p.lat - oldLatLng.lat) / steps;
            const lngStep = (p.lng - oldLatLng.lng) / steps;
            let step = 0;
            
            const animate = () => {
                step++;
                if (step <= steps) {
                    marker.setLatLng([oldLatLng.lat + latStep * step, oldLatLng.lng + lngStep * step]);
                    requestAnimationFrame(animate);
                }
            };
            animate();
            
            marker.setIcon(createIcon(color, p.name, bearing, isMe));
            
            // Mettre à jour le popup
            const speedKmh = (p.speed || 0) * 3.6;
            marker.getPopup()?.setContent(`
                <div style="font-family:sans-serif;min-width:180px;">
                    <b>${p.name}${isMe ? ' ⭐' : ''}</b><br>
                    <span style="color:#00d4ff;">${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</span><br>
                    🎯 Précision: ±${Math.round(p.accuracy || 0)}m<br>
                    ${speedKmh > 0.5 ? `🚀 ${formatSpeed(speedKmh)}<br>` : ''}
                    <small>Vu il y a ${p.age_seconds}s</small><br>
                    <button onclick="zoomTo('${p.user_id}')" style="margin-top:5px;padding:3px 8px;background:#00d4ff;border:0;border-radius:4px;cursor:pointer;">🔍 Zoom</button>
                </div>
            `);
        } else {
            // Nouveau marqueur
            const marker = L.marker([p.lat, p.lng], {
                icon: createIcon(color, p.name, bearing, isMe)
            }).addTo(map);
            
            const speedKmh = (p.speed || 0) * 3.6;
            marker.bindPopup(`
                <div style="font-family:sans-serif;min-width:180px;">
                    <b>${p.name}${isMe ? ' ⭐' : ''}</b><br>
                    <span style="color:#00d4ff;">${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</span><br>
                    🎯 Précision: ±${Math.round(p.accuracy || 0)}m<br>
                    ${speedKmh > 0.5 ? `🚀 ${formatSpeed(speedKmh)}<br>` : ''}
                    <small>Vu il y a ${p.age_seconds}s</small><br>
                    <button onclick="zoomTo('${p.user_id}')" style="margin-top:5px;padding:3px 8px;background:#00d4ff;border:0;border-radius:4px;cursor:pointer;">🔍 Zoom</button>
                </div>
            `);
            
            markers[p.user_id] = { marker, color };
        }
        
        updateTrail(p.user_id, p.lat, p.lng, color);
    });
    
    // Supprimer les marqueurs inactifs
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
function zoomTo(uid) {
    if (markers[uid]) {
        map.setView(markers[uid].marker.getLatLng(), 21, { animate: true });
        markers[uid].marker.openPopup();
    }
}
function selectUser(uid) {
    focusUser(uid);
    if (itineraryMode) itineraryTarget = uid;
}

// BOUTONS
function resetView() { map.setView([6.13, 1.22], 2, { animate: true }); }
function followMe() {
    if (markers[userId]) {
        map.setView(markers[userId].marker.getLatLng(), 18, { animate: true });
        markers[userId].marker.openPopup();
    } else {
        alert('Position admin en cours de détection...');
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
function filterUsers(q) {
    document.querySelectorAll('.user-item').forEach(el => {
        const n = el.querySelector('.name')?.textContent.toLowerCase() || '';
        el.style.display = n.includes(q.toLowerCase()) ? 'flex' : 'none';
    });
}
function toggleSidebar() {
    const s = document.querySelector('.sidebar');
    const i = document.getElementById('toggleIcon');
    if (s) {
        s.classList.toggle('collapsed');
        if (i) i.className = s.classList.contains('collapsed') ? 'fas fa-chevron-left' : 'fas fa-chevron-right';
    }
}
function toggleItinerary() {
    itineraryMode = !itineraryMode;
    if (!itineraryMode) {
        itineraryTarget = null;
        if (itineraryLine) { map.removeLayer(itineraryLine); itineraryLine = null; }
    }
    alert(itineraryMode ? 'Mode itinéraire ACTIVÉ. Cliquez sur un utilisateur.' : 'Mode itinéraire désactivé.');
}
function exportGPX() {
    const uid = itineraryTarget || userId;
    const h = histories[uid];
    if (!h || h.length < 2) { alert('Pas assez de points'); return; }
    let gpx = '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>';
    h.forEach(pt => { gpx += `<trkpt lat="${pt[0]}" lon="${pt[1]}"></trkpt>`; });
    gpx += '</trkseg></trk></gpx>';
    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trajectoire_${uid}.gpx`;
    a.click();
}

function updateClock() {
    const el = document.getElementById('clock');
    if (el) el.textContent = new Date().toLocaleTimeString('fr-FR');
}

// RAFRAÎCHISSEMENT
let attempts = 0;
async function fetchPositions() {
    try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 60000);
        const r = await fetch(BACKEND_URL + '/api/positions', { signal: c.signal });
        clearTimeout(t);
        if (!r.ok) throw new Error();
        const data = await r.json();
        
        data.positions.forEach(p => {
            if (!knownUsers.has(p.user_id) && p.user_id !== userId) {
                knownUsers.add(p.user_id);
                map.flyTo([p.lat, p.lng], 16, { duration: 2 });
            }
        });
        
        updateMap(data.positions);
        updateUsersList(data.positions);
        updateItinerary(data.positions);
        attempts = 0;
        const d = document.getElementById('liveDot');
        if (d) d.style.background = '#28c840';
    } catch (e) {
        attempts++;
        const d = document.getElementById('liveDot');
        if (d) d.style.background = '#ff5f57';
        setTimeout(fetchPositions, Math.min(1000 * attempts, 5000));
    }
}

// DÉMARRAGE
updateClock();
setInterval(updateClock, 1000);
startAdminSharing();
fetchPositions();
setInterval(fetchPositions, REFRESH_INTERVAL);

console.log('%c 📍 Tracker FBI STABLE ✅', 'color:#00d4ff;font-weight:bold;font-size:16px');
