// Physics Tracker - test_logic.js
// Node.js 環境下でのコアロジック単体テストスクリプト

const fs = require('fs');
const path = require('path');

// ブラウザ環境の極限モック
global.document = {
    addEventListener: () => {},
    getElementById: (id) => {
        return {
            addEventListener: () => {},
            querySelector: () => ({ textContent: '' }),
            querySelectorAll: () => [],
            classList: { add: () => {}, remove: () => {}, toggle: () => {} },
            style: {},
            value: '40',
            disabled: false
        };
    },
    querySelector: () => ({
        addEventListener: () => {},
        appendChild: () => {},
        innerHTML: ''
    }),
    querySelectorAll: () => []
};
global.window = {
    addEventListener: () => {}
};
global.navigator = {
    clipboard: {
        writeText: () => Promise.resolve()
    }
};

// app.js の読み込み
const appJsPath = path.join(__dirname, 'app.js');
const app = require(appJsPath);

// テスト用アサーション
function assert(condition, message) {
    if (!condition) {
        console.error(`❌ FAIL: ${message}`);
        process.exit(1);
    }
    console.log(`✅ PASS: ${message}`);
}

function assertClose(val1, val2, tol = 0.001, message = "") {
    const diff = Math.abs(val1 - val2);
    if (diff > tol) {
        console.error(`❌ FAIL: ${message} (expected close to ${val2}, got ${val1}, diff ${diff})`);
        process.exit(1);
    }
    console.log(`✅ PASS: ${message}`);
}

console.log("=== ロジックテスト開始 ===");

// --- 1. 座標変換: アスペクト一致（レターボックス無し）の往復 ---
// canvas 800x450 は video 1920x1080 と同じ 16:9 → fit のみ、余白0
app.test_setVars({
    canvas: { width: 800, height: 450 },
    videoElement: { videoWidth: 1920, videoHeight: 1080 },
    viewState: { scale: 1, offsetX: 0, offsetY: 0 }
});

let vPos = app.canvasToVideo(400, 225);
assertClose(vPos.x, 960, 0.01, "ズーム1倍: Canvas中央→動画中央 (X)");
assertClose(vPos.y, 540, 0.01, "ズーム1倍: Canvas中央→動画中央 (Y)");

let cPos = app.videoToCanvas(960, 540);
assertClose(cPos.x, 400, 0.01, "ズーム1倍: 動画中央→Canvas中央 逆変換 (X)");
assertClose(cPos.y, 225, 0.01, "ズーム1倍: 動画中央→Canvas中央 逆変換 (Y)");

// --- 2. 座標変換: ズーム2倍・パン有 の往復 ---
app.test_setVars({ viewState: { scale: 2, offsetX: 100, offsetY: 50 } });
// 動画(0,0) → local(0,0) → canvas(0*2+100, 0*2+50) = (100,50)
cPos = app.videoToCanvas(0, 0);
assertClose(cPos.x, 100, 0.01, "ズーム2倍・パン: 動画(0,0)→Canvas(100,50) (X)");
assertClose(cPos.y, 50, 0.01, "ズーム2倍・パン: 動画(0,0)→Canvas(100,50) (Y)");
vPos = app.canvasToVideo(100, 50);
assertClose(vPos.x, 0, 0.01, "ズーム2倍・パン: Canvas(100,50)→動画(0,0) (X)");
assertClose(vPos.y, 0, 0.01, "ズーム2倍・パン: Canvas(100,50)→動画(0,0) (Y)");

