import os
import asyncio
import sys
import json
import math
import aiohttp
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import date, timedelta, datetime, timezone

# 1. 설정
KAKAO_API_KEY = os.getenv('KAKAO_API_KEY')
# data.go.kr는 보통 이미 URL 인코딩된("Encoding") 서비스키를 나눠주는데, aiohttp의 params=는
# 값을 다시 인코딩하기 때문에 그대로 쓰면 이중 인코딩으로 키가 깨진다(403/429 원인).
# unquote는 인코딩 안 된 키("Decoding" 형태)를 줘도 안전한 무연산이라 양쪽 다 대응된다.
_raw_datagokr_key = os.getenv('DATAGOKR_API_KEY')
DATAGOKR_API_KEY = urllib.parse.unquote(_raw_datagokr_key) if _raw_datagokr_key else None
CACHE_FILE_PATH = 'data/address_cache.json'
# 허가 크롤러가 구별로 조회 가능한 최대 기간을 매번 처음부터 탐색하지 않도록,
# 지난 실행에서 통했던 기간을 저장해둔다. 실제 허가/실거래 데이터는 여기 없다 -
# "어느 정도 기간을 조회해야 하는지"에 대한 탐색 파라미터만 캐시한다.
PERMIT_WINDOW_CACHE_PATH = 'data/permit_window_cache.json'
TRADE_DATA_FILE_PATH = 'data/trades.json'
PERMIT_DATA_FILE_PATH = 'data/permits.json'
APT_TRADE_URL = "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade"
KAKAO_KEYWORD_SEARCH_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json'
# SEOUL_CONTRACT_URL 시크릿이 설정되어 있으면 그걸 우선 사용한다 (엔드포인트가 바뀔 경우 대비)
PERMIT_CONTRACT_LIST_URL = os.getenv('SEOUL_CONTRACT_URL') or 'https://land.seoul.go.kr/land/wsklis/getContractList.do'

