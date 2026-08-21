const map = L.map('map', {
    zoomControl: false,
    attributionControl: false
}).setView([37.5665, 126.9780], 11);

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
}).addTo(map);

L.control.attribution({ position: 'bottomright', prefix: false }).addTo(map);

const gpsLayer = L.layerGroup().addTo(map);

function keyOf(lat, lng) {
    return `${parseFloat(lat).toFixed(6)}|${parseFloat(lng).toFixed(6)}`;
}

// 줌 12 미만: 시군구 색칠 지도 / 12~15: (서울만) 동 색칠 지도 / 그 이상은 개별 마커·클러스터
// 경기도는 동 단위 경계 데이터가 없어 시군구 다음 바로 마커로 전환된다.
const SIGUNGU_MAX_ZOOM = 12;
const DONG_MAX_ZOOM = 15;
const DONG_NAME_MIN_ZOOM = 14;
let sigunguChoroLayer = null;
let dongChoroLayer = null;
// LAWD 코드(sggCd) -> 시군구 표시 이름. sigungu.geojson 로드 시 채워지며 실거래/허가 둘 다 공유한다.
let LAWD_TO_SIGUNGU = {};

function sigunguKeyOf(item) {
    return LAWD_TO_SIGUNGU[item.sggCd] || '기타';
}

function choroColorScale(count, breaks) {
    if (count <= 0) return '#dfe6e9';
    if (count >= breaks[1]) return '#e74c3c';
    if (count >= breaks[0]) return '#f1c40f';
    return '#3498db';
}

function computeStatsBy(aggregated, keyFn) {
    const stats = {};
    aggregated.forEach(item => {
        const key = keyFn(item);
        stats[key] = (stats[key] || 0) + item.count;
    });
    return stats;
}

function computeSigunguStats(aggregated) {
    return computeStatsBy(aggregated, sigunguKeyOf);
}

function computeDongStats(aggregated) {
    return computeStatsBy(aggregated, item => {
        if (!item.sggCd || !item.sggCd.startsWith('11')) return '기타'; // 경기도는 동 경계 데이터 없음
        const parts = item.address ? item.address.split(' ') : [];
        // "서울특별시 종로구 무악동 82" -> parts[1]=종로구, parts[2]=무악동
        return parts.length >= 3 ? `${parts[1]} ${parts[2]}` : '기타';
    });
}

function createChoroLayer(geojson, getKey, getLabel, extraTooltipClass) {
    const tooltipClass = extraTooltipClass ? `gu-tooltip ${extraTooltipClass}` : 'gu-tooltip';
    const group = L.geoJSON(geojson, {
        style: () => ({ color: '#fff', weight: 2, fillColor: '#dfe6e9', fillOpacity: 0.35 }),
        onEachFeature: (feature, layer) => {
            layer._statKey = getKey(feature);
            layer._labelName = getLabel(feature);
            layer.bindTooltip(
                `<span class="gu-name">${layer._labelName}</span><span class="gu-count">-<span class="gu-unit">건</span></span>`,
                { permanent: true, direction: 'center', className: tooltipClass, interactive: false }
            );
            layer.on('click', () => map.flyToBounds(layer.getBounds(), { padding: [20, 20] }));
            layer.on('mouseover', () => layer.setStyle({ weight: 3 }));
            layer.on('mouseout', () => layer.setStyle({ weight: 2 }));
        }
    });
    // hideEmpty로 개별 폴리곤을 껐다 켰다 하면 eachLayer로는 더 이상 안 잡히므로 따로 보관해둔다
    group._allLayers = [];
    group.eachLayer(featureLayer => group._allLayers.push(featureLayer));
    return group;
}

async function loadSigunguBoundaries() {
    const res = await fetch('./data/sigungu.geojson');
    const geojson = await res.json();
    geojson.features.forEach(f => {
        (f.properties.codes || []).forEach(code => { LAWD_TO_SIGUNGU[code] = f.properties.name; });
    });
    sigunguChoroLayer = createChoroLayer(geojson, f => f.properties.name, f => f.properties.name);
}

