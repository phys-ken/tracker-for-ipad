# -*- coding: utf-8 -*-
"""物理サンプル動画ジェネレータ（samples/*.mp4 を再生成する）

真値が既知の合成動画を作る。生徒が校正〜トラッキング〜グラフまで練習できるよう、
各動画に「1 m」のスケールバーを描く（方眼は描かない＝目分量で答えが見えないように）。
エンコードは Safari/iPad 互換の H.264 / yuv420p / faststart / 60fps CFR。

使い方:  python tools/gen_samples.py
必要:    numpy, opencv-python, ffmpeg (PATH上)

真値の一覧は MANUAL.md「サンプル動画の真値」を参照（このファイルが一次情報源）。
"""
import subprocess
import numpy as np
import cv2
import os

FPS = 60
SHIFT = 4          # cv2のサブピクセル描画（微小移動でも画素が滑らかに変わる）
BG = (22, 18, 15)          # BGR: 暗室グラファイト(#0F1216)
BAR = (235, 230, 225)      # BGR: 明るいオフホワイト（校正バーは目立たせる。muted(#8A95A3)より高コントラスト）
AMBER = (39, 182, 255)     # BGR: 物体1 シグナル・アンバー(#FFB627)
CYAN = (230, 169, 90)      # BGR: 物体2 シアン(#5AA9E6)

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "samples")


def new_frame(w, h):
    f = np.zeros((h, w, 3), np.uint8)
    f[:, :] = BG
    return f


def draw_scale_bar(f, x, y, px_per_m):
    """「1 m」のスケールバー（両端＋中央50cmにティック、太め・高コントラストで目立たせる）"""
    x2 = x + px_per_m
    xm = x + px_per_m // 2
    cv2.line(f, (x, y), (x2, y), BAR, 3, cv2.LINE_AA)
    for xt, half in ((x, 9), (x2, 9), (xm, 6)):  # 両端は長め、中央(50cm)は短めのティック
        cv2.line(f, (xt, y - half), (xt, y + half), BAR, 3, cv2.LINE_AA)
    label = "1 m"
    (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
    lx, ly = xm - tw // 2, y - 14
    # 文字の視認性を上げる半透明の背景板
    overlay = f.copy()
    cv2.rectangle(overlay, (lx - 6, ly - th - 5), (lx + tw + 6, ly + 5), BG, -1)
    cv2.addWeighted(overlay, 0.65, f, 0.35, 0, f)
    cv2.putText(f, label, (lx, ly), cv2.FONT_HERSHEY_SIMPLEX, 0.6, BAR, 2, cv2.LINE_AA)


def ball(f, x, y, r, color):
    s = 1 << SHIFT
    cv2.circle(f, (int(round(x * s)), int(round(y * s))), int(r * s),
               color, -1, cv2.LINE_AA, SHIFT)


def encode(name, frames, w, h):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name)
    p = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
         "-framerate", str(FPS), "-i", "-",
         "-c:v", "libx264", "-preset", "slow", "-crf", "20",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", path],
        stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    p.wait()
    kb = os.path.getsize(path) / 1024
    print(f"  {name}: {len(frames)}f ({len(frames)/FPS:.2f}s) {w}x{h} {kb:.0f}KB")


G = 9.8  # m/s^2


def gen_free_fall():
    """自由落下（縦・v0=0）: scale 500px=1m, y0から1.6m落下"""
    W, H, PPM = 540, 960, 500
    n = 35  # 0.567s → 落下 1.57m
    frames = []
    for i in range(n):
        t = i / FPS
        f = new_frame(W, H)
        draw_scale_bar(f, 20, H - 30, PPM)
        y = 80 + 0.5 * G * t * t * PPM
        ball(f, W / 2, y, 14, AMBER)
        frames.append(f)
    encode("free_fall.mp4", frames, W, H)


def gen_vertical_throw():
    """鉛直投げ上げ（縦）: v0=4.4m/s ↑、上がって戻るまで"""
    W, H, PPM = 540, 960, 500
    V0 = 4.4
    n = int(2 * V0 / G * FPS) + 1  # 0.898s
    frames = []
    for i in range(n):
        t = i / FPS
        f = new_frame(W, H)
        draw_scale_bar(f, 20, H - 30, PPM)
        y = 880 - (V0 * t - 0.5 * G * t * t) * PPM
        ball(f, W / 2, y, 14, AMBER)
        frames.append(f)
    encode("vertical_throw.mp4", frames, W, H)


def gen_projectile():
    """水平投射（横）: scale 300px=1m, v0x=5.0m/s・v0y=0"""
    W, H, PPM = 960, 540, 300
    V0X = 5.0
    n = 34  # 0.55s → 落下1.48m・水平2.75m
    frames = []
    for i in range(n):
        t = i / FPS
        f = new_frame(W, H)
        draw_scale_bar(f, 20, H - 30, PPM)
        x = 40 + V0X * t * PPM
        y = 40 + 0.5 * G * t * t * PPM
        ball(f, x, y, 12, AMBER)
        frames.append(f)
    encode("projectile.mp4", frames, W, H)


def _collision(name, m1, m2, u1, e, r1, r2):
    """1次元衝突（横）: 左の球(物体1)が u1 で静止球(物体2)に衝突。反発係数 e。"""
    W, H, PPM = 960, 540, 300
    y = 250.0
    x1, x2 = 100.0, 620.0
    # 衝突時刻（表面接触）
    tc = ((x2 - x1) - (r1 + r2)) / (u1 * PPM)
    # 衝突後速度（運動量保存＋反発係数）
    v1 = (m1 * u1 - m2 * e * u1) / (m1 + m2)
    v2 = (m1 * u1 + m1 * e * u1) / (m1 + m2)
    # 衝突後、速い方が右端に達するまで
    xc2 = x2  # 衝突時の物体2の位置（静止）
    t_exit = tc + (W - 40 - r2 - xc2) / (max(v1, v2) * PPM)
    n = int(t_exit * FPS)
    frames = []
    for i in range(n):
        t = i / FPS
        f = new_frame(W, H)
        draw_scale_bar(f, 20, H - 30, PPM)
        if t <= tc:
            p1 = x1 + u1 * t * PPM
            p2 = x2
        else:
            dt = t - tc
            p1 = (x1 + u1 * tc * PPM) + v1 * dt * PPM
            p2 = x2 + v2 * dt * PPM
            # 合体(e=0)は重なって見えないよう、物体1は接触位置を保って追走
            if e == 0:
                p1 = p2 - (r1 + r2) + 1
        ball(f, p1, y, r1, AMBER)
        ball(f, p2, y, r2, CYAN)
        frames.append(f)
    encode(name, frames, W, H)
    return v1, v2


def main():
    print("samples/ を生成中 (60fps, H.264/yuv420p):")
    gen_free_fall()
    gen_vertical_throw()
    gen_projectile()
    v1, v2 = _collision("collision_elastic.mp4", 2.0, 1.0, 1.5, 1.0, 20, 14)
    print(f"    弾性(m1:m2=2:1, u1=1.5): v1'={v1:.3f} v2'={v2:.3f} m/s")
    v1, v2 = _collision("collision_inelastic.mp4", 1.0, 1.0, 2.0, 0.0, 16, 16)
    print(f"    合体(等質量, u1=2.0): v'={v2:.3f} m/s")
    print("完了。真値の一覧は MANUAL.md を参照。")


if __name__ == "__main__":
    main()