# 구가 있는 시(수원/성남/안양/부천/안산/고양/용인/화성)는 실거래가 항상 구 코드로 등록되고
# 상위 시 코드로는 조회되지 않아 상위 코드는 뺐다.
# 서울(11로 시작) 구간은 토지거래허가 크롤러도 그대로 재사용한다.
LAWD_CD = [
    {'code': '11110', 'kor_name': '서울특별시 종로구'}, {'code': '11140', 'kor_name': '서울특별시 중구'},
    {'code': '11170', 'kor_name': '서울특별시 용산구'}, {'code': '11200', 'kor_name': '서울특별시 성동구'},
    {'code': '11215', 'kor_name': '서울특별시 광진구'}, {'code': '11230', 'kor_name': '서울특별시 동대문구'},
    {'code': '11260', 'kor_name': '서울특별시 중랑구'}, {'code': '11290', 'kor_name': '서울특별시 성북구'},
    {'code': '11305', 'kor_name': '서울특별시 강북구'}, {'code': '11320', 'kor_name': '서울특별시 도봉구'},
    {'code': '11350', 'kor_name': '서울특별시 노원구'}, {'code': '11380', 'kor_name': '서울특별시 은평구'},
    {'code': '11410', 'kor_name': '서울특별시 서대문구'}, {'code': '11440', 'kor_name': '서울특별시 마포구'},
    {'code': '11470', 'kor_name': '서울특별시 양천구'}, {'code': '11500', 'kor_name': '서울특별시 강서구'},
    {'code': '11530', 'kor_name': '서울특별시 구로구'}, {'code': '11545', 'kor_name': '서울특별시 금천구'},
    {'code': '11560', 'kor_name': '서울특별시 영등포구'}, {'code': '11590', 'kor_name': '서울특별시 동작구'},
    {'code': '11620', 'kor_name': '서울특별시 관악구'}, {'code': '11650', 'kor_name': '서울특별시 서초구'},
    {'code': '11680', 'kor_name': '서울특별시 강남구'}, {'code': '11710', 'kor_name': '서울특별시 송파구'},
    {'code': '11740', 'kor_name': '서울특별시 강동구'},
    {'code': '41111', 'kor_name': '경기도 수원시 장안구'}, {'code': '41113', 'kor_name': '경기도 수원시 권선구'},
    {'code': '41115', 'kor_name': '경기도 수원시 팔달구'}, {'code': '41117', 'kor_name': '경기도 수원시 영통구'},
    {'code': '41131', 'kor_name': '경기도 성남시 수정구'}, {'code': '41133', 'kor_name': '경기도 성남시 중원구'},
    {'code': '41135', 'kor_name': '경기도 성남시 분당구'}, {'code': '41150', 'kor_name': '경기도 의정부시'},
    {'code': '41171', 'kor_name': '경기도 안양시 만안구'}, {'code': '41173', 'kor_name': '경기도 안양시 동안구'},
    {'code': '41192', 'kor_name': '경기도 부천시 원미구'}, {'code': '41194', 'kor_name': '경기도 부천시 소사구'},
    {'code': '41196', 'kor_name': '경기도 부천시 오정구'}, {'code': '41210', 'kor_name': '경기도 광명시'},
    {'code': '41220', 'kor_name': '경기도 평택시'}, {'code': '41250', 'kor_name': '경기도 동두천시'},
    {'code': '41271', 'kor_name': '경기도 안산시 상록구'}, {'code': '41273', 'kor_name': '경기도 안산시 단원구'},
    {'code': '41281', 'kor_name': '경기도 고양시 덕양구'}, {'code': '41285', 'kor_name': '경기도 고양시 일산동구'},
    {'code': '41287', 'kor_name': '경기도 고양시 일산서구'}, {'code': '41290', 'kor_name': '경기도 과천시'},
    {'code': '41310', 'kor_name': '경기도 구리시'}, {'code': '41360', 'kor_name': '경기도 남양주시'},
    {'code': '41370', 'kor_name': '경기도 오산시'}, {'code': '41390', 'kor_name': '경기도 시흥시'},
    {'code': '41410', 'kor_name': '경기도 군포시'}, {'code': '41430', 'kor_name': '경기도 의왕시'},
    {'code': '41450', 'kor_name': '경기도 하남시'}, {'code': '41461', 'kor_name': '경기도 용인시 처인구'},
    {'code': '41463', 'kor_name': '경기도 용인시 기흥구'}, {'code': '41465', 'kor_name': '경기도 용인시 수지구'},
    {'code': '41480', 'kor_name': '경기도 파주시'}, {'code': '41500', 'kor_name': '경기도 이천시'},
    {'code': '41550', 'kor_name': '경기도 안성시'}, {'code': '41570', 'kor_name': '경기도 김포시'},
    {'code': '41591', 'kor_name': '경기도 화성시 만세구'}, {'code': '41593', 'kor_name': '경기도 화성시 효행구'},
    {'code': '41595', 'kor_name': '경기도 화성시 병점구'}, {'code': '41597', 'kor_name': '경기도 화성시 동탄구'},
    {'code': '41610', 'kor_name': '경기도 광주시'}, {'code': '41630', 'kor_name': '경기도 양주시'},
    {'code': '41650', 'kor_name': '경기도 포천시'}, {'code': '41670', 'kor_name': '경기도 여주시'},
    {'code': '41800', 'kor_name': '경기도 연천군'}, {'code': '41820', 'kor_name': '경기도 가평군'},
    {'code': '41830', 'kor_name': '경기도 양평군'},
]
SEOUL_DISTRICTS = [d for d in LAWD_CD if d['code'].startswith('11')]

REQUEST_TIMEOUT_SECONDS = 15
PAGE_CONCURRENCY = 3      # 국토부 실거래가 API 페이지네이션 동시 요청 수
GEOCODE_CONCURRENCY = 8   # 카카오 지오코딩 API 동시 요청 수 (두 크롤러가 공유)
# 실제 실행에서 72개 구를 다 돌면 뒷부분(특히 경기도)에서 429(요청 과다)가 나는 걸 확인해서
# 재시도로 흡수한다. 백오프 시간은 1초, 2초, 4초로 늘어난다.
RATE_LIMIT_MAX_RETRIES = 5
RATE_LIMIT_BACKOFF_BASE = 2

