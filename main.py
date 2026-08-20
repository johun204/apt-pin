import os
import asyncio
import sys
import json
import math
import aiohttp
import xml.etree.ElementTree as ET
from datetime import date, timedelta, datetime, timezone

# 1. 설정
KAKAO_API_KEY = os.getenv('KAKAO_API_KEY')
DATAGOKR_API_KEY = os.getenv('DATAGOKR_API_KEY')
CACHE_FILE_PATH = 'data/address_cache.json'
DATA_FILE_PATH = 'data/data.json'
APT_TRADE_URL = "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade"
KAKAO_KEYWORD_SEARCH_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json'

# 구가 있는 시(수원/성남/안양/부천/안산/고양/용인/화성)는 실거래가 항상 구 코드로 등록되고
# 상위 시 코드로는 조회되지 않아 상위 코드는 뺐다.
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

REQUEST_TIMEOUT_SECONDS = 15
PAGE_CONCURRENCY = 5      # 국토부 실거래가 API 페이지네이션 동시 요청 수
GEOCODE_CONCURRENCY = 8   # 카카오 지오코딩 API 동시 요청 수


# -------------------- HTTP 요청 -------------------- #
async def fetch_post(session, url, data=None, json_body=None, headers=None):
    try:
        kwargs = {}
        if headers:
            kwargs["headers"] = headers
        if json_body is not None:
            kwargs["json"] = json_body
        elif data is not None:
            kwargs["data"] = data

        async with session.post(url, **kwargs) as response:
            return await response.text()
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        print(f"요청 실패 ({url}): {e}")
        return None


# -------------------- 캐시 파일 입출력 -------------------- #
def load_address_cache(path):
    if not os.path.exists(path):
        print("기존 캐시 파일 없음. 새로 시작합니다.")
        return {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            cache = json.load(f)
        print(f"기존 캐시 로드 완료: {len(cache)}개 주소")
        return cache
    except (json.JSONDecodeError, OSError) as e:
        print(f"캐시 파일 로드 실패 (새로 시작): {e}")
        return {}


def save_address_cache(path, cache):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)
    print(f"캐시 파일 저장 완료: {path}")


# -------------------- 국토부 실거래가 조회 -------------------- #
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


async def fetch_page(session, semaphore, url, params):
    async with semaphore:
        try:
            async with session.get(url, params=params) as response:
                if response.status != 200:
                    print(f"[오류] {params['pageNo']}페이지 통신 실패 (상태 코드: {response.status})")
                    return None, []
                text = await response.text()
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            print(f"[오류] {params['pageNo']}페이지 요청 실패: {e}")
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


# -------------------- 카카오 좌표 변환 (캐시 적용) -------------------- #
def pick_best_document(documents):
    for keyword in ('아파트', '주거시설'):
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


async def geocode_trades(session, records, cache, stats, semaphore):
    unique_addresses = list(dict.fromkeys(r["ADDRESS"] for r in records))
    for address in unique_addresses:
        if address in cache:
            stats["cache_hit"] += 1
        else:
            stats["api_call"] += 1

    async def geocode_one(address):
        async with semaphore:
            return address, await get_lat_lon(session, address, cache)

    resolved = dict(await asyncio.gather(*(geocode_one(a) for a in unique_addresses)))

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


def target_deal_months(today):
    last_month_end = today.replace(day=1) - timedelta(days=1)
    two_months_ago_end = last_month_end.replace(day=1) - timedelta(days=1)
    return [today.strftime("%Y%m"), last_month_end.strftime("%Y%m"), two_months_ago_end.strftime("%Y%m")]


def save_data(path, data):
    last_updated = (datetime.now(timezone.utc) + timedelta(hours=9)).strftime("%Y-%m-%d %H:%M:%S")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({"last_updated": last_updated, "data": data}, f, ensure_ascii=False, indent=2)
    print(f"작업 완료: {last_updated}")


async def process_district(session, district, target_months, page_semaphore, geocode_semaphore, cache, stats):
    month_results = await asyncio.gather(*(
        fetch_all_apt_trade_data(session, page_semaphore, DATAGOKR_API_KEY, district["code"], deal_ymd)
        for deal_ymd in target_months
    ))
    records = [item for page_items in month_results for item in page_items]

    for record in records:
        record["ADDRESS"] = f"{district['kor_name']} {record['umdNm']} {record['jibun']}"
        record["sggCd"] = district["code"]

    return await geocode_trades(session, records, cache, stats, geocode_semaphore)


async def main():
    if not KAKAO_API_KEY:
        raise SystemExit("KAKAO_API_KEY 환경변수가 설정되지 않았습니다.")
    if not DATAGOKR_API_KEY:
        raise SystemExit("DATAGOKR_API_KEY 환경변수가 설정되지 않았습니다.")

    cache = load_address_cache(CACHE_FILE_PATH)
    stats = {"api_call": 0, "cache_hit": 0}
    data = []
    target_months = target_deal_months(date.today())

    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_SECONDS)
    page_semaphore = asyncio.Semaphore(PAGE_CONCURRENCY)
    geocode_semaphore = asyncio.Semaphore(GEOCODE_CONCURRENCY)

    async with aiohttp.ClientSession(timeout=timeout) as session:
        for district in LAWD_CD:
            # 한 구의 응답이 예상과 다른 형태(필드 누락 등)여도 나머지 구 수집은 계속되게 한다.
            try:
                geocoded = await process_district(
                    session, district, target_months, page_semaphore, geocode_semaphore, cache, stats
                )
            except (KeyError, ValueError, TypeError, aiohttp.ClientError, asyncio.TimeoutError) as e:
                print(f"[오류] {district['code']} {district['kor_name']} 처리 실패, 건너뜀: {e}")
                continue

            data.extend(geocoded)
            print(f"[{district['code']}] {district['kor_name']} 실거래 {len(geocoded)}건")

    print(f"작업 완료: API 호출 {stats['api_call']}회, 캐시 사용 {stats['cache_hit']}회")

    save_data(DATA_FILE_PATH, data)
    save_address_cache(CACHE_FILE_PATH, cache)


# -------------------- 실행 -------------------- #
if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())
