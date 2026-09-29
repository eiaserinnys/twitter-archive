"""모의 서버에서 주요 화면과 API 동작을 확인하고 비교용 캡처를 저장한다."""

import json
import os
import subprocess
import time
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ["SCREENSHOT_DIR"])
OUT.mkdir(parents=True, exist_ok=True)
PORT = 4179
BASE = f"http://127.0.0.1:{PORT}"


def ready():
    for _ in range(50):
        try:
            with urlopen(BASE, timeout=0.2):
                return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("mock server did not start")


def width_ok(page):
    data = page.evaluate("({scroll: document.documentElement.scrollWidth, viewport: innerWidth})")
    assert data["scroll"] <= data["viewport"], data
    return data


def capture(page, name):
    if not (os.environ.get("CAPTURE_ONLY_MISSING") == "1" and (OUT / name).exists()):
        page.screenshot(path=str(OUT / name), animations="disabled")
    return width_ok(page)


with (OUT / "requests.log").open("w") as log:
    server = subprocess.Popen(
        ["node", "tools/mock-server.mjs"], cwd=ROOT,
        env={**os.environ, "MOCK_PORT": str(PORT)}, stdout=log, stderr=subprocess.STDOUT,
    )
    try:
        ready()
        with sync_playwright() as playwright:
            browser = playwright.webkit.launch()
            mobile = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
            page = mobile.new_page()
            errors = []
            search_404 = []
            topic_400 = []
            reads = []
            writes = []
            page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("response", lambda response: search_404.append(response.url) if response.status == 404 and "/api/search" in response.url else None)
            page.on("response", lambda response: topic_400.append(response.url) if response.status == 400 and "/api/tweets" in response.url else None)
            page.on("request", lambda request: (reads if request.method == "GET" or request.url.endswith("/api/search") else writes).append(f"{request.method} {request.url}"))

            page.goto(BASE, wait_until="networkidle")
            page.locator("#handleLink").wait_for()
            assert page.locator("#handleLink").inner_text() == "@archive_account"
            assert "표본" not in page.locator("body").inner_text()
            widths = {"mobile_timeline": capture(page, "mobile-timeline.png")}

            page.locator('#grid button.row-h[data-r="2013"]').click()
            page.wait_for_url("**/year/2013")
            assert page.url.endswith("/year/2013")
            widths["mobile_year"] = capture(page, "mobile-year-2013.png")
            tag = page.locator("#yearTags .tagchip").first
            tag.click()
            page.wait_for_function("document.getElementById('pTitle').textContent === '프로젝트 기간'")
            assert any("topics=work" in item for item in reads), reads
            with page.expect_request(lambda request: "/api/tweets" in request.url and "from=2009-01-01" in request.url and "topics=" not in request.url):
                page.locator("#pExtra").get_by_role("button", name="전체 보기").click()
            page.locator("#closeBtn").click()
            page.wait_for_function("!document.documentElement.classList.contains('sheet-open')")
            page.route("**/api/tweets?*topics=work*", lambda route: route.fulfill(status=400, content_type="application/json", body='{"error":"topic_not_allowed"}'), times=1)
            tag.click()
            page.wait_for_function("document.getElementById('pTitle').textContent === '프로젝트 기간'")
            page.locator("#panel .tw-date").first.wait_for()
            assert topic_400, "tag topic rejection was not exercised"
            page.locator("#closeBtn").click()
            page.wait_for_function("!document.documentElement.classList.contains('sheet-open')")
            page.locator('#mgrid button.cell[data-r="3"][data-t="games"]').click()
            page.locator("#panel.presented").wait_for()
            page.wait_for_function("Math.abs(new DOMMatrix(getComputedStyle(document.getElementById('panel')).transform).m42) < 1")
            widths["mobile_month_sheet"] = capture(page, "mobile-month-sheet.png")
            page.locator("#panel .tw-date").first.click()
            page.wait_for_url("**/day/*")
            assert "/day/" in page.url

            page.locator("#t-today").click()
            page.locator("#stack .yr").first.wait_for()
            widths["mobile_today"] = capture(page, "mobile-today.png")
            page.locator("#q").fill("게임")
            page.locator("#q").press("Enter")
            page.get_by_text("뜻 검색은 준비 중").wait_for()
            page.locator("#srMain").evaluate("node => node.scrollIntoView({block: 'start'})")
            widths["mobile_search"] = capture(page, "mobile-search.png")
            example_tweet = json.load(urlopen(BASE + "/api/tweets?limit=1"))["tweets"][0]
            success = {"q": "영화", "judged": {"topics": [{"id": "film", "score": 0.91}], "period": None},
                       "candidates": 7, "results": [{"tweet": example_tweet, "score": 0.93, "why": "뜻이 맞는 글"}],
                       "stages": [{"name": "judge", "ms": 420}, {"name": "candidates", "ms": 35}, {"name": "rank", "ms": 1800}]}
            page.route("**/api/search*", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(success, ensure_ascii=False)))
            page.locator("#q").fill("영화")
            page.locator("#q").press("Enter")
            page.locator("#srMain .replay-top").get_by_text("후보 7개").wait_for()
            assert page.locator("#srMain .tw-why").inner_text() == "뜻이 맞는 글"
            page.unroute("**/api/search*")

            page.locator("#setBtn").click()
            page.wait_for_url("**/settings")
            assert page.url.endswith("/settings")
            widths["mobile_settings_topics"] = capture(page, "mobile-settings-topics.png")
            page.get_by_role("button", name="정치 주제 수정").click()
            page.locator("#tpPrompt").fill("정치와 정책에 대한 이야기")
            page.locator("#topicForm button[type=submit]").click()
            page.locator("#confirmDlg").wait_for(state="visible")
            page.locator("#cfOk").click()
            page.locator("#topicForm").wait_for(state="hidden")
            page.locator("#stTags").click()
            widths["mobile_settings_tags"] = capture(page, "mobile-settings-tags.png")
            page.locator("#tagAdd").click()
            page.locator("#fName").fill("검증 태그")
            page.locator("#fStartM").fill("2013-03")
            page.locator("#fEndM").fill("2013-04")
            page.locator("#tagForm button[type=submit]").click()
            page.get_by_role("button", name="검증 태그 삭제").click()
            page.get_by_role("button", name="검증 태그 삭제").click()

            page.locator("#visSwitch").click()
            page.locator("#visitorBar").wait_for(state="visible")
            assert page.locator("#setBtn").is_hidden()
            assert page.locator("#ownerLinkWrap").is_visible()
            page.locator("#t-timeline").click()
            widths["mobile_visitor"] = capture(page, "mobile-visitor.png")
            assert reads and all("as=visitor" in item for item in reads[reads.index(next(item for item in reads if "as=visitor" in item)):])

            desktop = browser.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
            wide = desktop.new_page()
            wide.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
            wide.on("pageerror", lambda error: errors.append(str(error)))
            wide.goto(BASE + "/year/2013", wait_until="networkidle")
            wide.locator("#mgrid button.cell").first.wait_for()
            widths["desktop_year"] = capture(wide, "desktop-year-2013.png")
            assert wide.locator("#panel").is_visible()
            assert any("PATCH" in item and "/api/topics/politics" in item for item in writes), writes
            assert any("POST" in item and "/api/tags" in item for item in writes), writes
            assert any("DELETE" in item and "/api/tags/" in item for item in writes), writes
            transport_errors = [error for error in errors if "Failed to load resource: the server responded with a status of 404" in error or
                                "Failed to load resource: the server responded with a status of 400" in error]
            app_errors = [error for error in errors if error not in transport_errors]
            assert len(transport_errors) == len(search_404) + len(topic_400), {"errors": errors, "expected_search_404": search_404, "expected_topic_400": topic_400}
            assert not app_errors, app_errors
            print(json.dumps({"screenshots": len(widths), "widths": widths, "writes": writes,
                              "app_console_errors": app_errors, "expected_search_404": len(search_404),
                              "expected_topic_400": len(topic_400)}, ensure_ascii=False))
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=5)
