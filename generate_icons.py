"""아파트핀 앱 아이콘 생성 (그라디언트 배경 + 지붕 달린 집 모양 마커)."""
from PIL import Image, ImageDraw


def make_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 배경: 파랑(#2c8ec9) -> 보라(#8e5cd9) 대각선 그라디언트, 둥근 사각형
    top = (44, 142, 201)
    bottom = (142, 92, 217)
    for y in range(size):
        t = y / size
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        draw.line([(0, y), (size, y)], fill=(r, g, b, 255))

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size, size], radius=size * 0.22, fill=255
    )
    img.putalpha(mask)
    draw = ImageDraw.Draw(img)

    # 전경: 지붕 달린 집 모양 마커 (app.js buildPinIcon과 동일한 실루엣)
    u = size / 32.0
    house = [
        (16 * u, 5 * u), (25 * u, 15 * u), (25 * u, 27 * u),
        (22 * u, 27 * u), (16 * u, 35 * u), (10 * u, 27 * u),
        (7 * u, 27 * u), (7 * u, 15 * u),
    ]
    draw.polygon(house, fill=(255, 255, 255, 255))
    draw.line([(7 * u, 15 * u), (25 * u, 15 * u)], fill=(44, 142, 201, 255), width=max(1, int(1.5 * u)))
    door_w, door_h = 5 * u, 6 * u
    draw.rounded_rectangle(
        [16 * u - door_w / 2, 27 * u - door_h, 16 * u + door_w / 2, 27 * u],
        radius=u, fill=(142, 92, 217, 255)
    )

    return img


SIZES = {
    "icon-512x512.png": 512,
    "icon-192x192.png": 192,
    "android-chrome-512x512.png": 512,
    "android-chrome-192x192.png": 192,
    "apple-touch-icon.png": 180,
    "favicon-32x32.png": 32,
    "favicon-16x16.png": 16,
}

if __name__ == "__main__":
    import os
    out_dir = os.path.join(os.path.dirname(__file__), "images")
    for name, size in SIZES.items():
        make_icon(size).save(os.path.join(out_dir, name))
        print(f"saved {name} ({size}x{size})")
