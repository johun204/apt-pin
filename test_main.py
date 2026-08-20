import asyncio
from datetime import date
from unittest.mock import patch

import aiohttp

import main
from main import pick_best_document, target_deal_months, parse_xml_items, fetch_page


def test_pick_best_document_prefers_apartment():
    docs = [
        {'category_name': '부동산 > 원룸'},
        {'category_name': '부동산 > 아파트'},
    ]
    assert pick_best_document(docs) is docs[1]


def test_pick_best_document_falls_back_to_residential():
    docs = [{'category_name': '부동산 > 주거시설'}]
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


def test_geocode_trades_dedupes_concurrent_addresses():
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
            return await main.geocode_trades(None, records, cache, stats, asyncio.Semaphore(4))

    result = asyncio.run(run())

    assert len(result) == 2
    assert call_log.count('서울특별시 종로구 무악동 1') == 1
    assert stats == {'api_call': 1, 'cache_hit': 0}
    assert result[0]['place_name'] == 'A아파트'  # place_name 없으면 aptNm으로 대체


if __name__ == "__main__":
    test_pick_best_document_prefers_apartment()
    test_pick_best_document_falls_back_to_residential()
    test_pick_best_document_falls_back_to_first()
    test_pick_best_document_empty_list()
    test_target_deal_months_within_year()
    test_target_deal_months_crosses_year_boundary()
    test_parse_xml_items_success()
    test_parse_xml_items_api_error_raises()
    test_fetch_page_survives_connection_timeout()
    test_geocode_trades_dedupes_concurrent_addresses()
    print("모든 테스트 통과")
