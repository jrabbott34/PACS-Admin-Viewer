import sys
from playwright.sync_api import sync_playwright
from PIL import Image
import io
def px(pg, x, y):
    im = Image.open(io.BytesIO(pg.screenshot())).convert("RGB")
    return im.getpixel((x, y))
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist","--enable-webgl"])
    pg = b.new_page(viewport={"width":1440,"height":860})
    pg.goto(sys.argv[1]); pg.wait_for_function("window.__viewer !== undefined", timeout=20000)
    import glob
    pg.set_input_files("#file-input", sorted(glob.glob("ct/*.dcm"))[:3] + ["xr/xr_001.dcm"]); pg.wait_for_timeout(3500)
    for i in pg.query_selector_all(".series-item"):
        if "PA chest" in i.inner_text(): i.click()
    pg.wait_for_timeout(1500)
    # background of body (outside chest ellipse) near top-left of image; spine at center
    bg, spine = (470, 130), (838, 430)
    print("initial   user-invert:", pg.evaluate("window.__viewer.state.invert"), "bg", px(pg,*bg), "spine", px(pg,*spine))
    pg.click("#btn-invert"); pg.wait_for_timeout(600)
    print("toggled   user-invert:", pg.evaluate("window.__viewer.state.invert"), "bg", px(pg,*bg), "spine", px(pg,*spine))
    pg.click("#btn-reset"); pg.wait_for_timeout(600)
    print("reset     user-invert:", pg.evaluate("window.__viewer.state.invert"), "bg", px(pg,*bg), "spine", px(pg,*spine))
    b.close()