async function loadDongBoundaries() {
    const res = await fetch('./data/seoul_dong.geojson');
    const geojson = await res.json();
    dongChoroLayer = createChoroLayer(
        geojson,
        f => `${f.properties.gu} ${f.properties.EMD_KOR_NM}`,
        f => f.properties.EMD_KOR_NM,
        'dong-tooltip'
    );
}

function updateChoropleth(layer, stats, hideEmpty) {
    if (!layer) return;
    const values = Object.values(stats).filter(v => v > 0).sort((a, b) => a - b);
    const breaks = values.length
        ? [values[Math.floor(values.length / 3)], values[Math.floor(values.length * 2 / 3)] || values[values.length - 1]]
        : [1, 1];

    layer._allLayers.forEach(featureLayer => {
        const count = stats[featureLayer._statKey] || 0;

        if (hideEmpty && count <= 0) {
            if (layer.hasLayer(featureLayer)) layer.removeLayer(featureLayer);
            return;
        }
        if (!layer.hasLayer(featureLayer)) layer.addLayer(featureLayer);

        featureLayer.setStyle({ fillColor: choroColorScale(count, breaks), fillOpacity: count > 0 ? 0.65 : 0.35 });
        featureLayer.setTooltipContent(
            `<span class="gu-name">${featureLayer._labelName}</span><span class="gu-count">${count}<span class="gu-unit">건</span></span>`
        );
    });
}

function updateChoropleths() {
    updateChoropleth(sigunguChoroLayer, computeSigunguStats(aggregatedCurrentData), false);
    // 동은 개수가 많아 0건까지 표시하면 라벨이 겹치므로 데이터 있는 동만 보여준다
    updateChoropleth(dongChoroLayer, computeDongStats(aggregatedCurrentData), true);
}

function toggleMapLayer(layer, shouldShow) {
    if (!layer) return;
    const isShown = map.hasLayer(layer);
    if (shouldShow && !isShown) map.addLayer(layer);
    if (!shouldShow && isShown) map.removeLayer(layer);
}

function updateZoomLayers() {
    const zoom = map.getZoom();
    toggleMapLayer(sigunguChoroLayer, zoom < SIGUNGU_MAX_ZOOM);
    toggleMapLayer(dongChoroLayer, zoom >= SIGUNGU_MAX_ZOOM && zoom < DONG_MAX_ZOOM);
    map.getContainer().classList.toggle('map-hide-dong-name', zoom < DONG_NAME_MIN_ZOOM);

    // 서울은 동 단계를 거쳐 줌 15부터, 경기도는 동 경계가 없어 시군구 다음(줌 12)부터 바로 마커 표시
    Object.values(guClusterLayers).forEach(layer => {
        const markerMinZoom = layer._region === 'seoul' ? DONG_MAX_ZOOM : SIGUNGU_MAX_ZOOM;
        toggleMapLayer(layer, zoom >= markerMinZoom);
    });
}

map.on('zoomend', updateZoomLayers);

let guClusterLayers = {};

function createClusterGroup() {
    return L.markerClusterGroup({
        chunkedLoading: true,
        maxClusterRadius: 60,
        disableClusteringAtZoom: 18,
        iconCreateFunction: function(cluster) {
            const children = cluster.getAllChildMarkers();
            let total = 0;
            children.forEach(marker => {
                total += (marker.options.count || 0);
            });

            let c = 'custom-cluster-icon';
            let size = 40;
            if (total >= 50) { c += ' large'; size = 60; }
            else if (total >= 10) { c += ' medium'; size = 50; }

            return new L.DivIcon({
                html: `<div>${total}</div>`,
                className: c,
                iconSize: [size, size]
            });
        }
    });
}

// -------------------- 실거래가 / 토지거래허가 두 데이터셋 -------------------- //
let currentMode = 'trade'; // 'trade' | 'permit' - 어떤 데이터셋을 지도에 그릴지
let currentPeriod = '60';

let allTradeData = [];
let allPermitData = [];
let tradeLastUpdated = new Date();
let permitLastUpdated = new Date();
let tradeLastUpdatedText = '';
let permitLastUpdatedText = '';