# 토지거래허가는 구별/날짜별로 조회 가능한 최대 기간이 달라서(초과 시 에러 응답) 탐색으로 찾는다.
# 90일에서 10일 단위로 좁혀가며 첫 성공 지점을 찾고, 거기서 1일 단위로 넓혀가며
# 실제 최대 허용 기간을 찾는다. (프론트 90일 필터와 맞춤. 실거래는 이미 3개월치를 받아오고 있어
# 그대로 두고, 허가만 60일로 묶여 있어서 여기를 늘렸다.)
PERMIT_INITIAL_LOOKBACK_DAYS = 90
PERMIT_COARSE_STEP_DAYS = 10
PERMIT_FINE_STEP_DAYS = 1


# -------------------- HTTP 요청 (공용) -------------------- #
async def fetch_post(session, url, data=None, json_body=None, headers=None, max_retries=RATE_LIMIT_MAX_RETRIES):
    kwargs = {}
    if headers:
        kwargs["headers"] = headers
    if json_body is not None:
        kwargs["json"] = json_body
    elif data is not None:
        kwargs["data"] = data

    for attempt in range(max_retries + 1):
        try:
            async with session.post(url, **kwargs) as response:
                if response.status != 200:
                    if attempt < max_retries:
                        wait = RATE_LIMIT_BACKOFF_BASE * (2 ** attempt)
                        print(f"[재시도] {url} 상태 코드 {response.status}, {wait}초 후 재시도 ({attempt + 1}/{max_retries})")
                        await asyncio.sleep(wait)
                        continue
                    print(f"[오류] {url} 통신 실패 (상태 코드: {response.status})")
                    return None
                return await response.text()
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            if attempt < max_retries:
                wait = RATE_LIMIT_BACKOFF_BASE * (2 ** attempt)
                print(f"[재시도] {url} 요청 실패({e!r}), {wait}초 후 재시도 ({attempt + 1}/{max_retries})")
                await asyncio.sleep(wait)
                continue
            print(f"[오류] {url} 요청 실패({e!r}) 재시도 초과")
            return None


# -------------------- 캐시 파일 입출력 (공용, 딕셔너리 형태 캐시는 전부 이 형식) -------------------- #
def load_json_cache(path):
    if not os.path.exists(path):
        print(f"기존 캐시 파일 없음 ({path}). 새로 시작합니다.")
        return {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            cache = json.load(f)
        print(f"기존 캐시 로드 완료 ({path}): {len(cache)}개")
        return cache
    except (json.JSONDecodeError, OSError) as e:
        print(f"캐시 파일 로드 실패 ({path}, 새로 시작): {e}")
        return {}


def save_json_cache(path, cache):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)
    print(f"캐시 파일 저장 완료: {path} ({len(cache)}개)")


def save_data(path, data, extra=None):
    if not data and os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                existing = json.load(f)
        except (json.JSONDecodeError, OSError):
            existing = {}
        if existing.get('data'):
            print(f"[경고] {path}: 이번 수집 결과가 0건이라 기존 데이터({len(existing['data'])}건)를 덮어쓰지 않고 유지합니다.")
            return

    last_updated = (datetime.now(timezone.utc) + timedelta(hours=9)).strftime("%Y-%m-%d %H:%M:%S")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    output = {"last_updated": last_updated, "data": data}
    if extra:
        output.update(extra)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"저장 완료 ({path}): {last_updated}, {len(data)}건")


# -------------------- 카카오 좌표 변환 (실거래/허가 공용, 캐시 공유) -------------------- #
def pick_best_document(documents):
    for keyword in ('아파트', '주거시설', '부동산'):
        matches = [doc for doc in documents if keyword in doc['category_name']]
        if matches:
            return matches[0]
    return documents[0] if documents else None


