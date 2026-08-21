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

// 줌 12 미만: 시군구 색칠 지도(서울+경기도 전부) / 12~15: 지역 단위 색칠 지도(서울은 동,
// 경기도는 동 경계 데이터가 없어 시군구를 계속 유지) / 15 이상: 서울·경기도 동일하게 개별 마커·클러스터.
// 마커 등장 줌을 두 지역 다 똑같이 맞춰서, 어느 지역이든 같은 축척에서 같은 종류의 화면이 보이게 한다.
const SIGUNGU_MAX_ZOOM = 12;
const MARKER_MIN_ZOOM = 15;
const DONG_COUNT_MIN_ZOOM = 14;
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

function updateChoropleth(layer, stats) {
    if (!layer) return;
    const values = Object.values(stats).filter(v => v > 0).sort((a, b) => a - b);
    const breaks = values.length
        ? [values[Math.floor(values.length / 3)], values[Math.floor(values.length * 2 / 3)] || values[values.length - 1]]
        : [1, 1];

    layer._allLayers.forEach(featureLayer => {
        const count = stats[featureLayer._statKey] || 0;
        if (!layer.hasLayer(featureLayer)) layer.addLayer(featureLayer);

        // 0건인 지역은 색 없이 경계선만 보여준다(마커 단계에서 테두리만 남길 때도 이 값을 씀).
        featureLayer._choroFillOpacity = count > 0 ? 0.65 : 0;
        featureLayer.setStyle({ fillColor: choroColorScale(count, breaks), fillOpacity: featureLayer._choroFillOpacity });
        featureLayer.setTooltipContent(
            `<span class="gu-name">${featureLayer._labelName}</span><span class="gu-count">${count}<span class="gu-unit">건</span></span>`
        );
        // 동은 개수가 많아 0건까지 이름표를 다 띄우면 서로 겹치므로, 0건이면 라벨만 숨긴다(경계선은 유지).
        const tooltip = featureLayer.getTooltip();
        if (tooltip) tooltip.setOpacity(count > 0 ? 1 : 0);
    });
}

function updateChoropleths() {
    updateChoropleth(sigunguChoroLayer, computeSigunguStats(aggregatedCurrentData));
    updateChoropleth(dongChoroLayer, computeDongStats(aggregatedCurrentData));
}

function toggleMapLayer(layer, shouldShow) {
    if (!layer) return;
    const isShown = map.hasLayer(layer);
    if (shouldShow && !isShown) map.addLayer(layer);
    if (!shouldShow && isShown) map.removeLayer(layer);
}

function toggleFeatureLayer(featureLayer, group, shouldShow) {
    const isShown = group.hasLayer(featureLayer);
    if (shouldShow && !isShown) group.addLayer(featureLayer);
    if (!shouldShow && isShown) group.removeLayer(featureLayer);
}

// 마커 단계(줌 >= MARKER_MIN_ZOOM)에서도 색칠은 빼고 구/동 경계선만 남겨서 보여준다.
function applyChoroFeatureStyle(featureLayer, isOutline) {
    featureLayer.setStyle({
        fillOpacity: isOutline ? 0 : (featureLayer._choroFillOpacity ?? 0.35),
        color: isOutline ? '#95a5a6' : '#fff',
        weight: isOutline ? 1.5 : 2,
    });
}

