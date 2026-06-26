# 既知gの自由落下（黄ボール）PPMフレームを生成。最後に複製フレームを1枚足す。
# 物理: 10px=1cm(scale 0.1 cm/px), g=9.8m/s^2=980cm/s^2 -> 9800 px/s^2
import os, math, sys

OUT = sys.argv[1]
W, H = 540, 960
FPS = 120
N = 40                 # 実フレーム数
G_PX = 9800.0          # px/s^2  (=9.8 m/s^2 @ 10px/cm)
Y0 = 60.0              # 開始y(px)
X0 = 80                # 水平投射: 開始x
VX_PX = 1100.0         # 水平方向の一定速度(px/s) → 毎フレーム ~9px 動き、人工的な複製を避ける
R = 16                 # ボール半径(px)
BG = (30, 33, 40)
BALL = (250, 240, 40)

os.makedirs(OUT, exist_ok=True)

def write_frame(path, cx, cy):
    row_bg = bytearray()
    for _ in range(W):
        row_bg += bytes(BG)
    buf = bytearray()
    buf += b"P6\n%d %d\n255\n" % (W, H)
    r2 = R * R
    for y in range(H):
        if cy - R - 1 <= y <= cy + R + 1:
            row = bytearray(row_bg)
            dy = y - cy
            span = int(math.sqrt(max(0, r2 - dy * dy)))
            for x in range(cx - span, cx + span + 1):
                if 0 <= x < W:
                    o = x * 3
                    row[o] = BALL[0]; row[o+1] = BALL[1]; row[o+2] = BALL[2]
            buf += row
        else:
            buf += row_bg
    with open(path, "wb") as f:
        f.write(buf)

positions = []
for i in range(N):
    t = i / FPS
    cx = X0 + VX_PX * t
    cy = Y0 + 0.5 * G_PX * t * t
    positions.append((int(round(cx)), int(round(cy))))
    write_frame(os.path.join(OUT, "f_%04d.ppm" % i), int(round(cx)), int(round(cy)))

# 末尾に複製フレームを1枚追加（最終フレームと同一）
write_frame(os.path.join(OUT, "f_%04d.ppm" % N), positions[-1][0], positions[-1][1])

print("frames:", N + 1, "(incl 1 duplicate last)")
print("fps:", FPS, "scale: 10px=1cm")
print("expected fall px:", positions[-1][1] - Y0, "= %.1f cm" % ((positions[-1][1]-Y0)/10.0))
print("y0_px:", Y0, "last real y_px:", positions[-1][1])