async def get_lat_lon(session, address, cache):
    if address in cache:
        return cache[address]

    headers = {'Authorization': f'KakaoAK {KAKAO_API_KEY}'}
    result = await fetch_post(session, KAKAO_KEYWORD_SEARCH_URL, data={'query': address}, headers=headers)
    if result is None:
        # 네트워크 오류는 캐시하지 않아 다음 실행에서 재시도되게 한다.
        return None, None, None

    try:
        data = json.loads(result)
        doc = pick_best_document(data['documents'])
    except (json.JSONDecodeError, KeyError) as e:
        print(f"지오코딩 응답 파싱 실패 ({address}): {e}")
        return None, None, None

    # 정상 응답인데 매칭되는 장소가 없는 경우만 (None, None, None)으로 캐시한다.
    result_tuple = (doc.get('place_name'), doc['y'], doc['x']) if doc else (None, None, None)
    cache[address] = result_tuple
    return result_tuple


async def geocode_unique_addresses(session, addresses, cache, stats, semaphore):
    """주소 목록을 중복 없이 지오코딩해 {주소: (place_name, lat, lng)} 딕셔너리로 반환한다."""
    unique_addresses = list(dict.fromkeys(addresses))
    for address in unique_addresses:
        if address in cache:
            stats["cache_hit"] += 1
        else:
            stats["api_call"] += 1

    async def geocode_one(address):
        async with semaphore:
            return address, await get_lat_lon(session, address, cache)

    return dict(await asyncio.gather(*(geocode_one(a) for a in unique_addresses)))


# ==================== 실거래가 (국토부 RTMS) ==================== #
def parse_xml_items(xml_text):
    """API 응답 XML에서 item 목록을 파싱한다. API 자체 오류 응답이면 ValueError를 낸다."""
    root = ET.fromstring(xml_text)
    result_code = root.find('.//resultCode')
    if result_code is not None and result_code.text != '000':
        result_msg = root.find('.//resultMsg')
        raise ValueError(result_msg.text if result_msg is not None else '알 수 없는 API 오류')

    items = [
        {child.tag: (child.text.strip() if child.text else "") for child in item}
        for item in root.findall('.//item')
    ]
    return root, items


async def fetch_page(session, semaphore, url, params, max_retries=RATE_LIMIT_MAX_RETRIES):
    async with semaphore:
        text = None
        for attempt in range(max_retries + 1):
            try:
                async with session.get(url, params=params) as response:
                    if response.status == 429:
                        if attempt < max_retries:
                            wait = RATE_LIMIT_BACKOFF_BASE * (2 ** attempt)
                            print(f"[재시도] {params['pageNo']}페이지 429(요청 과다), {wait}초 후 재시도 ({attempt + 1}/{max_retries})")
                            await asyncio.sleep(wait)
                            continue
                        print(f"[오류] {params['pageNo']}페이지 429(요청 과다) 재시도 초과")
                        return None, []
                    if response.status != 200:
                        print(f"[오류] {params['pageNo']}페이지 통신 실패 (상태 코드: {response.status})")
                        return None, []
                    text = await response.text()
                    break
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                if attempt < max_retries:
                    wait = RATE_LIMIT_BACKOFF_BASE * (2 ** attempt)
                    print(f"[재시도] {params['pageNo']}페이지 요청 실패({e!r}), {wait}초 후 재시도 ({attempt + 1}/{max_retries})")
                    await asyncio.sleep(wait)
                    continue
                print(f"[오류] {params['pageNo']}페이지 요청 실패({e!r}) 재시도 초과")
                return None, []

    try:
        return parse_xml_items(text)
    except (ET.ParseError, ValueError) as e:
        print(f"[오류] {params['pageNo']}페이지 파싱 실패: {e}")
        return None, []


