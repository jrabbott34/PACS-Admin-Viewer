import sys, glob
from playwright.sync_api import sync_playwright
BASE = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist","--enable-webgl"])
    pg = b.new_page(viewport={"width":1440,"height":860})
    logs = []
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text}") if m.type in ("error",) else None)
    pg.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    pg.goto(BASE); pg.wait_for_function("window.__viewer !== undefined", timeout=20000)
    paths = sorted(glob.glob("ct/*.dcm")) + sorted(glob.glob("mr/*.dcm")) + glob.glob("xr/*.dcm") + ["photo.jpg","scan.png","report.pdf"]
    pg.set_input_files("#file-input", paths)
    pg.wait_for_timeout(6000)
    print("status:", pg.inner_text("#status"))
    items = pg.query_selector_all(".series-item")
    print("series:", [i.inner_text().replace("\n"," / ") for i in items])
    def pick(txt):
        for i in pg.query_selector_all(".series-item"):
            if txt in i.inner_text(): i.click(); pg.wait_for_timeout(1500); return
        print("NOT FOUND", txt)
    pick("Chest phantom 5mm")
    pg.keyboard.press("End"); pg.wait_for_timeout(500)
    print("after End BL:", pg.inner_text(".ov.bl").replace("\n"," | "))
    pg.select_option("#preset", index=pg.eval_on_selector_all("#preset option","o=>o.findIndex(x=>x.textContent.startsWith('Lung'))"))
    pg.wait_for_timeout(500)
    print("after Lung BR:", pg.inner_text(".ov.br").replace("\n"," | "))
    pg.keyboard.press("h"); pg.wait_for_timeout(1500)
    print("header:", pg.inner_text(".hp-count"))
    pg.fill(".hp-search", "slice"); pg.wait_for_timeout(300)
    print("filter 'slice':", pg.inner_text(".hp-count"))
    pg.fill(".hp-search", "")
    pg.screenshot(path="/tmp/f_ct.png")
    for txt, name in [("T2 axial","mr"),("PA chest","xr"),("photo.jpg","jpg"),("scan.png","png"),("report.pdf","pdf")]:
        if True:
            pick(txt)
            print(f"[{name}] TL:", pg.inner_text(".ov.tl").replace("\n"," | "), "|| BL:", pg.inner_text(".ov.bl").replace("\n"," | "), "|| BR:", pg.inner_text(".ov.br").replace("\n"," | "))
            pg.screenshot(path=f"/tmp/f_{name}.png")
    print("ERRORS:", logs[:10])
    b.close()