function updateZoomLayers() {
    const zoom = map.getZoom();
    const isMarkerTier = zoom >= MARKER_MIN_ZOOM;

    // 시군구 코로플레스: 서울은 줌 12부터 동 코로플레스로 넘어가며 숨고, 경기도는 동 경계
    // 데이터가 없어 계속 표시하되(마커 단계부터는 테두리만) - 같은 줌에서 지역별로 다르게
    // 보이지 않도록 한다.
    if (sigunguChoroLayer) {
        sigunguChoroLayer._allLayers.forEach(featureLayer => {
            const isSeoul = featureLayer.feature.properties.sido === '서울특별시';
            const shouldShow = isSeoul ? zoom < SIGUNGU_MAX_ZOOM : true;
            toggleFeatureLayer(featureLayer, sigunguChoroLayer, shouldShow);
            if (shouldShow) applyChoroFeatureStyle(featureLayer, isMarkerTier);
        });
        toggleMapLayer(sigunguChoroLayer, true);
    }

    toggleMapLayer(dongChoroLayer, zoom >= SIGUNGU_MAX_ZOOM);
    if (dongChoroLayer && zoom >= SIGUNGU_MAX_ZOOM) {
        dongChoroLayer._allLayers.forEach(featureLayer => applyChoroFeatureStyle(featureLayer, isMarkerTier));
    }

    map.getContainer().classList.toggle('map-hide-dong-count', zoom < DONG_COUNT_MIN_ZOOM);
    map.getContainer().classList.toggle('map-outline-mode', isMarkerTier);

    // 서울·경기도 둘 다 같은 줌부터 개별 마커/클러스터로 전환한다
    Object.values(guClusterLayers).forEach(layer => {
        toggleMapLayer(layer, isMarkerTier);
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

// 코로플레스 단계(마커 클러스터가 지도에서 빠진 상태)에서 검색/랭킹으로 위치 이동을 시도하면
// zoomToShowLayer가 지도에 붙어있지 않은 레이어에는 안 먹혀서 조용히 아무 일도 안 일어난다.
// 그래서 이동 전에 클러스터 레이어를 먼저 지도에 붙여둔다(최종 줌 결과는 zoomend가 다시 정리한다).
function focusMarker(lat, lng) {
    const key = keyOf(lat, lng);
    const target = globalMarkers[key];

    if (target) {
        if (!map.hasLayer(target.clusterGroup)) map.addLayer(target.clusterGroup);
        target.clusterGroup.zoomToShowLayer(target.marker, function() {
            target.marker.openPopup();
        });
    } else {
        map.flyTo([lat, lng], 17, { duration: 1.5 });
    }
}

function goToMarker(item) {
    focusMarker(item.lat, item.lng);
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

// 모드별로 색 계열을 다르게 줘서(파랑=실거래, 보라=허가) 토글과 시각적으로 이어지게 한다.
const PIN_COLORS = {
    trade: { low: '#4a90d9', mid: '#f5a623', high: '#e8555a' },
    permit: { low: '#8e5cd9', mid: '#f5a623', high: '#e8555a' },
};

function markerLabelText(pt) {
    return pt.aptNm || pt.place_name || '';
}

function buildPinIcon(pt) {
    const tier = pt.count >= 10 ? 'high' : (pt.count >= 3 ? 'mid' : 'low');
    const pinColor = (PIN_COLORS[currentMode] || PIN_COLORS.trade)[tier];
    const label = escapeHtml(markerLabelText(pt));

    return L.divIcon({
        html: `
            ${label ? `<div class="pin-label">${label}</div>` : ''}
            <svg width="32" height="40" viewBox="0 0 32 40">
                <path d="M9 19 L23 19 L16 38 Z" fill="${pinColor}"/>
                <circle cx="16" cy="14" r="12" fill="${pinColor}" stroke="#fff" stroke-width="2.5"/>
                <text x="16" y="18.5" text-anchor="middle" font-size="11" font-weight="800" fill="#fff">${pt.count}</text>
            </svg>
        `,
        className: 'pin-marker',
        iconSize: [32, 40],
        iconAnchor: [16, 38],
        popupAnchor: [0, -36]
    });
}

// 실거래/허가 이력을 종류 구분 없이 계약일(발생일) 내림차순 한 목록으로 합친다.
function buildCombinedHistorySection(trade, permit) {
    const rows = [
        ...(trade ? trade.history.map(h => ({ type: 'trade', date: h.date, h })) : []),
        ...(permit ? permit.history.map(h => ({ type: 'permit', date: h.date, h })) : []),
    ].sort((a, b) => b.date.localeCompare(a.date));

    if (!rows.length) return '';

    const rowsHtml = rows.map(r => {
        if (r.type === 'trade') {
            return `
                <li class="history-item">
                    <span class="history-icon history-icon-trade"><i class="fa-solid fa-won-sign"></i></span>
                    <span class="history-detail">${escapeHtml(r.h.excluUseAr)}㎡ · ${escapeHtml(r.h.floor)}층 · ${formatToUk(r.h.dealAmount)}</span>
                    <span class="history-date">${formatDate(r.date)}</span>
                </li>`;
        }
        return `
            <li class="history-item">
                <span class="history-icon history-icon-permit"><i class="fa-solid fa-stamp"></i></span>
                <span class="history-detail">토지거래허가</span>
                <span class="history-date">${formatDate(r.date)}</span>
            </li>`;
    }).join('');

    const totalCount = (trade ? trade.count : 0) + (permit ? permit.count : 0);

    return `
        <div class="popup-section">
            <div class="popup-section-title"><i class="fa-solid fa-list"></i> 전체 내역 ${totalCount}건</div>
            <ul class="history-list">${rowsHtml}</ul>
        </div>
    `;
}

// 선택된 기간(60/30/7일) x축 위에 실거래가는 꺾은선, 허가 건수는 막대로 겹쳐 보여준다.
const AREA_LINE_COLORS = ['#2c8ec9', '#e8555a', '#27ae60', '#f5a623', '#8e5cd9', '#16a2b8', '#d35400'];

function groupTradePointsByArea(history) {
    const groups = {};
    history.forEach(h => {
        const d = parseDateString(h.date);
        if (!d) return;
        const area = h.excluUseAr || '기타';
        (groups[area] = groups[area] || []).push({ d, price: dealAmountToUk(h.dealAmount) });
    });
    return Object.keys(groups)
        .sort((a, b) => parseFloat(a) - parseFloat(b))
        .map(area => ({ area, points: groups[area].sort((a, b) => a.d - b.d) }));
}

function buildMonthTicks(startDate, endDate) {
    const ticks = [];
    const cur = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    while (cur <= endDate) {
        if (cur >= startDate) ticks.push(new Date(cur));
        cur.setMonth(cur.getMonth() + 1);
    }
    return ticks.length ? ticks : [new Date(startDate)];
}

function buildPriceChart(trade, permit) {
    const width = 290, height = 128;
    const padLeft = 24, padRight = 24, padTop = 8, padBottom = 14;
    const chartLeft = padLeft, chartRight = width - padRight;
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
    const xScale = (d) => chartLeft + ((d.getTime() - startDate.getTime()) / span) * (chartRight - chartLeft);

    const areaGroups = trade ? groupTradePointsByArea(trade.history) : [];
    const allTradePoints = areaGroups.flatMap(g => g.points);

    const permitByDay = {};
    (permit ? permit.history : []).forEach(h => {
        if (!parseDateString(h.date)) return;
        permitByDay[h.date] = (permitByDay[h.date] || 0) + 1;
    });
    const permitEntries = Object.entries(permitByDay).map(([dateStr, count]) => ({ d: parseDateString(dateStr), count }));

    if (!allTradePoints.length && !permitEntries.length) return '';

    // 가격은 0원부터가 아니라 이 기간·이 단지의 실제 최저가부터 시작하고, 위아래 다 살짝
    // 여유를 둬서 선이 그래프 꽉 채우듯 위/아래에 딱 붙지 않게 한다.
    const rawMinPrice = allTradePoints.length ? Math.min(...allTradePoints.map(p => p.price)) : 0;
    const rawMaxPrice = allTradePoints.length ? Math.max(...allTradePoints.map(p => p.price)) : 1;
    const priceRange = rawMaxPrice - rawMinPrice;
    const pricePadding = priceRange > 0 ? priceRange * 0.15 : Math.max(rawMaxPrice * 0.1, 0.1);
    const minPrice = Math.max(0, rawMinPrice - pricePadding);
    const maxPrice = rawMaxPrice + pricePadding;
    const priceSpan = Math.max(0.01, maxPrice - minPrice);
    const yPrice = (price) => chartBottom - ((price - minPrice) / priceSpan) * (chartBottom - chartTop);

    // 허가 건수도 실제 최고 건수를 축의 끝에 딱 맞추지 않고 1건 정도 여유를 둔다(막대가 항상
    // 맨 위보다 낮게 그려진다).
    const rawMaxPermitCount = Math.max(0, ...permitEntries.map(p => p.count));
    const maxPermitCount = rawMaxPermitCount + 1;
    const yCount = (count) => chartBottom - (count / maxPermitCount) * (chartBottom - chartTop);
    const barWidth = 5;

    // 가로 기준선 3단: 각 단지/마커의 실제 가격·건수 범위에 맞춰 매번 새로 계산한다(고정 눈금 아님)
    const gridLines = [0, 0.5, 1].map(frac => {
        const y = chartBottom - frac * (chartBottom - chartTop);
        return { y, price: Math.round(minPrice + frac * priceSpan), count: Math.round(frac * maxPermitCount) };
    });
    const gridHtml = gridLines.map(g => `
        <line x1="${chartLeft}" y1="${g.y.toFixed(1)}" x2="${chartRight}" y2="${g.y.toFixed(1)}" stroke="#eee" stroke-width="1" />
        <text x="${chartLeft - 4}" y="${(g.y + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="#999">${g.price}억</text>
        <text x="${chartRight + 4}" y="${(g.y + 3).toFixed(1)}" text-anchor="start" font-size="8" fill="#999">${g.count}건</text>
    `).join('');

    const monthTicks = buildMonthTicks(startDate, now);
    const monthHtml = monthTicks.map(t => `
        <text x="${xScale(t).toFixed(1)}" y="${height - 2}" text-anchor="middle" font-size="8" fill="#999">${t.getMonth() + 1}월</text>
    `).join('');

    const bars = permitEntries.map(p => {
        const x = xScale(p.d);
        const barTop = yCount(p.count);
        return `<rect x="${(x - barWidth / 2).toFixed(1)}" y="${barTop.toFixed(1)}" width="${barWidth}" height="${(chartBottom - barTop).toFixed(1)}" fill="#8e5cd9" opacity="0.4" rx="1.5" />`;
    }).join('');

    const lineGroups = areaGroups.map((group, i) => {
        const color = AREA_LINE_COLORS[i % AREA_LINE_COLORS.length];
        const path = group.points.map((p, j) => `${j === 0 ? 'M' : 'L'} ${xScale(p.d).toFixed(1)} ${yPrice(p.price).toFixed(1)}`).join(' ');
        const dots = group.points.map(p => `<circle cx="${xScale(p.d).toFixed(1)}" cy="${yPrice(p.price).toFixed(1)}" r="2.5" fill="${color}" />`).join('');
        const line = group.points.length > 1 ? `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" />` : '';
        return { color, line, dots };
    });

    const legendItems = [
        ...areaGroups.map((g, i) => `<span><i class="legend-dot" style="background:${AREA_LINE_COLORS[i % AREA_LINE_COLORS.length]}"></i>${escapeHtml(g.area)}㎡</span>`),
        permitEntries.length ? '<span><i class="legend-dot legend-bar"></i>허가 건수</span>' : '',
    ].join('');

    return `
        <div class="popup-section">
            <div class="popup-section-title"><i class="fa-solid fa-chart-line"></i> 기간 내 변동 추이</div>
            <svg class="popup-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
                ${gridHtml}
                ${bars}
                ${lineGroups.map(g => g.line).join('')}
                ${lineGroups.map(g => g.dots).join('')}
                ${monthHtml}
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
    const history = buildCombinedHistorySection(trade, permit);
    if (history) sections.push(history);

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
    focusMarker(lat, lng);
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