async def fetch_all_apt_trade_data(session, semaphore, api_key, lawd_cd, deal_ymd, num_of_rows=1000):
    base_params = {
        "serviceKey": api_key,
        "LAWD_CD": lawd_cd,
        "DEAL_YMD": deal_ymd,
        "numOfRows": str(num_of_rows),
    }

    first_root, first_items = await fetch_page(session, semaphore, APT_TRADE_URL, {**base_params, "pageNo": "1"})
    if first_root is None:
        return []

    total_count_element = first_root.find('.//totalCount')
    if total_count_element is None:
        print(f"[알림] {lawd_cd} {deal_ymd}: 데이터를 찾을 수 없거나 API 응답이 올바르지 않습니다.")
        return first_items

    total_pages = math.ceil(int(total_count_element.text) / num_of_rows)
    tasks = [
        fetch_page(session, semaphore, APT_TRADE_URL, {**base_params, "pageNo": str(page)})
        for page in range(2, total_pages + 1)
    ]

    all_items = list(first_items)
    if tasks:
        for _, page_items in await asyncio.gather(*tasks):
            all_items.extend(page_items)

    print(f"[완료] {lawd_cd}, {deal_ymd}, {len(all_items)}개의 데이터를 성공적으로 수집했습니다.")
    return all_items


def target_deal_months(today):
    last_month_end = today.replace(day=1) - timedelta(days=1)
    two_months_ago_end = last_month_end.replace(day=1) - timedelta(days=1)
    return [today.strftime("%Y%m"), last_month_end.strftime("%Y%m"), two_months_ago_end.strftime("%Y%m")]


async def geocode_trade_records(session, records, cache, stats, semaphore):
    resolved = await geocode_unique_addresses(session, (r["ADDRESS"] for r in records), cache, stats, semaphore)

    geocoded = []
    for record in records:
        place_name, lat, lng = resolved[record["ADDRESS"]]
        if lat and lng:
            geocoded.append({
                "address": record["ADDRESS"],
                "place_name": record["aptNm"] if place_name is None else place_name,
                "aptNm": record["aptNm"],
                "lat": lat,
                "lng": lng,
                "date": f"{record['dealYear']}{record['dealMonth'].zfill(2)}{record['dealDay'].zfill(2)}",
                "sggCd": record["sggCd"],
                "excluUseAr": record["excluUseAr"],
                "dealingGbn": record["dealingGbn"],
                "floor": record["floor"],
                "dealAmount": record["dealAmount"],
            })
    return geocoded


async def process_district_trade(session, district, target_months, page_semaphore, geocode_semaphore, cache, stats):
    month_results = await asyncio.gather(*(
        fetch_all_apt_trade_data(session, page_semaphore, DATAGOKR_API_KEY, district["code"], deal_ymd)
        for deal_ymd in target_months
    ))
    records = [item for page_items in month_results for item in page_items]

    for record in records:
        record["ADDRESS"] = f"{district['kor_name']} {record['umdNm']} {record['jibun']}"
        record["sggCd"] = district["code"]

    return await geocode_trade_records(session, records, cache, stats, geocode_semaphore)


async def crawl_trades(session, page_semaphore, geocode_semaphore, cache, stats):
    target_months = target_deal_months(date.today())
    data = []
    for district in LAWD_CD:
        # 한 구의 응답이 예상과 다른 형태(필드 누락 등)여도 나머지 구 수집은 계속되게 한다.
        try:
            geocoded = await process_district_trade(
                session, district, target_months, page_semaphore, geocode_semaphore, cache, stats
            )
        except (KeyError, ValueError, TypeError, aiohttp.ClientError, asyncio.TimeoutError) as e:
            print(f"[오류] {district['code']} {district['kor_name']} 실거래 처리 실패, 건너뜀: {e}")
            continue

        data.extend(geocoded)
        print(f"[{district['code']}] {district['kor_name']} 실거래 {len(geocoded)}건")
    return data


# ==================== 토지거래허가 (서울시, 서울만 해당) ==================== #
async def _try_fetch_permits(session, district, today, lookback_days):
    """지정한 조회기간으로 1회 시도. 실패/에러/빈 결과면 None."""
    begin_date = (today - timedelta(days=lookback_days)).strftime("%Y%m%d")
    end_date = today.strftime("%Y%m%d")
    payload = {"sggCd": district["code"], "beginDate": begin_date, "endDate": end_date}

    result = await fetch_post(session, PERMIT_CONTRACT_LIST_URL, data=payload)
    if result is None:
        return None

    try:
        content = json.loads(result)
    except json.JSONDecodeError as e:
        print(f"{district['code']} {district['kor_name']} {lookback_days}일 응답 파싱 실패: {e}")
        return None

    return content.get("result") or None


