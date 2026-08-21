import asyncio
from datetime import date
from unittest.mock import patch

import aiohttp

import main
from main import (
    pick_best_document,
    target_deal_months,
    parse_xml_items,
    fetch_page,
    find_widest_successful_window,
    filter_residential_permits,
)


def test_pick_best_document_prefers_apartment():
    docs = [
        {'category_name': '부동산 > 원룸'},
        {'category_name': '부동산 > 아파트'},
    ]
    assert pick_best_document(docs) is docs[1]


def test_pick_best_document_falls_back_to_residential():
    docs = [{'category_name': '부동산 > 주거시설'}]
    assert pick_best_document(docs) is docs[0]


def test_pick_best_document_falls_back_to_realestate():
    docs = [{'category_name': '부동산 > 토지'}]
    assert pick_best_document(docs) is docs[0]


def test_pick_best_document_falls_back_to_first():
    docs = [{'category_name': '음식점 > 카페'}]
    assert pick_best_document(docs) is docs[0]


def test_pick_best_document_empty_list():
    assert pick_best_document([]) is None


def test_target_deal_months_within_year():
    months = target_deal_months(date(2026, 8, 20))
    assert months == ['202608', '202607', '202606']


def test_target_deal_months_crosses_year_boundary():
    months = target_deal_months(date(2026, 1, 15))
    assert months == ['202601', '202512', '202511']


def test_parse_xml_items_success():
    xml = """<response>
        <header><resultCode>000</resultCode></header>
        <body><items>
            <item><aptNm>테스트아파트</aptNm><dealAmount> 50,000 </dealAmount></item>
        </items></body>
    </response>"""
    root, items = parse_xml_items(xml)
    assert len(items) == 1
    assert items[0] == {'aptNm': '테스트아파트', 'dealAmount': '50,000'}


def test_parse_xml_items_api_error_raises():
    xml = """<response>
        <header><resultCode>99</resultCode><resultMsg>APPLICATION ERROR</resultMsg></header>
    </response>"""
    try:
        parse_xml_items(xml)
        assert False, 'ValueError가 발생해야 함'
    except ValueError as e:
        assert 'APPLICATION ERROR' in str(e)


def test_fetch_page_survives_connection_timeout():
    # 실제 GitHub Actions에서 관측된 실패: session.get()이 커넥션 타임아웃으로 예외를 던져도
    # fetch_page는 크래시하지 않고 (None, [])을 반환해야 나머지 페이지/구 수집이 계속된다.
    class FakeSession:
        def get(self, *args, **kwargs):
            raise aiohttp.ClientConnectionError("connection timeout")

    async def run():
        return await fetch_page(FakeSession(), asyncio.Semaphore(1), 'http://example.com', {'pageNo': '1'})

    root, items = asyncio.run(run())
    assert root is None
    assert items == []


def test_fetch_page_retries_on_429_then_succeeds():
    # 실제 72개 구를 전부 도는 실행에서 뒷부분(경기도 포함)이 429로 통째로 비는 걸 확인한 버그.
    call_count = {'n': 0}

    class FakeResponse:
        def __init__(self, status, text):
            self.status = status
            self._text = text

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def text(self):
            return self._text

    success_xml = (
        "<response><header><resultCode>000</resultCode></header>"
        "<body><items><item><aptNm>X</aptNm></item></items></body></response>"
    )

    class FakeSession:
        def get(self, *args, **kwargs):
            call_count['n'] += 1
            if call_count['n'] <= 2:
                return FakeResponse(429, '')
            return FakeResponse(200, success_xml)

    async def run():
        with patch('main.RATE_LIMIT_BACKOFF_BASE', 0):
            return await fetch_page(FakeSession(), asyncio.Semaphore(1), 'http://example.com', {'pageNo': '1'})

    root, items = asyncio.run(run())
    assert call_count['n'] == 3  # 429 두 번 재시도 후 세 번째에 성공
    assert len(items) == 1


