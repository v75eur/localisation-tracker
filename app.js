const BACKEND_URL = 'https://localisation-backend-sm3t.onrender.com';
const REFRESH_INTERVAL = 3000;
const TRAIL_MAX_POINTS = 50;

fetch(BACKEND_URL + '/api/ping').catch(() => {});

const map = L.map('map', { zoomControl: false, attributionControl: false }).setView([6.13, 1.22], 2);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO', maxZoom: 19
}).addTo(map);

L.control.zoom({ position: 'bottomright' }).addTo(map);

const markers = {};
const trails = {};
const histories = {};
const colors = ['#00d4ff', '#7b2ffc', '#ff5f57', '#ffbd2e', '#28c840', '#ff8c00', '#00ff88', '#ff00ff'];
let colorIndex = 0;

function getColor(userId) {
    if (!markers[userId]) {
        colorIndex = (colorIndex + 1) % colors.length;
        return colors[colorIndex];
    }
    return markers[userId].color;
}

function calculateBearing(lat1, lng1, lat2, lng2) {
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function bearingToArrow(bearing) {
    if (bearing >= 337.5 || bearing < 22.5) return '↑';
    if (bearing >= 22.5 && bearing < 67.5) return '↗';
    if (bearing >= 67.5 && bearing < 112.5) return '→';
    if (bearing >= 112.5 && bearing < 157.5) return '↘';
    if (bearing >= 157.5 && bearing < 202.5) return '↓';
    if (bearing >= 202.5 && bearing < 247.5) return '↙';
    if (bearing >= 247.5 && bearing < 292.5) return '←';
    return '↖';
}

function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) ** 2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatDistance(m) {
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toFixed(2) + ' km';
}

function createIcon(color, name, bearing) {
    return L.divIcon({
        className: 'custom-marker',
        html: `
            <div class="marker-direction">${bearing !== null ? bearingToArrow(bearing) : ''}</div>
            <div class="marker-icon" style="background:${color};width:44px;height:44px;">
                ${name.charAt(0).toUpperCase()}
            </div>`,
        iconSize: [44, 60],
        iconAnchor: [22, 44]
    });
}

function updateTrail(userId, lat, lng, color) {
    if (!histories[userId]) histories[userId] = [];
    histories[userId].push([lat, lng]);
    if (histories[userId].length > TRAIL_MAX_POINTS) histories[userId].shift();
    if (trails[userId]) map.removeLayer(trails[userId]);
    if (histories[userId].length > 1) {
        trails[userId] = L.polyline(histories[userId], {
            color, weight: 3, opacity: 0.6, smoothFactor: 1, dashArray: '5, 10'
        }).addTo(map);
    }
}

function updateUsersList(positions) {
    const list = document.getElementById('userList');
    document.getElementById('userCount').textContent = positions.length;
    if (positions.length === 0) {
        list.innerHTML = '<div class="empty"><i class="fas fa-satellite-dish"></i>En attente...</div>';
        return;
    }
    list.innerHTML = positions.map(p => {
        const age = p.age_seconds;
        const ageClass = age < 10 ? '' : (age < 60 ? 'old' : 'stale');
        const ageText = age < 60 ? `${age}s` : `${Math.floor(age/60)}min`;
        let distance = 0, bearing = null, arrow = '';
        if (histories[p.user_id]?.length > 1) {
            const hist = histories[p.user_id];
            const last = hist[hist.length - 1];
            const prev = hist[hist.length - 2];
            distance = calculateDistance(prev[0], prev[1], last[0], last[1]);
            bearing = calculateBearing(prev[0], prev[1], last[0], last[1]);
            arrow = bearingToArrow(bearing);
        }
        const markerColor = markers[p.user_id]?.color || '#00d4ff';
        return `<div class="user-item" onclick="focusUser('${p.user_id}')">
            <div class="avatar" style="background:${markerColor}">
                ${p.name.charAt(0).toUpperCase()}
                ${arrow ? `<div class="direction">${arrow}</div>` : ''}
            </div>
            <div class="info">
                <div class="name">${p.name}</div>
                <div class="coords">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
                <div class="stats">
                    <span><i class="fas fa-clock"></i> ${ageText}</span>
                    ${distance > 0 ? `<span><i class="fas fa-route"></i> ${formatDistance(distance)}</span>` : ''}
                    ${bearing !== null ? `<span><i class="fas fa-compass"></i> ${Math.round(bearing)}°</span>` : ''}
                </div>
            </div>
        </div>`;
    }).join('');
}

function updateMap(positions) {
    const activeIds = new Set();
    positions.forEach(p => {
        activeIds.add(p.user_id);
        const color = getColor(p.user_id);
        let bearing = null;
        if (histories[p.user_id]?.length > 0) {
            const last = histories[p.user_id][histories[p.user_id].length - 1];
            if (last[0] !== p.lat || last[1] !== p.lng) bearing = calculateBearing(last[0], last[1], p.lat, p.lng);
        }
        if (markers[p.user_id]) {
            markers[p.user_id].marker.setLatLng([p.lat, p.lng]);
            markers[p.user_id].marker.setIcon(createIcon(color, p.name, bearing));
        } else {
            const marker = L.marker([p.lat, p.lng], { icon: createIcon(color, p.name, bearing) }).addTo(map);
            marker.bindPopup(`<b>${p.name}</b><br>${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`);
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

function focusUser(userId) {
    if (markers[userId]) {
        map.setView(markers[userId].marker.getLatLng(), 16, { animate: true });
        markers[userId].marker.openPopup();
    }
}

async function fetchPositions() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);
        const response = await fetch(BACKEND_URL + '/api/positions', { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await response.json();
        updateMap(data.positions);
        updateUsersList(data.positions);
    } catch (e) { console.error('Erreur:', e); }
}

function updateClock() {
    document.getElementById('clock').textContent = new Date().toLocaleTimeString('fr-FR');
}

updateClock();
setInterval(updateClock, 1000);
fetchPositions();
setInterval(fetchPositions, REFRESH_INTERVAL);
console.log('%c 📍 Tracker FBI + Persistance ✅', 'color:#00d4ff;font-weight:bold;font-size:14px');