async def find_widest_successful_window(attempt, initial_days, coarse_step, fine_step=PERMIT_FINE_STEP_DAYS):
    """attempt(days) -> 성공 시 결과, 실패 시 None을 반환하는 콜백.

    굵은 단위(coarse_step)로 좁혀가며 처음 성공하는 지점을 찾은 뒤,
    그 지점에서 1일 단위로 넓혀가며 실제로 성공하는 가장 넓은 기간을 찾는다.
    (지역구/날짜마다 허용되는 최대 조회기간이 달라서 상수로 고정할 수 없다.)
    """
    coarse_days = initial_days
    result = None
    while coarse_days > 0:
        result = await attempt(coarse_days)
        if result is not None:
            break
        coarse_days -= coarse_step

    if result is None:
        return 0, None

    best_days, best_result = coarse_days, result
    for fine_days in range(coarse_days + fine_step, min(coarse_days + coarse_step, initial_days), fine_step):
        candidate = await attempt(fine_days)
        if candidate is None:
            break
        best_days, best_result = fine_days, candidate

    return best_days, best_result


async def fetch_district_permits(session, district, today, window_cache):
    """조회 가능한 최대 기간을 찾는다. 하루 3회씩 매번 15번 안팎으로 탐색하는 대신,
    지난 실행에서 통했던 기간(window_cache)을 먼저 시도한다 - 이건 데이터가 아니라
    "탐색 파라미터"라 캐시해도 결과 데이터의 실시간성에는 영향이 없다.
    """
    async def attempt(lookback_days):
        result = await _try_fetch_permits(session, district, today, lookback_days)
        if result is None:
            print(f"{district['code']} {district['kor_name']} {lookback_days}일 로드 실패")
        return result

    cached_days = window_cache.get(district['code'])
    if cached_days:
        cached_result = await attempt(cached_days)
        if cached_result is not None:
            # 하루 지날 때마다 실제 허용 범위가 넓어질 수 있어 1일만 더 넓혀서 확인해본다.
            wider_days = min(cached_days + 1, PERMIT_INITIAL_LOOKBACK_DAYS)
            wider_result = await attempt(wider_days) if wider_days > cached_days else None
            if wider_result is not None:
                window_cache[district['code']] = wider_days
                print(f"{district['code']} {district['kor_name']} 캐시된 조회기간 +1일 확인: {wider_days}일")
                return wider_result
            window_cache[district['code']] = cached_days
            print(f"{district['code']} {district['kor_name']} 캐시된 조회기간 재사용: {cached_days}일")
            return cached_result
        print(f"{district['code']} {district['kor_name']} 캐시된 조회기간({cached_days}일) 실패, 전체 재탐색")

    best_days, best_result = await find_widest_successful_window(
        attempt, PERMIT_INITIAL_LOOKBACK_DAYS, PERMIT_COARSE_STEP_DAYS
    )
    if best_result:
        window_cache[district['code']] = best_days
        print(f"{district['code']} {district['kor_name']} 최대 조회기간 {best_days}일")
    return best_result or []


def filter_residential_permits(records):
    return [
        x for x in records
        if x["USE_PURP"] == "주거용" and x["JOB_GBN_NM"] == "허가" and x["JIMOK"] == "대"
    ]


async def geocode_permit_records(session, records, cache, stats, semaphore):
    resolved = await geocode_unique_addresses(session, (r["ADDRESS"] for r in records), cache, stats, semaphore)

    geocoded = []
    for record in records:
        place_name, lat, lng = resolved[record["ADDRESS"]]
        if place_name and lat and lng:
            geocoded.append({
                "address": record["ADDRESS"],
                "place_name": place_name,
                "lat": lat,
                "lng": lng,
                "date": record["HNDL_YMD"],
                "sggCd": record["SGG_CD"],
            })
    return geocoded