def test_fetch_page_gives_up_after_max_retries_on_429():
    class FakeResponse:
        def __init__(self, status):
            self.status = status

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def text(self):
            return ''

    class FakeSession:
        def get(self, *args, **kwargs):
            return FakeResponse(429)

    async def run():
        with patch('main.RATE_LIMIT_BACKOFF_BASE', 0):
            return await fetch_page(FakeSession(), asyncio.Semaphore(1), 'http://example.com', {'pageNo': '1'}, max_retries=2)

    root, items = asyncio.run(run())
    assert root is None
    assert items == []


def test_fetch_district_permits_reuses_cached_window_and_probes_one_day_wider():
    calls = []

    async def fake_try(session, district, today, lookback_days):
        calls.append(lookback_days)
        return ['item'] if lookback_days <= 33 else None  # 실제로는 33일까지 통한다고 가정

    district = {'code': '11110', 'kor_name': '서울특별시 종로구'}
    window_cache = {'11110': 32}  # 지난 실행엔 32일까지 통했음

    async def run():
        with patch('main._try_fetch_permits', new=fake_try):
            return await main.fetch_district_permits(None, district, date(2026, 8, 21), window_cache)

    result = asyncio.run(run())
    assert result == ['item']
    assert calls == [32, 33]  # 캐시값 확인 + 1일 확장 시도만, 전체 탐색은 안 함
    assert window_cache['11110'] == 33


def test_fetch_district_permits_falls_back_to_full_search_when_cache_stale():
    calls = []

    async def fake_try(session, district, today, lookback_days):
        calls.append(lookback_days)
        return ['item'] if lookback_days <= 20 else None

    district = {'code': '11110', 'kor_name': '서울특별시 종로구'}
    window_cache = {'11110': 55}  # 더 이상 통하지 않는 오래된 캐시값

    async def run():
        with patch('main._try_fetch_permits', new=fake_try):
            return await main.fetch_district_permits(None, district, date(2026, 8, 21), window_cache)

    result = asyncio.run(run())
    assert result == ['item']
    assert calls[0] == 55  # 캐시값을 먼저 시도해보고
    assert window_cache['11110'] <= 20  # 실패하면 전체 재탐색으로 갱신됨


def test_filter_residential_permits():
    records = [
        {"USE_PURP": "주거용", "JOB_GBN_NM": "허가", "JIMOK": "대", "id": "keep"},
        {"USE_PURP": "상업용", "JOB_GBN_NM": "허가", "JIMOK": "대", "id": "drop_purpose"},
        {"USE_PURP": "주거용", "JOB_GBN_NM": "신고", "JIMOK": "대", "id": "drop_job"},
        {"USE_PURP": "주거용", "JOB_GBN_NM": "허가", "JIMOK": "전", "id": "drop_jimok"},
    ]
    result = filter_residential_permits(records)
    assert [r["id"] for r in result] == ["keep"]


def test_find_widest_successful_window_finds_exact_boundary():
    # 실제 API의 숨겨진 최대 허용 조회기간이 39일이라고 가정 (구/날짜마다 달라지는 상황을 흉내)
    threshold = 39

    async def attempt(days):
        return {"days": days} if days <= threshold else None

    best_days, best_result = asyncio.run(
        find_widest_successful_window(attempt, initial_days=60, coarse_step=10)
    )
    assert best_days == threshold
    assert best_result == {"days": threshold}


def test_find_widest_successful_window_boundary_at_initial_days():
    async def attempt(days):
        return {"days": days}  # 항상 성공 (60일까지 전부 허용되는 경우)

    best_days, _ = asyncio.run(
        find_widest_successful_window(attempt, initial_days=60, coarse_step=10)
    )
    assert best_days == 60  # initial_days를 넘어서 탐색하지 않아야 함


def test_find_widest_successful_window_never_succeeds():
    async def attempt(days):
        return None

    best_days, best_result = asyncio.run(
        find_widest_successful_window(attempt, initial_days=60, coarse_step=10)
    )
    assert best_days == 0
    assert best_result is None


