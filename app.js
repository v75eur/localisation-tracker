const BACKEND_URL = 'https://localisation-backend.onrender.com';

const map = L.map('map').setView([0, 0], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19
}).addTo(map);

const markers = {};
const colors = ['#00d4ff', '#7b2ffc', '#ff5f57', '#ffbd2e', '#28c840', '#ff8c00', '#00ff88', '#ff00ff'];
let colorIndex = 0;

function getColor(userId) {
    if (!markers[userId]) {
        colorIndex = (colorIndex + 1) % colors.length;
        return colors[colorIndex];
    }
    return markers[userId].color;
}

function createIcon(color, name) {
    return L.divIcon({
        className: 'custom-marker',
        html: `<div style="background:${color};width:40px;height:40px;border-radius:50%;border:3px solid #fff;box-shadow:0 4px 20px ${color}80;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:14px;font-family:sans-serif;">${name.charAt(0).toUpperCase()}</div>`,
        iconSize: [40, 40],
        iconAnchor: [20, 20]
    });
}

function updateUsersList(positions) {
    const list = document.getElementById('userList');
    const count = document.getElementById('userCount');
    count.textContent = positions.length;
    
    if (positions.length === 0) {
        list.innerHTML = '<div class="empty"><i class="fas fa-satellite-dish"></i>En attente de positions...</div>';
        return;
    }
    
    list.innerHTML = positions.map(p => {
        const age = p.age_seconds;
        const ageClass = age < 10 ? '' : (age < 60 ? 'old' : 'stale');
        const ageText = age < 60 ? `${age}s` : `${Math.floor(age/60)}min`;
        return `<div class="user-item">
            <div class="avatar" style="background:${markers[p.user_id]?.color || '#00d4ff'}">${p.name.charAt(0).toUpperCase()}</div>
            <div class="info">
                <div class="name">${p.name}</div>
                <div class="coords">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
                <div class="age ${ageClass}">● ${ageText}</div>
            </div>
        </div>`;
    }).join('');
}

function updateMap(positions) {
    const activeIds = new Set();
    
    positions.forEach(p => {
        activeIds.add(p.user_id);
        const color = getColor(p.user_id);
        
        if (markers[p.user_id]) {
            markers[p.user_id].marker.setLatLng([p.lat, p.lng]);
            markers[p.user_id].marker.setIcon(createIcon(color, p.name));
        } else {
            const marker = L.marker([p.lat, p.lng], { icon: createIcon(color, p.name) }).addTo(map);
            marker.bindPopup(`<b>${p.name}</b><br>${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`);
            markers[p.user_id] = { marker, color };
        }
    });
    
    Object.keys(markers).forEach(uid => {
        if (!activeIds.has(uid)) {
            map.removeLayer(markers[uid].marker);
            delete markers[uid];
        }
    });
}

async function fetchPositions() {
    try {
        const response = await fetch(BACKEND_URL + '/api/positions');
        const data = await response.json();
        updateMap(data.positions);
        updateUsersList(data.positions);
    } catch (e) {
        console.error('Erreur:', e);
    }
}

fetchPositions();
setInterval(fetchPositions, 3000);