async def process_district_permit(session, district, today, geocode_semaphore, cache, stats, window_cache):
    records = await fetch_district_permits(session, district, today, window_cache)
    residential = filter_residential_permits(records)

    # 서울시 API는 ADDRESS를 이미 "구 동 지번" 형태로 내려준다. 실거래 데이터와 형식을
    # 맞추기 위해 앞에 "서울특별시"만 붙인다(district['kor_name']은 "서울특별시 구" 전체라
    # 그대로 붙이면 구 이름이 중복된다).
    for record in residential:
        record["ADDRESS"] = f"서울특별시 {record['ADDRESS'].strip()}"

    return await geocode_permit_records(session, residential, cache, stats, geocode_semaphore)


async def crawl_permits(session, geocode_semaphore, cache, stats, window_cache):
    today = date.today()
    data = []
    for district in SEOUL_DISTRICTS:
        try:
            geocoded = await process_district_permit(
                session, district, today, geocode_semaphore, cache, stats, window_cache
            )
        except (KeyError, ValueError, TypeError, aiohttp.ClientError, asyncio.TimeoutError) as e:
            print(f"[오류] {district['code']} {district['kor_name']} 허가 처리 실패, 건너뜀: {e}")
            continue

        data.extend(geocoded)
        print(f"[{district['code']}] {district['kor_name']} 토지거래허가 {len(geocoded)}건")
    return data


def compute_permit_safe_days(window_cache):
    """구별로 실제 조회 가능한 기간이 다를 수 있어(날짜별로도 바뀜), 코로플레스로 지역을
    공정하게 비교하려면 모든 구가 공통으로 보장하는 최소 기간까지만 써야 한다. 한 구라도
    기록이 없으면(한 번도 성공한 적 없음) 0으로 잡아 보수적으로 계산한다.
    """
    return min((window_cache.get(d['code'], 0) for d in SEOUL_DISTRICTS), default=0)


# -------------------- 실행 -------------------- #
async def main():
    if not KAKAO_API_KEY:
        raise SystemExit("KAKAO_API_KEY 환경변수가 설정되지 않았습니다.")
    if not DATAGOKR_API_KEY:
        raise SystemExit("DATAGOKR_API_KEY 환경변수가 설정되지 않았습니다.")

    cache = load_json_cache(CACHE_FILE_PATH)
    window_cache = load_json_cache(PERMIT_WINDOW_CACHE_PATH)
    trade_stats = {"api_call": 0, "cache_hit": 0}
    permit_stats = {"api_call": 0, "cache_hit": 0}

    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_SECONDS)
    page_semaphore = asyncio.Semaphore(PAGE_CONCURRENCY)
    geocode_semaphore = asyncio.Semaphore(GEOCODE_CONCURRENCY)

    async with aiohttp.ClientSession(timeout=timeout) as session:
        trade_data, permit_data = await asyncio.gather(
            crawl_trades(session, page_semaphore, geocode_semaphore, cache, trade_stats),
            crawl_permits(session, geocode_semaphore, cache, permit_stats, window_cache),
        )

    print(f"실거래 완료: API 호출 {trade_stats['api_call']}회, 캐시 사용 {trade_stats['cache_hit']}회")
    print(f"허가 완료: API 호출 {permit_stats['api_call']}회, 캐시 사용 {permit_stats['cache_hit']}회")

    permit_safe_days = compute_permit_safe_days(window_cache)
    print(f"허가 구별 공통 안전 조회기간: {permit_safe_days}일")

    save_data(TRADE_DATA_FILE_PATH, trade_data)
    save_data(PERMIT_DATA_FILE_PATH, permit_data, {"safe_days": permit_safe_days})
    save_json_cache(CACHE_FILE_PATH, cache)
    save_json_cache(PERMIT_WINDOW_CACHE_PATH, window_cache)


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())