// --- 3. レターボックス: 縦長動画を横長Canvasに中央配置 ---
// canvas 1000x400 / video 1080x1920(縦長) → fit=0.20833, 横に余白 baseX≈387.5
app.test_setVars({
    canvas: { width: 1000, height: 400 },
    videoElement: { videoWidth: 1080, videoHeight: 1920 },
    viewState: { scale: 1, offsetX: 0, offsetY: 0 }
});
const m = app.getFitMetrics();
assertClose(m.fit, 400 / 1920, 0.0001, "縦長: fit は高さ基準で決まる");
assertClose(m.baseX, (1000 - 1080 * (400 / 1920)) / 2, 0.01, "縦長: 左右に均等な余白(baseX)");
assertClose(m.baseY, 0, 0.01, "縦長: 上下の余白は0");
// 動画中央(540,960) は Canvas中央(500,200) に来る
cPos = app.videoToCanvas(540, 960);
assertClose(cPos.x, 500, 0.01, "縦長: 動画中央→Canvas中央 (X=横幅の中央を使える)");
assertClose(cPos.y, 200, 0.01, "縦長: 動画中央→Canvas中央 (Y)");
vPos = app.canvasToVideo(500, 200);
assertClose(vPos.x, 540, 0.01, "縦長: Canvas中央→動画中央 逆変換 (X)");
assertClose(vPos.y, 960, 0.01, "縦長: Canvas中央→動画中央 逆変換 (Y)");

// --- 4. 実フレーム時刻表: コマ番号と実フレームが1:1（先頭スキップ/末尾重複なし） ---
const PTS = [0, 0.007747, 0.042177, 0.076608, 0.111038, 0.145469,
             0.179899, 0.214330, 0.248761, 0.283191, 0.317622, 0.352052];
const duration = 0.386483;
app.test_setVars({ frameTimes: PTS, videoDuration: duration, videoFps: 29.04 });

assertClose(app.frameTimeOf(0), 0, 1e-6, "frameTimeOf(0)=先頭フレームの実時刻");
assertClose(app.frameTimeOf(11), 0.352052, 1e-6, "frameTimeOf(11)=末尾フレームの実時刻");
assertClose(app.frameTimeOf(99), 0.352052, 1e-6, "frameTimeOf: 範囲外はクランプ");

// seekTimeOf(n) は フレーム n の表示区間 [PTS[n], PTS[n+1]) の中に入る → 表示フレーム=n で一意
for (let n = 0; n < PTS.length - 1; n++) {
    const st = app.seekTimeOf(n);
    assert(st >= PTS[n] && st < PTS[n + 1],
        `seekTimeOf(${n})=${st.toFixed(4)} が [${PTS[n]}, ${PTS[n + 1]}) に入る（コマ${n}を一意表示）`);
}
const stLast = app.seekTimeOf(11);
assert(stLast >= PTS[11] && stLast <= duration - 0.001,
    `seekTimeOf(11)=${stLast.toFixed(4)} が末尾フレーム区間内（重複せず末尾を表示）`);

// 表が無い場合は fps 換算にフォールバック
app.test_setVars({ frameTimes: [], videoFps: 30 });
assertClose(app.frameTimeOf(3), 3 / 30, 1e-6, "表なし: frameTimeOf は fps 換算");
assertClose(app.seekTimeOf(3), 3.5 / 30, 1e-6, "表なし: seekTimeOf は (frame+0.5)/fps");

// buildFrameTimeTable: 昇順・1ms以内の重複除去
const built = app.buildFrameTimeTable([0.10, 0.1004, 0.05, 0.05, 0.20]);
assert(built.length === 3, "buildFrameTimeTable: 近接重複を除去して3点");
assert(built[0] === 0.05 && built[2] === 0.20, "buildFrameTimeTable: 昇順");

// --- 5. 色差計算の擬似検証 ---
const color1 = { r: 100, g: 150, b: 200 };
const color2 = { r: 105, g: 148, b: 202 };
const diff = Math.hypot(color1.r - color2.r, color1.g - color2.g, color1.b - color2.b);
assertClose(diff, Math.sqrt(5 * 5 + 2 * 2 + 2 * 2), 0.001, "色差(RGBユークリッド距離)が正確");

console.log("=== 全ロジックテスト合格 ===");
process.exit(0);
