import sys
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist","--enable-webgl"])
    pg = b.new_page(viewport={"width":1440,"height":860})
    logs=[]
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text}") if m.type in ("error","warning") else None)
    pg.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    pg.goto(sys.argv[1]); pg.wait_for_function("window.__viewer !== undefined", timeout=20000); pg.click("#splash-open")
    pg.set_input_files("#file-input", ["photo.jpg","scan.png","report.pdf"])
    pg.wait_for_timeout(5000)
    print("status:", pg.inner_text("#status"))
    print("tooltip:", pg.get_attribute("#status","title"))
    print("series:", [i.inner_text().replace("\n"," / ") for i in pg.query_selector_all(".series-item")])
    print("\n".join(l[:400] for l in logs[:12]))
    b.close()
