"""生成 AI盯播工具 的占位图标（文字「盯」+ 品牌蓝底）。

用途：交付前的最小可用图标，避免走 Electron 默认图标。
后续有品牌素材时替换 build/icon.ico 即可。
"""
from PIL import Image, ImageDraw, ImageFont

OUT_ICO = r"D:\ai盯播工具\app\build\icon.ico"
OUT_PNG = r"D:\ai盯播工具\app\build\icon.png"

# 与 renderer 设计系统同一套蓝色（styles.css --accent / brand-mark 渐变）
TOP = (59, 130, 246)      # #3b82f6
BOTTOM = (29, 78, 216)    # #1d4ed8

SIZES = [16, 24, 32, 48, 64, 128, 256]


def find_cjk_font(size: int):
    """找一个能画中文的字体。Windows 自带 msyh/msyhbd。"""
    candidates = [
        r"C:\Windows\Fonts\msyhbd.ttc",   # 微软雅黑 Bold
        r"C:\Windows\Fonts\msyh.ttc",     # 微软雅黑
        r"C:\Windows\Fonts\simhei.ttf",   # 黑体
        r"C:\Windows\Fonts\simsun.ttc",   # 宋体
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def rounded_gradient(size: int) -> Image.Image:
    """圆角方形 + 垂直渐变，模仿 sidebar 里的 brand-mark。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGBA", (size, size))
    px = grad.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
        g = int(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
        b = int(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b, 255)

    # 圆角遮罩
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=max(2, int(size * 0.22)), fill=255
    )
    img.paste(grad, (0, 0), mask)
    return img


def draw_glyph(img: Image.Image) -> Image.Image:
    size = img.size[0]
    d = ImageDraw.Draw(img)
    # 字号取 0.62×边长，「盯」字在方块里视觉居中
    font_size = max(8, int(size * 0.62))
    font = find_cjk_font(font_size)
    text = "盯"

    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1]
    d.text((x, y), text, font=font, fill=(255, 255, 255, 255))
    return img


def main():
    import os
    os.makedirs(os.path.dirname(OUT_ICO), exist_ok=True)

    frames = []
    for s in SIZES:
        im = draw_glyph(rounded_gradient(s))
        frames.append(im)

    # 256 的 PNG 供 Electron 窗口/概览用
    frames[-1].save(OUT_PNG, format="PNG")

    # ICO 多尺寸（Windows 会按需挑）
    frames[-1].save(OUT_ICO, format="ICO", sizes=[(s, s) for s in SIZES])
    print("wrote", OUT_ICO)
    print("wrote", OUT_PNG)


if __name__ == "__main__":
    main()
