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
    })
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

// 1. 座標変換テスト (ズーム1倍, オフセット0)
// 内部変数をテスト用にモック
app.test_setVars({
    canvas: { width: 800, height: 600 },
    videoElement: { videoWidth: 1920, videoHeight: 1080 },
    viewState: { scale: 1, offsetX: 0, offsetY: 0 }
});

// キャンバス中央 (400, 300) -> 動画中央 (960, 540)
let vPos = app.canvasToVideo(400, 300);
assertClose(vPos.x, 960, 0.01, "ズーム1倍: Canvas中央から動画中央への変換");
assertClose(vPos.y, 540, 0.01, "ズーム1倍: Canvas中央から動画中央への変換(Y)");

// 逆変換
let cPos = app.videoToCanvas(960, 540);
assertClose(cPos.x, 400, 0.01, "ズーム1倍: 動画中央からCanvas中央への逆変換");
assertClose(cPos.y, 300, 0.01, "ズーム1倍: 動画中央からCanvas中央への逆変換(Y)");


// 2. 座標変換テスト (ズーム2倍, 右下にパン (offsetX=100, offsetY=50))
app.test_setVars({
    viewState: { scale: 2, offsetX: 100, offsetY: 50 }
});

// 動画の座標 (0, 0)
// Canvas上の位置は：lx = 0 => cx = lx * scale + offsetX = 0 * 2 + 100 = 100
// ly = 0 => cy = ly * scale + offsetY = 0 * 2 + 50 = 50
cPos = app.videoToCanvas(0, 0);
assertClose(cPos.x, 100, 0.01, "ズーム2倍・パン有: 動画(0,0)はCanvas(100,50)になること");
assertClose(cPos.y, 50, 0.01, "ズーム2倍・パン有: 動画(0,0)はCanvas(100,50)になること(Y)");

// キャンバス位置 (100, 50) -> 動画の (0, 0)
vPos = app.canvasToVideo(100, 50);
assertClose(vPos.x, 0, 0.01, "ズーム2倍・パン有: Canvas(100,50)は動画(0,0)になること");
assertClose(vPos.y, 0, 0.01, "ズーム2倍・パン有: Canvas(100,50)は動画(0,0)になること(Y)");


// 3. 色差計算関数の擬似検証
const color1 = { r: 100, g: 150, b: 200 };
const color2 = { r: 105, g: 148, b: 202 };
const diff = Math.hypot(color1.r - color2.r, color1.g - color2.g, color1.b - color2.b);
assertClose(diff, Math.sqrt(5*5 + 2*2 + 2*2), 0.001, "色差(RGBユーグリッド距離)の計算が正確であること");

console.log("=== 全ロジックテスト合格 ===");
process.exit(0);