let aggregatedTradeData = [];
let aggregatedPermitData = [];
let tradeByKey = {};   // 팝업에서 실거래/허가를 함께 보여주기 위한 좌표 -> 집계 레코드
let permitByKey = {};
let aggregatedCurrentData = []; // 현재 모드의 aggregatedTradeData/aggregatedPermitData

let globalMarkers = {};

let currentRankLimit = 10;
let currentTab = 'overall';
let selectedDistrict = null;

// 서울/카카오 API에서 오는 값을 그대로 innerHTML에 넣으면 XSS 위험이 있어 이스케이프한다
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

function buildDisplayName(item) {
    if (!item.aptNm) return item.place_name || '';
    const apt = item.aptNm.replace('아파트', '');
    const place = (item.place_name || '').replace('아파트', '');
    return apt === place ? item.aptNm : `${item.aptNm}(${item.place_name})`;
}

function activeAggregatedData() {
    return currentMode === 'trade' ? aggregatedTradeData : aggregatedPermitData;
}

async function loadDataset(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} 데이터 파일을 찾을 수 없습니다.`);
    const json = await res.json();
    const rawData = (json.data || []).map(item => ({ ...item, dateObj: parseDateString(item.date) }));
    return {
        rawData,
        lastUpdated: json.last_updated ? new Date(json.last_updated.replace(' ', 'T')) : new Date(),
        lastUpdatedText: json.last_updated || '',
    };
}

function updateLastUpdatedLabel() {
    const label = currentMode === 'trade'
        ? (tradeLastUpdatedText && `실거래가 업데이트: ${tradeLastUpdatedText}`)
        : (permitLastUpdatedText && `허가정보 업데이트: ${permitLastUpdatedText}`);
    document.getElementById('last-updated').innerText = label || '';
}

async function loadAllData() {
    const loadingEl = document.getElementById('loading');
    loadingEl.style.display = 'block';

    try {
        const [trade, permit] = await Promise.all([
            loadDataset('./data/trades.json'),
            loadDataset('./data/permits.json'),
        ]);

        allTradeData = trade.rawData;
        tradeLastUpdated = trade.lastUpdated;
        tradeLastUpdatedText = trade.lastUpdatedText;

        allPermitData = permit.rawData;
        permitLastUpdated = permit.lastUpdated;
        permitLastUpdatedText = permit.lastUpdatedText;

        updateLastUpdatedLabel();
        setPeriod('60', document.getElementById('btn60'));

    } catch (err) {
        console.error(err);
        alert('데이터 로드 실패: ' + err.message);
    } finally {
        loadingEl.style.display = 'none';
    }
}

function setMode(mode) {
    if (mode === currentMode) return;
    currentMode = mode;

    document.getElementById('modeTrade').classList.toggle('active', mode === 'trade');
    document.getElementById('modePermit').classList.toggle('active', mode === 'permit');
    selectedDistrict = null;

    updateLastUpdatedLabel();
    aggregatedCurrentData = activeAggregatedData();
    renderMarkers(aggregatedCurrentData);
    updateChoropleths();
    updateZoomLayers();

    if (document.getElementById('rankingPanel').style.display === 'flex') {
        currentRankLimit = 10;
        renderRankingContent();
    }
}

function toggleRankingPanel() {
    const panel = document.getElementById('rankingPanel');
    if (panel.style.display === 'flex') {
        panel.style.display = 'none';
    } else {
        panel.style.display = 'flex';
        renderRankingContent();
    }
}

function switchRankingTab(tabName) {
    currentTab = tabName;
    selectedDistrict = null;
    currentRankLimit = 10;

    document.querySelectorAll('.ranking-tab').forEach(el => el.classList.remove('active'));
    if(tabName === 'overall') {
        document.querySelectorAll('.ranking-tab')[0].classList.add('active');
    } else if(tabName === 'district1') {
        document.querySelectorAll('.ranking-tab')[1].classList.add('active');
    } else {
        document.querySelectorAll('.ranking-tab')[2].classList.add('active');
    }
    renderRankingContent();
}

function renderRankingContent() {
    const container = document.getElementById('rankingContent');
    container.innerHTML = '';

    if (currentTab === 'overall') {
        renderOverallRanking(container);
    } else {
        const sidoPrefix = currentTab === 'district1' ? '11' : '41';
        if (selectedDistrict) {
            renderDistrictDetail(container, selectedDistrict, sidoPrefix);
        } else {
            renderDistrictRanking(sidoPrefix, container);
        }
    }
}

function goToMarker(item) {
    const key = keyOf(item.lat, item.lng);
    const target = globalMarkers[key];

    if (target) {
        target.clusterGroup.zoomToShowLayer(target.marker, function() {
            target.marker.openPopup();
        });
    } else {
        map.flyTo([item.lat, item.lng], 17);
    }
}

function renderOverallRanking(container) {
    const sortedData = [...aggregatedCurrentData].sort((a, b) => b.count - a.count);
    const ul = document.createElement('ul');
    ul.className = 'rank-list';

    const limit = Math.min(currentRankLimit, sortedData.length);

    for (let i = 0; i < limit; i++) {
        const item = sortedData[i];
        const li = document.createElement('li');
        li.className = 'rank-item';
        li.onclick = () => {
            document.getElementById('rankingPanel').style.display = 'none';
            goToMarker(item);
        };

        const rankClass = (i < 3) ? 'top3' : '';
        li.innerHTML = `
            <span class="rank-num ${rankClass}">${i + 1}</span>
            <div class="rank-info">
                <span class="rank-name">${escapeHtml(buildDisplayName(item))}</span>
                <span class="rank-addr">${escapeHtml(item.address)}</span>
            </div>
            <span class="rank-count">${item.count}건</span>
        `;
        ul.appendChild(li);
    }
    container.appendChild(ul);

    if (sortedData.length > limit) {
        const moreBtn = document.createElement('button');
        moreBtn.className = 'load-more-btn';
        moreBtn.innerText = '더보기 👇';
        moreBtn.onclick = () => {
            currentRankLimit += 10;
            renderRankingContent();
        };
        container.appendChild(moreBtn);
    }
}

function renderDistrictRanking(sidoPrefix, container) {
    const stats = {};
    aggregatedCurrentData.forEach(item => {
        if (!item.sggCd || !item.sggCd.startsWith(sidoPrefix)) return;
        const key = sigunguKeyOf(item);
        stats[key] = (stats[key] || 0) + item.count;
    });

    const sortedKeys = Object.keys(stats).sort((a, b) => stats[b] - stats[a]);

    const ul = document.createElement('ul');
    ul.className = 'rank-list';

    sortedKeys.forEach((name, idx) => {
        const li = document.createElement('li');
        li.className = 'rank-item';
        li.onclick = () => {
            selectedDistrict = name;
            renderRankingContent();
        };

        const rankClass = (idx < 3) ? 'top3' : '';
        li.innerHTML = `
            <span class="rank-num ${rankClass}">${idx + 1}</span>
            <div class="rank-info">
                <span class="rank-name" style="font-size:16px;">${escapeHtml(name)}</span>
            </div>
            <span class="rank-count">${stats[name]}건</span>
            <i class="fa-solid fa-chevron-right" style="margin-left:10px; color:#ccc;"></i>
        `;
        ul.appendChild(li);
    });
    container.appendChild(ul);
}

function renderDistrictDetail(container, districtName, sidoPrefix) {
    const header = document.createElement('div');
    header.className = 'back-btn-area';
    header.innerHTML = `<i class="fa-solid fa-arrow-left" style="margin-right:5px;"></i> ${escapeHtml(districtName)} 전체 목록`;
    header.onclick = () => {
        selectedDistrict = null;
        renderRankingContent();
    };
    container.appendChild(header);

    const districtData = aggregatedCurrentData
        .filter(item => item.sggCd && item.sggCd.startsWith(sidoPrefix) && sigunguKeyOf(item) === districtName)
        .sort((a, b) => b.count - a.count);

    const ul = document.createElement('ul');
    ul.className = 'rank-list';

    districtData.forEach((item, idx) => {
        const li = document.createElement('li');
        li.className = 'rank-item';
        li.onclick = () => {
            document.getElementById('rankingPanel').style.display = 'none';
            goToMarker(item);
        };

        li.innerHTML = `
            <span class="rank-num">${idx + 1}</span>
            <div class="rank-info">
                <span class="rank-name">${escapeHtml(buildDisplayName(item))}</span>
                <span class="rank-addr">${escapeHtml(item.address)}</span>
            </div>
            <span class="rank-count">${item.count}건</span>
        `;
        ul.appendChild(li);
    });
    container.appendChild(ul);
}

function toggleSearchMode(isSearch) {
    const filterGroup = document.getElementById('filterGroup');
    const searchGroup = document.getElementById('searchGroup');
    const searchInput = document.getElementById('searchInput');
    const searchResults = document.getElementById('searchResults');

    if (isSearch) {
        filterGroup.style.display = 'none';
        searchGroup.style.display = 'flex';
        searchInput.focus();
    } else {
        searchGroup.style.display = 'none';
        filterGroup.style.display = 'flex';
        searchResults.style.display = 'none';
        searchInput.value = '';
    }
}

function filterByPeriod(data, referenceDate, period) {
    if (period === 'all') return data;
    const daysLimit = parseInt(period);
    return data.filter(item => {
        if (!item.dateObj) return false;
        const diff = getDaysDiff(referenceDate, item.dateObj);
        return diff >= 0 && diff <= daysLimit;
    });
}

function indexByKey(aggregated) {
    const map = {};
    aggregated.forEach(item => { map[keyOf(item.lat, item.lng)] = item; });
    return map;
}

function recomputeAggregates(period) {
    aggregatedTradeData = aggregateData(filterByPeriod(allTradeData, tradeLastUpdated, period));
    aggregatedPermitData = aggregateData(filterByPeriod(allPermitData, permitLastUpdated, period));
    tradeByKey = indexByKey(aggregatedTradeData);
    permitByKey = indexByKey(aggregatedPermitData);
}

function setPeriod(period, btn) {
    if (btn) {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    }

    currentPeriod = period;
    recomputeAggregates(period);
    aggregatedCurrentData = activeAggregatedData();
    renderMarkers(aggregatedCurrentData);
    updateChoropleths();
    updateZoomLayers();

    if(document.getElementById('rankingPanel').style.display === 'flex') {
        currentRankLimit = 10;
        renderRankingContent();
    }
}

function aggregateData(points) {
    const mapData = {};

    points.forEach(pt => {
        if (!pt.lat || !pt.lng) return;
        const key = keyOf(pt.lat, pt.lng);

        if (!mapData[key]) {
            mapData[key] = {
                lat: pt.lat, lng: pt.lng,
                address: pt.address, place_name: pt.place_name,
                aptNm: pt.aptNm, sggCd: pt.sggCd,
                count: 0, history: []
            };
        }
        mapData[key].count += 1;
        mapData[key].history.push(pt);
    });

    Object.values(mapData).forEach(item => {
        item.history.sort((a, b) => b.date.localeCompare(a.date));
    });
    return Object.values(mapData);
}

function buildPinIcon(pt) {
    const pinColor = pt.count >= 10 ? '#e74c3c' : (pt.count >= 3 ? '#f1c40f' : '#3498db');
    return L.divIcon({
        html: `
            <svg width="34" height="44" viewBox="0 0 34 44">
                <path d="M17 0C7.6 0 0 7.6 0 17c0 12.7 17 27 17 27s17-14.3 17-27C34 7.6 26.4 0 17 0z" fill="${pinColor}" stroke="white" stroke-width="2"/>
                <circle cx="17" cy="16" r="10.5" fill="white"/>
            </svg>
            <div class="pin-count">${pt.count}</div>
        `,
        className: 'pin-marker',
        iconSize: [34, 44],
        iconAnchor: [17, 42],
        popupAnchor: [0, -40]
    });
}

function buildTradeSection(trade) {
    const rows = trade.history.map(h => `
        <li class="trade-item">
            <span>${escapeHtml(h.excluUseAr)}</span>
            <span>${escapeHtml(h.floor)}층</span>
            <span>${formatToUk(h.dealAmount)}</span>
            <span class="trade-date">${formatDate(h.date)}</span>
        </li>
    `).join('');

    return `
        <div class="popup-section">
            <div class="popup-section-title"><i class="fa-solid fa-won-sign"></i> 실거래가 ${trade.count}건</div>
            <ul class="trade-list">
              <li class="trade-item">
                <span>전용면적</span>
                <span>층수</span>
                <span>가격</span>
                <span class="trade-date">계약일</span>
              </li>
              ${rows}</ul>
        </div>
    `;
}

function buildPermitSection(permit) {
    const rows = permit.history.map(h => `
        <li class="permit-item">
            <span>${escapeHtml(h.place_name)}</span>
            <span class="permit-date">${formatDate(h.date)}</span>
        </li>
    `).join('');

    return `
        <div class="popup-section">
            <div class="popup-section-title"><i class="fa-solid fa-stamp"></i> 토지거래허가 ${permit.count}건</div>
            <ul class="permit-list">${rows}</ul>
        </div>
    `;
}

// 선택된 기간(60/30/7일) x축 위에 실거래가는 꺾은선, 허가 건수는 막대로 겹쳐 보여준다.
function buildPriceChart(trade, permit) {
    const width = 274, height = 110;
    const padTop = 10, padBottom = 6, padX = 6;
    const chartTop = padTop, chartBottom = height - padBottom;

    const now = tradeLastUpdatedText ? tradeLastUpdated : permitLastUpdated;
    let startDate;
    if (currentPeriod === 'all') {
        const allDates = [
            ...(trade ? trade.history.map(h => parseDateString(h.date)) : []),
            ...(permit ? permit.history.map(h => parseDateString(h.date)) : []),
        ].filter(Boolean);
        startDate = allDates.length ? new Date(Math.min(...allDates)) : new Date(now.getTime() - 60 * 86400000);
    } else {
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - parseInt(currentPeriod));
    }

    const span = Math.max(1, now.getTime() - startDate.getTime());
    const xScale = (d) => padX + ((d.getTime() - startDate.getTime()) / span) * (width - padX * 2);

    const tradePoints = (trade ? trade.history : [])
        .map(h => ({ d: parseDateString(h.date), price: dealAmountToUk(h.dealAmount) }))
        .filter(p => p.d)
        .sort((a, b) => a.d - b.d);

    const permitByDay = {};
    (permit ? permit.history : []).forEach(h => {
        if (!parseDateString(h.date)) return;
        permitByDay[h.date] = (permitByDay[h.date] || 0) + 1;
    });
    const permitEntries = Object.entries(permitByDay).map(([dateStr, count]) => ({ d: parseDateString(dateStr), count }));

    if (!tradePoints.length && !permitEntries.length) return '';

    const maxPrice = Math.max(1, ...tradePoints.map(p => p.price));
    const yPrice = (price) => chartBottom - (price / maxPrice) * (chartBottom - chartTop);
    const maxPermitCount = Math.max(1, ...permitEntries.map(p => p.count));
    const barAreaHeight = (chartBottom - chartTop) * 0.55;
    const barWidth = 5;

    const bars = permitEntries.map(p => {
        const x = xScale(p.d);
        const barHeight = (p.count / maxPermitCount) * barAreaHeight;
        return `<rect x="${(x - barWidth / 2).toFixed(1)}" y="${(chartBottom - barHeight).toFixed(1)}" width="${barWidth}" height="${barHeight.toFixed(1)}" fill="#8e5cd9" opacity="0.45" rx="1.5" />`;
    }).join('');

    const linePath = tradePoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.d).toFixed(1)} ${yPrice(p.price).toFixed(1)}`).join(' ');
    const dots = tradePoints.map(p => `<circle cx="${xScale(p.d).toFixed(1)}" cy="${yPrice(p.price).toFixed(1)}" r="2.5" fill="#2c8ec9" />`).join('');

    const legendItems = [
        tradePoints.length ? '<span><i class="legend-dot legend-line"></i>실거래가</span>' : '',
        permitEntries.length ? '<span><i class="legend-dot legend-bar"></i>허가 건수</span>' : '',
    ].join('');

    return `
        <div class="popup-section">
            <div class="popup-section-title"><i class="fa-solid fa-chart-line"></i> 기간 내 변동 추이</div>
            <svg class="popup-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
                <line x1="${padX}" y1="${chartBottom}" x2="${width - padX}" y2="${chartBottom}" stroke="#eee" stroke-width="1" />
                ${bars}
                ${tradePoints.length > 1 ? `<path d="${linePath}" fill="none" stroke="#2c8ec9" stroke-width="2" />` : ''}
                ${dots}
            </svg>
            <div class="popup-chart-legend">${legendItems}</div>
        </div>
    `;
}