def test_geocode_trade_records_dedupes_concurrent_addresses():
    call_log = []

    async def fake_get_lat_lon(session, address, cache):
        call_log.append(address)
        await asyncio.sleep(0)
        return (None, 37.0, 127.0)

    records = [
        {'ADDRESS': '서울특별시 종로구 무악동 1', 'sggCd': '11110', 'aptNm': 'A아파트',
         'dealYear': '2026', 'dealMonth': '8', 'dealDay': '1',
         'excluUseAr': '84.9', 'dealingGbn': '중개거래', 'floor': '5', 'dealAmount': '90,000'},
        {'ADDRESS': '서울특별시 종로구 무악동 1', 'sggCd': '11110', 'aptNm': 'A아파트',
         'dealYear': '2026', 'dealMonth': '8', 'dealDay': '2',
         'excluUseAr': '84.9', 'dealingGbn': '중개거래', 'floor': '6', 'dealAmount': '91,000'},
    ]
    cache = {}
    stats = {'api_call': 0, 'cache_hit': 0}

    async def run():
        with patch('main.get_lat_lon', new=fake_get_lat_lon):
            return await main.geocode_trade_records(None, records, cache, stats, asyncio.Semaphore(4))

    result = asyncio.run(run())

    assert len(result) == 2
    assert call_log.count('서울특별시 종로구 무악동 1') == 1
    assert stats == {'api_call': 1, 'cache_hit': 0}
    assert result[0]['place_name'] == 'A아파트'  # place_name 없으면 aptNm으로 대체


def test_geocode_permit_records_shares_cache_with_trades():
    # 실거래/허가가 같은 주소를 캐시에서 공유하는지 (병합의 핵심 이점)
    async def fake_get_lat_lon(session, address, cache):
        return cache[address]

    cache = {'서울특별시 종로구 무악동 1': ('무악아파트', 37.1, 127.1)}
    stats = {'api_call': 0, 'cache_hit': 0}
    records = [{'ADDRESS': '서울특별시 종로구 무악동 1', 'HNDL_YMD': '20260801', 'SGG_CD': '11110'}]

    async def run():
        with patch('main.get_lat_lon', new=fake_get_lat_lon):
            return await main.geocode_permit_records(None, records, cache, stats, asyncio.Semaphore(4))

    result = asyncio.run(run())
    assert result == [{
        'address': '서울특별시 종로구 무악동 1', 'place_name': '무악아파트',
        'lat': 37.1, 'lng': 127.1, 'date': '20260801', 'sggCd': '11110',
    }]
    assert stats == {'api_call': 0, 'cache_hit': 1}


def test_seoul_districts_is_subset_of_lawd_cd():
    assert len(main.SEOUL_DISTRICTS) == 25
    assert all(d['code'].startswith('11') for d in main.SEOUL_DISTRICTS)


if __name__ == "__main__":
    test_pick_best_document_prefers_apartment()
    test_pick_best_document_falls_back_to_residential()
    test_pick_best_document_falls_back_to_realestate()
    test_pick_best_document_falls_back_to_first()
    test_pick_best_document_empty_list()
    test_target_deal_months_within_year()
    test_target_deal_months_crosses_year_boundary()
    test_parse_xml_items_success()
    test_parse_xml_items_api_error_raises()
    test_fetch_page_survives_connection_timeout()
    test_fetch_page_retries_on_429_then_succeeds()
    test_fetch_page_gives_up_after_max_retries_on_429()
    test_fetch_district_permits_reuses_cached_window_and_probes_one_day_wider()
    test_fetch_district_permits_falls_back_to_full_search_when_cache_stale()
    test_filter_residential_permits()
    test_find_widest_successful_window_finds_exact_boundary()
    test_find_widest_successful_window_boundary_at_initial_days()
    test_find_widest_successful_window_never_succeeds()
    test_geocode_trade_records_dedupes_concurrent_addresses()
    test_geocode_permit_records_shares_cache_with_trades()
    test_seoul_districts_is_subset_of_lawd_cd()
    print("모든 테스트 통과")
