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
    test_filter_residential_permits()
    test_find_widest_successful_window_finds_exact_boundary()
    test_find_widest_successful_window_boundary_at_initial_days()
    test_find_widest_successful_window_never_succeeds()
    test_geocode_trade_records_dedupes_concurrent_addresses()
    test_geocode_permit_records_shares_cache_with_trades()
    test_seoul_districts_is_subset_of_lawd_cd()
    print("모든 테스트 통과")