// 현재 모드와 상관없이, 같은 좌표에 실거래/허가 데이터가 둘 다 있으면 둘 다 보여준다.
function buildPopupContent(key) {
    const trade = tradeByKey[key];
    const permit = permitByKey[key];
    const titleSource = trade || permit;
    if (!titleSource) return '';

    const sections = [];
    const chart = buildPriceChart(trade, permit);
    if (chart) sections.push(chart);
    if (trade) sections.push(buildTradeSection(trade));
    if (permit) sections.push(buildPermitSection(permit));

    return `
        <div class="popup-header">
            <h3>${escapeHtml(buildDisplayName(titleSource))}</h3>
            <p>${escapeHtml(titleSource.address)}</p>
        </div>
        <div class="popup-body">${sections.join('')}</div>
    `;
}

// 필터(60/30/7일)나 모드 전환마다 클러스터/마커를 통째로 새로 만들지 않고,
// 이전에 그려둔 마커를 재사용해 사라진 것만 지우고 새로 생긴 것만 추가한다.
function renderMarkers(points) {
    const nextKeys = new Set();

    points.forEach(pt => {
        if (!pt.lat || !pt.lng) return;
        const key = keyOf(pt.lat, pt.lng);
        nextKeys.add(key);

        const guName = sigunguKeyOf(pt);
        if (!guClusterLayers[guName]) {
            guClusterLayers[guName] = createClusterGroup();
            guClusterLayers[guName]._region = pt.sggCd && pt.sggCd.startsWith('11') ? 'seoul' : 'gg';
            map.addLayer(guClusterLayers[guName]);
        }

        const existing = globalMarkers[key];
        if (existing) {
            existing.marker.setIcon(buildPinIcon(pt));
            existing.marker.options.count = pt.count;
            existing.marker.setPopupContent(buildPopupContent(key));
            return;
        }

        const marker = L.marker([pt.lat, pt.lng], {
            icon: buildPinIcon(pt),
            count: pt.count
        });
        marker.bindPopup(buildPopupContent(key));
        guClusterLayers[guName].addLayer(marker);
        globalMarkers[key] = { marker: marker, clusterGroup: guClusterLayers[guName] };
    });

    Object.keys(globalMarkers).forEach(key => {
        if (nextKeys.has(key)) return;
        const { marker, clusterGroup } = globalMarkers[key];
        clusterGroup.removeLayer(marker);
        delete globalMarkers[key];
    });
}

function activeRawData() {
    return currentMode === 'trade' ? allTradeData : allPermitData;
}

// -------------------- 초성 검색 -------------------- //
const CHOSUNG_LIST = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const CHOSUNG_SET = new Set(CHOSUNG_LIST);

function toChosung(str) {
    let result = '';
    for (const ch of str) {
        const code = ch.charCodeAt(0) - 0xAC00;
        result += (code >= 0 && code <= 11171) ? CHOSUNG_LIST[Math.floor(code / 588)] : ch;
    }
    return result;
}

function isChosungOnly(str) {
    return str.length > 0 && [...str].every(ch => CHOSUNG_SET.has(ch));
}

const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');

searchInput.addEventListener('input', function(e) {
    const query = e.target.value.trim();
    if (query.length < 2) {
        searchResults.style.display = 'none';
        return;
    }

    const keywords = query.trim().split(/\s+/);

    const rawMatches = activeRawData().filter(d => {
        const address = d.address || '';
        const placeName = d.place_name || '';
        const aptNm = d.aptNm || '';

        return keywords.every(kw => {
            if (isChosungOnly(kw)) {
                return toChosung(address).includes(kw) ||
                       toChosung(placeName).includes(kw) ||
                       toChosung(aptNm).includes(kw);
            }
            const lowerKw = kw.toLowerCase();
            return address.toLowerCase().includes(lowerKw) ||
                   placeName.toLowerCase().includes(lowerKw) ||
                   aptNm.toLowerCase().includes(lowerKw);
        });
    });

    const seenAddresses = new Set();
    const uniqueMatches = [];
    rawMatches.forEach(item => {
        const uniqueKey = item.address;
        if (!seenAddresses.has(uniqueKey)) {
            seenAddresses.add(uniqueKey);
            uniqueMatches.push(item);
        }
    });

    const finalResults = uniqueMatches.slice(0, 15);

    if (finalResults.length > 0) {
        searchResults.innerHTML = '';
        finalResults.forEach(item => {
            const div = document.createElement('div');
            div.className = 'search-item';
            div.innerHTML = `
                <span class="item-name">${escapeHtml(buildDisplayName(item))}</span>
                <span class="item-addr">${escapeHtml(item.address)}</span>
            `;
            div.addEventListener('click', () => moveToPoint(item.lat, item.lng));
            searchResults.appendChild(div);
        });
        searchResults.style.display = 'block';
    } else {
        searchResults.style.display = 'none';
    }
});

function moveToPoint(lat, lng) {
    setPeriod(currentPeriod, document.getElementById(`btn${currentPeriod}`));
    toggleSearchMode(false);

    const key = keyOf(lat, lng);
    const target = globalMarkers[key];

    if (target) {
        // 마커가 클러스터 내부에 있을 경우를 대비해 zoomToShowLayer 실행 후 openPopup 호출
        target.clusterGroup.zoomToShowLayer(target.marker, function() {
            target.marker.openPopup();
        });
    } else {
        // 필터링(예: 최근 60일) 조건에 의해 해당 위치에 생성된 마커가 없는 경우 지도 이동만 수행
        map.flyTo([lat, lng], 17, { duration: 1.5 });
    }
}

function parseDateString(dateStr) {
    if (!dateStr || dateStr.length !== 8) return null;
    const y = parseInt(dateStr.substring(0, 4));
    const m = parseInt(dateStr.substring(4, 6)) - 1;
    const d = parseInt(dateStr.substring(6, 8));
    return new Date(y, m, d);
}

function getDaysDiff(d1, d2) {
    const t1 = d1.getTime();
    const t2 = d2.getTime();
    return Math.floor((t1 - t2) / (24 * 60 * 60 * 1000));
}

function formatDate(str) {
    if(!str || str.length !== 8) return str;
    return `${str.substring(0,4)}.${str.substring(4,6)}.${str.substring(6,8)}`;
}

function dealAmountToUk(value) {
    const num = Number(value.toString().replace(/,/g, ''));
    return Number((num / 10000).toFixed(2));
}

function formatToUk(value) {
    return dealAmountToUk(value) + '억';
}

function moveToCurrentLocation() {
    map.locate({setView: true, maxZoom: 14});
}

map.on('locationfound', e => {
    gpsLayer.clearLayers();
    L.circle(e.latlng, { radius: e.accuracy / 2, color: '#2ecc71', fillColor: '#2ecc71', fillOpacity: 0.1 }).addTo(gpsLayer);
    L.circleMarker(e.latlng, { radius: 8, color: '#fff', fillColor: '#2ecc71', fillOpacity: 1 }).addTo(gpsLayer);
});

async function init() {
    // sggCd -> 시군구 이름 매핑이 준비된 뒤에 데이터를 그려야 마커가 올바른 그룹으로 묶인다
    await Promise.all([loadSigunguBoundaries(), loadDongBoundaries()]);
    await loadAllData();
}

init();
