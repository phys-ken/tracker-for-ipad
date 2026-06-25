// Physics Tracker - app.js
// iPadおよび各種ブラウザ向け動画解析ウェブアプリコアロジック

// --- 状態管理を一元化 ---
const appState = {
    videoElement: null,
    canvas: null,
    ctx: null,
    isPlaying: false,
    videoDuration: 0,
    videoFps: 30,
    fpsMeasured: false,    // 実測FPSが確定したか
    fpsManual: false,      // ユーザーが手動でFPSを上書きしたか
    isPreviewing: false,   // 読込直後のプレビュー再生中か
    currentFrame: 0,
    totalFrames: 0,
    viewState: { scale: 1, offsetX: 0, offsetY: 0 },
    // 中央十字＋確定方式: 通常はトラッキング。原点/スケール設定中だけ pendingCapture が立つ
    pendingCapture: null, // null | 'origin' | 'scale'
    trackingData: [], // [{ id, frame, time, x, y, objectId }]
    activeObjectId: 1,
    trackingStepSize: 1,
    calibration: {
        origin: null,         // { x, y } (動画ピクセル座標)
        scaleRatio: null,     // cm/px
        scaleStart: null,     // { x, y }
        scaleEnd: null,       // { x, y }
        scaleActual: 0,       // cm
        scaleTempStart: null  // 一時始点
    },
    targetColor: null,        // { r, g, b } サンプリングされた色
    isAutoTracking: false,    // 自動追跡実行フラグ
    selectedPointId: null     // 現在選択されているトラックポイントのID
};

// グローバル（window）に公開してテストスイートからアクセス可能にする
window.appState = appState;

// カラーマップ (10色)
const COLOR_MAP = [
    '#ff4757', // 赤
    '#2ed573', // 緑
    '#1e90ff', // 青
    '#ffa502', // オレンジ
    '#eccc68', // 黄色
    '#ff6b81', // ピンク
    '#70a1ff', // 水色
    '#7bed9f', // 黄緑
    '#a29bfe', // 紫
    '#000000'  // 黒
];

// オートトラッカー用内部Canvas
let offscreenCanvas = null;
let offscreenCtx = null;

// ピンチズーム操作時の前フレーム状態保持用変数 (吸い付きズーム用)
let activePointers = []; // Pointer Events 用の配列
let lastPointerPos = null; // ドラッグパン用の一時座標
let lastPinchDist = 0;
let lastPinchCenter = null;
let isPanning = false;
let isDraggingPoint = false;
let draggedPointIndex = -1;

// デバッグ用ログ出力
function logDebug(message) {
    const logList = document.getElementById('debug-log-list');
    if (!logList) return;
    const item = document.createElement('div');
    item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logList.appendChild(item);
    logList.scrollTop = logList.scrollHeight;
    console.log(message);
}

// --- Undo 履歴 ＆ 自動保存 -------------------------------------------------
// （UndoボタンのUI配線・手順ガイド等の本格対応は Stage4。ここでは中核のみ）
const undoStack = [];
const UNDO_LIMIT = 50;
const STORAGE_KEY = 'tracker_for_ipad_state_v1';

// 変更直前の状態をスナップショットして履歴に積む
function pushHistory() {
    try {
        undoStack.push(JSON.stringify({
            trackingData: appState.trackingData,
            calibration: appState.calibration
        }));
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    } catch (e) { /* 容量超過などは無視 */ }
    updateUndoButton();
}

function undo() {
    const snap = undoStack.pop();
    if (!snap) return;
    try {
        const obj = JSON.parse(snap);
        appState.trackingData = obj.trackingData || [];
        appState.calibration = obj.calibration || appState.calibration;
        setSelectedPoint(null);
        refreshCalibrationLabels();
        persistState();
        updateDataTable();
        drawVideoFrame();
        updateGraph();
        logDebug('元に戻しました');
    } catch (e) { logDebug('Undo失敗'); }
    updateUndoButton();
}

function updateUndoButton() {
    const btn = document.getElementById('btn-undo');
    if (btn) btn.disabled = undoStack.length === 0;
}

// localStorage への自動保存（動画自体は保存せず、計測データと校正のみ）
function persistState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            trackingData: appState.trackingData,
            calibration: appState.calibration,
            videoFps: appState.videoFps,
            trackingStepSize: appState.trackingStepSize,
            activeObjectId: appState.activeObjectId
        }));
    } catch (e) { /* プライベートモード等では無視 */ }
}

function loadPersistedState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        const obj = JSON.parse(raw);
        if (Array.isArray(obj.trackingData) && obj.trackingData.length > 0) {
            appState.trackingData = obj.trackingData;
            if (obj.calibration) appState.calibration = obj.calibration;
            if (obj.videoFps) appState.videoFps = obj.videoFps;
            if (obj.trackingStepSize) appState.trackingStepSize = obj.trackingStepSize;
            if (obj.activeObjectId) appState.activeObjectId = obj.activeObjectId;
            return true;
        }
    } catch (e) { /* 破損データは無視 */ }
    return false;
}

// 校正ラベル（原点/スケール表示）を現在の状態に同期
function refreshCalibrationLabels() {
    const o = appState.calibration.origin;
    const infoO = document.getElementById('info-origin');
    if (infoO) infoO.textContent = o ? `(${o.x.toFixed(0)}, ${o.y.toFixed(0)})` : '未設定';
    const infoS = document.getElementById('info-scale');
    if (infoS) infoS.textContent = appState.calibration.scaleRatio ? `${appState.calibration.scaleRatio.toFixed(3)} cm/px` : '未設定';
}

// --- DOM初期化 ---
document.addEventListener('DOMContentLoaded', () => {
    logDebug("アプリケーション起動");
    
    appState.videoElement = document.getElementById('hidden-video');
    appState.canvas = document.getElementById('tracker-canvas');
    appState.ctx = appState.canvas.getContext('2d');
    
    // 各種初期化
    setupFileUpload();
    setupSampleLoad();
    setupPlaybackControls();
    setupDebugConsole();
    setupCanvasTouch();
    setupModeButtons();
    setupSettingsInputs();
    setupExport();
    setupAutoTrackerUI();
    setupGraphEvents();
    setupDeletionEvent();
    setupUndo();
    setupFpsInput();

    // ウィンドウリサイズ時の処理
    window.addEventListener('resize', handleResize);
    window.addEventListener('resize', updateGraph);

    // 前回の作業（計測データ・校正）を自動復帰。動画は再選択が必要。
    if (loadPersistedState()) {
        logDebug("前回の計測データを復帰しました（動画は読み込み直してください）。");
        refreshCalibrationLabels();
        updateDataTable();
        updateGraph();
    }
    updateUndoButton();
    updateActionHint();
    updateStepGuide();
    refreshFpsUI();

    // 空スタート: 動画はユーザーが「動画を選択」または「サンプルで試す」で読み込む
    logDebug("起動完了。動画を読み込んでください。");
});

// --- サンプル動画の読み込み（fetch経由のバックドア） ---
// 生徒の「お試し」用 兼 自動テスト用。アップロードダイアログを回避して
// サーバ上の sample.mp4 を直接 Blob 化して読み込む。
function setupSampleLoad() {
    const btn = document.getElementById('btn-load-sample');
    if (btn) btn.addEventListener('click', loadSampleVideo);
}

function loadSampleVideo() {
    logDebug("サンプル動画 (sample.mp4) を読み込みます...");
    fetch('sample.mp4')
        .then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.blob();
        })
        .then(blob => {
            if (appState.videoElement.src && appState.videoElement.src.startsWith('blob:')) {
                URL.revokeObjectURL(appState.videoElement.src);
            }
            const url = URL.createObjectURL(blob);
            const hintOverlay = document.getElementById('hint-overlay');
            if (hintOverlay) hintOverlay.style.opacity = '0';
            appState.fpsManual = false;
            appState.fpsMeasured = false;
            appState.videoElement.src = url;
            appState.videoElement.load();
        })
        .catch(err => logDebug(`サンプル読み込み失敗: ${err.message}（ローカルサーバ経由で開いてください）`));
}

function setupUndo() {
    const btn = document.getElementById('btn-undo');
    if (btn) btn.addEventListener('click', undo);
}

// --- デバッグコンソールのトグル ---
function setupDebugConsole() {
    const btnToggle = document.getElementById('btn-toggle-debug');
    const consoleDiv = document.getElementById('debug-console');
    const btnClear = document.getElementById('btn-clear-debug');
    
    if (btnToggle && consoleDiv) {
        btnToggle.addEventListener('click', () => {
            consoleDiv.style.display = consoleDiv.style.display === 'none' ? 'flex' : 'none';
        });
    }
    
    if (btnClear) {
        btnClear.addEventListener('click', () => {
            const logList = document.getElementById('debug-log-list');
            if (logList) logList.innerHTML = '';
        });
    }
}

// --- 動画のアップロード・ロード ---
function setupFileUpload() {
    const uploadInput = document.getElementById('video-upload');
    const hintOverlay = document.getElementById('hint-overlay');
    
    if (uploadInput) {
        uploadInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            logDebug(`ファイル選択: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`);
            
            if (appState.videoElement.src && appState.videoElement.src.startsWith('blob:')) {
                URL.revokeObjectURL(appState.videoElement.src);
            }
            
            const fileUrl = URL.createObjectURL(file);
            if (hintOverlay) hintOverlay.style.opacity = '0';

            // 新しい動画では実FPSを測り直す
            appState.fpsManual = false;
            appState.fpsMeasured = false;
            appState.videoElement.src = fileUrl;
            appState.videoElement.load();
        });
    }
    
    appState.videoElement.addEventListener('loadedmetadata', () => {
        appState.videoDuration = appState.videoElement.duration;
        appState.totalFrames = Math.floor(appState.videoDuration * appState.videoFps);
        appState.currentFrame = 0;
        
        logDebug(`動画ロード完了: 長さ ${appState.videoDuration.toFixed(2)}s, 総フレーム数 ${appState.totalFrames} (FPS: ${appState.videoFps})`);
        
        const slider = document.getElementById('frame-slider');
        if (slider) {
            slider.disabled = false;
            slider.max = appState.totalFrames;
            slider.value = 0;
        }
        
        refreshFpsUI();
        updateTimeDisplay();
        handleResize();
        updateGraph();
        updateStepGuide();

        // 読込直後に1回プレビュー再生し、その間に実FPSを測定して先頭へ戻る
        startPreviewAndMeasureFps();
    });
    
    appState.videoElement.addEventListener('canplay', () => {
        updateOffscreenCanvas();
        drawVideoFrame();
    });
    
    appState.videoElement.addEventListener('seeked', () => {
        updateOffscreenCanvas();
        drawVideoFrame();
        updateTimeDisplay();
        const lblFrame = document.getElementById('lbl-frame');
        if (lblFrame) lblFrame.textContent = appState.currentFrame;
    });
    
    appState.videoElement.addEventListener('error', () => {
        logDebug(`動画エラー発生: ${appState.videoElement.error ? appState.videoElement.error.message : 'Unknown'}`);
    });
}

// --- FPS実測 ＆ 読込直後プレビュー -----------------------------------------
// requestVideoFrameCallback でフレーム提示時刻を測り、実FPSを確定する。
// 同時に動画を1回プレビュー再生し、終わったら（または停止されたら）先頭に戻る。
let previewSamples = [];
let previewLastMediaTime = null;
let rvfcSupported = typeof HTMLVideoElement !== 'undefined'
    && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

function startPreviewAndMeasureFps() {
    const v = appState.videoElement;
    if (!v || v.readyState < 1) return;

    previewSamples = [];
    previewLastMediaTime = null;
    appState.isPreviewing = true;

    const onPreviewEnded = () => {
        v.removeEventListener('ended', onPreviewEnded);
        finalizePreview(true); // 末尾まで再生 → 先頭へ戻す
    };
    v.addEventListener('ended', onPreviewEnded);

    // rVFC でフレーム間隔を測定（対応ブラウザのみ）
    if (rvfcSupported && !appState.fpsManual) {
        const onFrame = (now, meta) => {
            if (previewLastMediaTime !== null) {
                const dt = meta.mediaTime - previewLastMediaTime;
                if (dt > 0.0003 && dt < 1) previewSamples.push(dt);
            }
            previewLastMediaTime = meta.mediaTime;
            if (appState.isPreviewing && !v.paused && !v.ended) {
                v.requestVideoFrameCallback(onFrame);
            }
        };
        v.requestVideoFrameCallback(onFrame);
    }

    // ミュート再生（iPad/Safariでも playsinline muted なら自動再生可）
    v.currentTime = 0;
    const p = v.play();
    if (p && p.catch) {
        p.then(() => { appState.isPlaying = true; setPlayPauseIcon(true); requestAnimationFrame(renderLoop); })
         .catch(() => { logDebug('自動プレビュー再生は不可。先頭フレームを表示します。'); finalizePreview(true); });
    } else {
        appState.isPlaying = true; setPlayPauseIcon(true); requestAnimationFrame(renderLoop);
    }
    logDebug('プレビュー再生＋FPS実測を開始しました。');
}

// プレビュー終了処理。returnToStart=true なら先頭フレームへ。
function finalizePreview(returnToStart) {
    if (!appState.isPreviewing) return;
    appState.isPreviewing = false;

    const v = appState.videoElement;
    v.pause();
    appState.isPlaying = false;
    setPlayPauseIcon(false);

    // FPSを確定（実測サンプルが十分あれば）
    if (!appState.fpsManual && previewSamples.length >= 4) {
        const fps = fpsFromSamples(previewSamples);
        if (fps) {
            appState.videoFps = fps;
            appState.fpsMeasured = true;
            appState.totalFrames = Math.max(0, Math.floor(appState.videoDuration * fps));
            logDebug(`実測FPS: ${fps}（${previewSamples.length}フレームから推定）`);
        }
    }
    refreshFpsUI();
    const slider = document.getElementById('frame-slider');
    if (slider) slider.max = appState.totalFrames;

    if (returnToStart) {
        seekToFrame(0);
    } else {
        appState.currentFrame = Math.round(v.currentTime * appState.videoFps);
        const slider2 = document.getElementById('frame-slider');
        if (slider2) slider2.value = appState.currentFrame;
        updateTimeDisplay();
    }
    persistState();
}

// フレーム間隔サンプルの中央値からFPSを推定。近ければ常用値にスナップ。
function fpsFromSamples(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (!median || median <= 0) return null;
    let fps = 1 / median;
    const common = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 120, 240];
    let best = null, bestErr = 0.03; // 3%以内で最も近い常用値にスナップ
    for (const c of common) {
        const err = Math.abs(fps - c) / c;
        if (err < bestErr) { bestErr = err; best = c; }
    }
    if (best !== null) return Math.round(best * 1000) / 1000;
    return Math.round(fps * 100) / 100;
}

// FPS表示（インジケータ＋入力欄）を現在値に同期
function refreshFpsUI() {
    const lbl = document.getElementById('lbl-fps');
    if (lbl) lbl.textContent = appState.videoFps + (appState.fpsMeasured && !appState.fpsManual ? '' : '*');
    const input = document.getElementById('fps-input');
    if (input && document.activeElement !== input) input.value = appState.videoFps;
}

// 手動FPS上書き
function setFpsManual(val) {
    const fps = parseFloat(val);
    if (isNaN(fps) || fps <= 0) { refreshFpsUI(); return; }
    appState.videoFps = Math.round(fps * 100) / 100;
    appState.fpsManual = true;
    appState.fpsMeasured = false;
    if (appState.videoDuration) {
        appState.totalFrames = Math.max(0, Math.floor(appState.videoDuration * appState.videoFps));
        const slider = document.getElementById('frame-slider');
        if (slider) slider.max = appState.totalFrames;
    }
    // 既存点の時刻を新FPSで再計算
    appState.trackingData.forEach(p => { p.time = p.frame / appState.videoFps; });
    refreshFpsUI();
    persistState();
    updateDataTable();
    updateGraph();
    logDebug(`FPSを手動設定: ${appState.videoFps}`);
}

function setupFpsInput() {
    const input = document.getElementById('fps-input');
    if (input) {
        input.addEventListener('change', (e) => setFpsManual(e.target.value));
    }
}

// 再生/一時停止アイコンの切替（共通化）
function setPlayPauseIcon(playing) {
    const btnPlay = document.getElementById('btn-play-pause');
    if (btnPlay) {
        const span = btnPlay.querySelector('span');
        if (span) span.textContent = playing ? 'pause' : 'play_arrow';
    }
}

// --- オフスクリーン Canvas の更新 ---
function updateOffscreenCanvas() {
    if (!appState.videoElement || appState.videoElement.readyState < 2) return;
    if (!offscreenCanvas) {
        offscreenCanvas = document.createElement('canvas');
        offscreenCtx = offscreenCanvas.getContext('2d');
    }
    if (offscreenCanvas.width !== appState.videoElement.videoWidth || offscreenCanvas.height !== appState.videoElement.videoHeight) {
        offscreenCanvas.width = appState.videoElement.videoWidth;
        offscreenCanvas.height = appState.videoElement.videoHeight;
    }
    offscreenCtx.drawImage(appState.videoElement, 0, 0);
}

// --- コマ送り・シークなどのコントロール ---
function setupPlaybackControls() {
    const btnPlay = document.getElementById('btn-play-pause');
    const btnPrev1 = document.getElementById('btn-prev-1');
    const btnNext1 = document.getElementById('btn-next-1');
    const btnPrev10 = document.getElementById('btn-prev-10');
    const btnNext10 = document.getElementById('btn-next-10');
    const slider = document.getElementById('frame-slider');
    
    if (btnPlay) {
        btnPlay.addEventListener('click', () => {
            if (!appState.videoElement.src) return;
            if (appState.isPlaying) {
                pauseVideo();
            } else {
                playVideo();
            }
        });
    }
    
    if (btnPrev1) btnPrev1.addEventListener('click', () => stepFrame(-1));
    if (btnNext1) btnNext1.addEventListener('click', () => stepFrame(1));
    if (btnPrev10) btnPrev10.addEventListener('click', () => stepFrame(-10));
    if (btnNext10) btnNext10.addEventListener('click', () => stepFrame(10));
    
    if (slider) {
        slider.addEventListener('input', (e) => {
            const targetFrame = parseInt(e.target.value);
            seekToFrame(targetFrame);
        });
    }
}

function stepFrame(delta) {
    if (!appState.videoElement.src) return;
    pauseVideo();
    const targetFrame = Math.max(0, Math.min(appState.totalFrames, appState.currentFrame + delta));
    seekToFrame(targetFrame);
}

function seekToFrame(frame) {
    appState.currentFrame = Math.max(0, Math.min(appState.totalFrames, frame));
    // フレーム中央時刻を狙うと、境界でのデコードずれ（特にSafari/iPad）を避けやすい
    const targetTime = (appState.currentFrame + 0.5) / appState.videoFps;
    appState.videoElement.currentTime = Math.min(appState.videoDuration - 0.001, Math.max(0, targetTime));

    const slider = document.getElementById('frame-slider');
    if (slider) slider.value = appState.currentFrame;
}

function playVideo() {
    appState.isPlaying = true;
    setPlayPauseIcon(true);
    appState.videoElement.play();
    logDebug("再生開始");
    requestAnimationFrame(renderLoop);
}

function pauseVideo() {
    // プレビュー再生中の一時停止は「プレビュー終了（その場で停止）」として扱う
    if (appState.isPreviewing) {
        finalizePreview(false);
        return;
    }
    appState.isPlaying = false;
    setPlayPauseIcon(false);
    appState.videoElement.pause();
    logDebug("一時停止");
}

function renderLoop() {
    if (!appState.isPlaying) return;
    
    appState.currentFrame = Math.floor(appState.videoElement.currentTime * appState.videoFps);
    const slider = document.getElementById('frame-slider');
    if (slider) slider.value = appState.currentFrame;
    
    const lblFrame = document.getElementById('lbl-frame');
    if (lblFrame) lblFrame.textContent = appState.currentFrame;
    
    updateOffscreenCanvas();
    drawVideoFrame();
    updateTimeDisplay();
    
    if (!appState.videoElement.paused && !appState.videoElement.ended) {
        requestAnimationFrame(renderLoop);
    } else if (appState.videoElement.ended) {
        pauseVideo();
    }
}

// タイム表示の更新
function updateTimeDisplay() {
    const timeDisplay = document.getElementById('time-display');
    if (!timeDisplay) return;
    
    // フレーム基準の時刻（中央シークの+0.5ぶんを表示に出さない）
    const curSec = appState.isPreviewing
        ? appState.videoElement.currentTime
        : appState.currentFrame / appState.videoFps;
    const durSec = appState.videoDuration;
    
    const format = (sec) => {
        const m = Math.floor(sec / 60).toString().padStart(2, '0');
        const s = Math.floor(sec % 60).toString().padStart(2, '0');
        const ms = Math.floor((sec % 1) * 100).toString().padStart(2, '0');
        return `${m}:${s}.${ms}`;
    };
    
    timeDisplay.textContent = `${format(curSec)} / ${format(durSec)}`;
}

// Canvasリサイズ処理
function handleResize() {
    const container = document.getElementById('canvas-container');
    if (!container || !appState.videoElement.src || appState.videoElement.videoWidth === 0) return;
    
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    
    const vWidth = appState.videoElement.videoWidth;
    const vHeight = appState.videoElement.videoHeight;
    
    const scale = Math.min(containerWidth / vWidth, containerHeight / vHeight);
    
    appState.canvas.width = vWidth * scale;
    appState.canvas.height = vHeight * scale;
    
    logDebug(`Canvasリサイズ: ${appState.canvas.width.toFixed(0)}x${appState.canvas.height.toFixed(0)} (Video: ${vWidth}x${vHeight})`);
    
    drawVideoFrame();
}

// --- Canvasへの描画処理 ---
function drawVideoFrame() {
    if (!appState.videoElement.src || appState.videoElement.readyState < 2) return;
    
    appState.ctx.clearRect(0, 0, appState.canvas.width, appState.canvas.height);
    
    appState.ctx.save();
    // アフィン変換の適用
    appState.ctx.translate(appState.viewState.offsetX, appState.viewState.offsetY);
    appState.ctx.scale(appState.viewState.scale, appState.viewState.scale);
    
    // 動画フレームの描画
    appState.ctx.drawImage(appState.videoElement, 0, 0, appState.canvas.width, appState.canvas.height);
    
    // キャリブレーションマーカーとトラックポイントの描画
    drawCalibrationMarkers();
    drawTrackingPoints();

    appState.ctx.restore();

    // 画面中央の固定十字（スクリーン座標・ズーム非依存）
    drawCrosshair();
}

// --- 中央十字（照準）の描画 ---
function drawCrosshair() {
    const ctx = appState.ctx;
    const cx = appState.canvas.width / 2;
    const cy = appState.canvas.height / 2;
    const isCalib = appState.pendingCapture !== null;
    // 照準 = シグナル・アンバー（ストロボ発光）。校正中は校正系のシアン。
    const color = isCalib ? '#5AA9E6' : '#FFB627';

    ctx.save();
    ctx.lineWidth = 1.5;

    // 外側の縁取り（白）で視認性確保
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 3;
    drawReticlePath(ctx, cx, cy);
    ctx.stroke();

    // 本体
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    drawReticlePath(ctx, cx, cy);
    ctx.stroke();

    // 中心の小さなドット
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
}

function drawReticlePath(ctx, cx, cy) {
    const gap = 6;   // 中心の空き
    const len = 16;  // 線の長さ
    const r = 14;    // 円の半径
    ctx.beginPath();
    // 上下左右の線（中心を空ける）
    ctx.moveTo(cx, cy - gap); ctx.lineTo(cx, cy - gap - len);
    ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + gap + len);
    ctx.moveTo(cx - gap, cy); ctx.lineTo(cx - gap - len, cy);
    ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + gap + len, cy);
    // 円
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
}

// --- 座標変換関数 ---
function canvasToVideo(cx, cy) {
    const lx = (cx - appState.viewState.offsetX) / appState.viewState.scale;
    const ly = (cy - appState.viewState.offsetY) / appState.viewState.scale;
    
    const vWidth = appState.videoElement ? appState.videoElement.videoWidth : 1;
    const vHeight = appState.videoElement ? appState.videoElement.videoHeight : 1;
    const cWidth = appState.canvas ? appState.canvas.width : 1;
    const cHeight = appState.canvas ? appState.canvas.height : 1;
    
    const vx = lx * (vWidth / cWidth);
    const vy = ly * (vHeight / cHeight);
    return { x: vx, y: vy };
}

function videoToCanvas(vx, vy) {
    const local = videoToLocalCanvas(vx, vy);
    
    const cx = local.x * appState.viewState.scale + appState.viewState.offsetX;
    const cy = local.y * appState.viewState.scale + appState.viewState.offsetY;
    return { x: cx, y: cy };
}

// 動画座標からCanvasローカル座標([0, canvas.width] x [0, canvas.height])へのスケール変換
function videoToLocalCanvas(vx, vy) {
    const vWidth = appState.videoElement ? appState.videoElement.videoWidth : 1;
    const vHeight = appState.videoElement ? appState.videoElement.videoHeight : 1;
    const cWidth = appState.canvas ? appState.canvas.width : 1;
    const cHeight = appState.canvas ? appState.canvas.height : 1;
    
    const lx = vx * (cWidth / vWidth);
    const ly = vy * (cHeight / vHeight);
    return { x: lx, y: ly };
}

// --- Pointer Events によるズーム・パン、ドラッグ ---
function setupCanvasTouch() {
    appState.canvas.addEventListener('pointerdown', handlePointerDown);
    appState.canvas.addEventListener('pointermove', handlePointerMove);
    appState.canvas.addEventListener('pointerup', handlePointerUp);
    appState.canvas.addEventListener('pointercancel', handlePointerUp);
    appState.canvas.addEventListener('wheel', handleWheel, { passive: false });
}

function handlePointerDown(e) {
    e.preventDefault();
    appState.canvas.setPointerCapture(e.pointerId);
    
    activePointers.push({
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY
    });
    
    const rect = appState.canvas.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    
    if (activePointers.length === 1) {
        // 1本指は常に映像のパン（点打ちは「確定」ボタンに集約）
        lastPointerPos = { x: localX, y: localY };
        isPanning = false;
    } else if (activePointers.length === 2) {
        const p1 = activePointers[0];
        const p2 = activePointers[1];
        
        const p1Local = { x: p1.x - rect.left, y: p1.y - rect.top };
        const p2Local = { x: p2.x - rect.left, y: p2.y - rect.top };
        
        lastPinchDist = Math.hypot(p1Local.x - p2Local.x, p1Local.y - p2Local.y);
        lastPinchCenter = {
            x: (p1Local.x + p2Local.x) / 2,
            y: (p1Local.y + p2Local.y) / 2
        };
        isPanning = true;
        logDebug("ピンチ開始（吸い付きズーム有効）");
    }
}

function handlePointerMove(e) {
    e.preventDefault();
    const pointer = activePointers.find(p => p.id === e.pointerId);
    if (!pointer) return;
    
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    
    const rect = appState.canvas.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    
    if (activePointers.length === 1) {
        // 1本指ドラッグ = 映像のパン（十字に対象を合わせるための操作）
        if (lastPointerPos) {
            const dx = localX - lastPointerPos.x;
            const dy = localY - lastPointerPos.y;
            appState.viewState.offsetX += dx;
            appState.viewState.offsetY += dy;
            lastPointerPos = { x: localX, y: localY };
            drawVideoFrame();
        }
    } else if (activePointers.length === 2 && isPanning) {
        const p1 = activePointers[0];
        const p2 = activePointers[1];
        
        const p1Local = { x: p1.x - rect.left, y: p1.y - rect.top };
        const p2Local = { x: p2.x - rect.left, y: p2.y - rect.top };
        
        const currentDist = Math.hypot(p1Local.x - p2Local.x, p1Local.y - p2Local.y);
        const currentCenter = {
            x: (p1Local.x + p2Local.x) / 2,
            y: (p1Local.y + p2Local.y) / 2
        };
        
        if (lastPinchDist > 0 && lastPinchCenter) {
            const dScale = currentDist / lastPinchDist;
            let newScale = appState.viewState.scale * dScale;
            newScale = Math.max(0.5, Math.min(10, newScale));
            
            const actualRatio = newScale / appState.viewState.scale;
            const dx = currentCenter.x - lastPinchCenter.x;
            const dy = currentCenter.y - lastPinchCenter.y;
            
            appState.viewState.offsetX = currentCenter.x - (currentCenter.x - appState.viewState.offsetX) * actualRatio + dx;
            appState.viewState.offsetY = currentCenter.y - (currentCenter.y - appState.viewState.offsetY) * actualRatio + dy;
            appState.viewState.scale = newScale;
            
            drawVideoFrame();
        }
        
        lastPinchDist = currentDist;
        lastPinchCenter = currentCenter;
    }
}

function handlePointerUp(e) {
    appState.canvas.releasePointerCapture(e.pointerId);
    activePointers = activePointers.filter(p => p.id !== e.pointerId);
    
    if (activePointers.length < 2) {
        isPanning = false;
        lastPinchDist = 0;
        lastPinchCenter = null;
    }
    
    const rect = appState.canvas.getBoundingClientRect();
    if (activePointers.length === 1) {
        const p = activePointers[0];
        lastPointerPos = { x: p.x - rect.left, y: p.y - rect.top };
    } else if (activePointers.length === 0) {
        lastPointerPos = null;
        if (isDraggingPoint) {
            isDraggingPoint = false;
            draggedPointIndex = -1;
            logDebug("ドラッグ完了");
        }
    }
}

function handleWheel(e) {
    e.preventDefault();
    const zoomIntensity = 0.08;
    const rect = appState.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const wheel = e.deltaY < 0 ? 1 : -1;
    const zoomFactor = Math.exp(wheel * zoomIntensity);
    
    const oldScale = appState.viewState.scale;
    let newScale = oldScale * zoomFactor;
    newScale = Math.max(0.5, Math.min(10, newScale));
    
    const actualRatio = newScale / oldScale;
    
    appState.viewState.offsetX = mouseX - (mouseX - appState.viewState.offsetX) * actualRatio;
    appState.viewState.offsetY = mouseY - (mouseY - appState.viewState.offsetY) * actualRatio;
    appState.viewState.scale = newScale;
    
    drawVideoFrame();
}

function resetZoom() {
    appState.viewState = { scale: 1, offsetX: 0, offsetY: 0 };
    drawVideoFrame();
    logDebug("ズームリセット");
}

// --- 保留アクション（原点/スケール設定）の切替 ---
function setPendingCapture(mode) {
    appState.pendingCapture = mode;
    // スケール設定を抜けるときは一時始点をクリア
    if (mode !== 'scale') appState.calibration.scaleTempStart = null;

    const btnOrigin = document.getElementById('btn-set-origin');
    const btnScale = document.getElementById('btn-set-scale');
    if (btnOrigin) btnOrigin.classList.toggle('active', mode === 'origin');
    if (btnScale) btnScale.classList.toggle('active', mode === 'scale');

    updateActionHint();
    logDebug(`保留アクション: ${mode || 'なし（トラッキング）'}`);
}

// 確定ボタンのラベルと、今やるべき操作のヒントを更新
function updateActionHint() {
    const btnConfirm = document.getElementById('btn-confirm');
    const hint = document.getElementById('action-hint');
    let label = '確定（点を打つ）';
    let text = '十字を対象に合わせて「確定」';

    if (appState.pendingCapture === 'origin') {
        label = '原点をここに確定';
        text = '十字を原点に合わせて「確定」';
    } else if (appState.pendingCapture === 'scale') {
        if (appState.calibration.scaleTempStart) {
            label = 'スケール終点を確定';
            text = '十字を「既知の長さ」の終点に合わせて「確定」';
        } else {
            label = 'スケール始点を確定';
            text = '十字を「既知の長さ」の始点に合わせて「確定」';
        }
    }
    if (btnConfirm) {
        const span = btnConfirm.querySelector('.confirm-label');
        if (span) span.textContent = label;
    }
    if (hint) hint.textContent = text;
}

// 手順ガイド: 今やるべき最初の未完ステップを点灯する
function updateStepGuide() {
    const steps = document.querySelectorAll('.step-guide .step');
    if (!steps.length) return;
    const hasVideo = !!(appState.videoElement && appState.videoElement.src);
    const hasScale = !!appState.calibration.scaleRatio;
    const hasOrigin = !!appState.calibration.origin;
    const hasData = appState.trackingData.length > 0;

    let active = 0;                 // ① 動画
    if (hasVideo) active = 1;       // ② スケール
    if (hasVideo && hasScale) active = 2;            // ③ 原点
    if (hasVideo && hasScale && hasOrigin) active = 3; // ④ トラッキング
    if (hasVideo && hasData) active = Math.max(active, 3);
    if (hasVideo && hasData && hasScale && hasOrigin) active = 4; // ⑤ 出力（任意）

    steps.forEach((el, i) => el.classList.toggle('active', i === active));
}

function setupModeButtons() {
    const btnConfirm = document.getElementById('btn-confirm');
    const btnOrigin = document.getElementById('btn-set-origin');
    const btnScale = document.getElementById('btn-set-scale');
    const btnZoomReset = document.getElementById('btn-zoom-reset');

    if (btnConfirm) btnConfirm.addEventListener('click', confirmAtCrosshair);
    // 原点/スケールボタンはトグル: 押すと保留、もう一度押すとキャンセル
    if (btnOrigin) btnOrigin.addEventListener('click', () => {
        setPendingCapture(appState.pendingCapture === 'origin' ? null : 'origin');
    });
    if (btnScale) btnScale.addEventListener('click', () => {
        setPendingCapture(appState.pendingCapture === 'scale' ? null : 'scale');
    });
    if (btnZoomReset) btnZoomReset.addEventListener('click', resetZoom);
}

// 設定入力欄のイベント設定
function setupSettingsInputs() {
    const objIdInput = document.getElementById('object-id-select');
    const stepInput = document.getElementById('step-size-select');
    
    if (objIdInput) {
        objIdInput.addEventListener('change', (e) => {
            appState.activeObjectId = Math.max(1, parseInt(e.target.value) || 1);
            updateDataTable();
            drawVideoFrame();
            updateGraph();
            logDebug(`アクティブ物体ID: ${appState.activeObjectId}`);
        });
    }
    
    if (stepInput) {
        stepInput.addEventListener('change', (e) => {
            appState.trackingStepSize = Math.max(1, parseInt(e.target.value) || 1);
            logDebug(`ステップ幅: ${appState.trackingStepSize}`);
        });
    }
}

// --- 十字（画面中央）が指す動画座標を取得 ---
function getCrosshairVideoCoord() {
    return canvasToVideo(appState.canvas.width / 2, appState.canvas.height / 2);
}

// --- 「確定」ボタン: 十字位置を現在の保留アクションに応じて確定する ---
function confirmAtCrosshair() {
    if (!appState.videoElement.src || appState.videoElement.readyState < 2) {
        logDebug("動画が読み込まれていません。");
        return;
    }
    const vPos = getCrosshairVideoCoord();

    if (appState.pendingCapture === 'origin') {
        captureOrigin(vPos);
    } else if (appState.pendingCapture === 'scale') {
        captureScalePoint(vPos);
    } else {
        captureTrackPoint(vPos);
    }
}

// 通常: トラックポイントを現フレームに登録/上書きし、ステップ幅ぶん自動コマ送り
function captureTrackPoint(vPos) {
    pushHistory();
    const existingIndex = appState.trackingData.findIndex(p => p.frame === appState.currentFrame && p.objectId === appState.activeObjectId);
    const newPoint = {
        id: Date.now(),
        frame: appState.currentFrame,
        time: appState.currentFrame / appState.videoFps,
        x: vPos.x,
        y: vPos.y,
        objectId: appState.activeObjectId
    };

    if (existingIndex >= 0) {
        appState.trackingData[existingIndex] = newPoint;
    } else {
        appState.trackingData.push(newPoint);
    }

    appState.targetColor = sampleColor(vPos.x, vPos.y);
    if (appState.targetColor) {
        logDebug(`色をサンプリングしました: RGB(${appState.targetColor.r}, ${appState.targetColor.g}, ${appState.targetColor.b})`);
    }

    logDebug(`ポイント登録: Frame ${appState.currentFrame}, X: ${vPos.x.toFixed(1)}, Y: ${vPos.y.toFixed(1)}`);
    persistState();
    updateDataTable();
    drawVideoFrame();
    updateGraph();

    stepFrame(appState.trackingStepSize);
}

function captureOrigin(vPos) {
    appState.calibration.origin = { x: vPos.x, y: vPos.y };
    logDebug(`原点を設定しました: X: ${vPos.x.toFixed(1)}, Y: ${vPos.y.toFixed(1)}`);
    document.getElementById('info-origin').textContent = `(${vPos.x.toFixed(0)}, ${vPos.y.toFixed(0)})`;
    setPendingCapture(null);
    persistState();
    updateDataTable();
    drawVideoFrame();
    updateGraph();
}

function captureScalePoint(vPos) {
    const cal = appState.calibration;
    if (!cal.scaleTempStart) {
        cal.scaleTempStart = { x: vPos.x, y: vPos.y };
        logDebug("スケール始点を設定。十字を終点に合わせて、もう一度「確定」してください。");
        updateActionHint();
        drawVideoFrame();
        return;
    }
    const start = cal.scaleTempStart;
    const end = { x: vPos.x, y: vPos.y };
    const pixelDistance = Math.hypot(end.x - start.x, end.y - start.y);

    showInputDialog("スケール設定", `2点間の距離は ${pixelDistance.toFixed(1)} px です。実際の物理的距離を入力してください (cm):`, "100", (val) => {
        const actualDist = parseFloat(val);
        if (!isNaN(actualDist) && actualDist > 0) {
            cal.scaleRatio = actualDist / pixelDistance;
            cal.scaleStart = start;
            cal.scaleEnd = end;
            cal.scaleActual = actualDist;
            logDebug(`スケール設定完了: ${cal.scaleRatio.toFixed(4)} cm/px (実寸: ${actualDist} cm)`);
            document.getElementById('info-scale').textContent = `${cal.scaleRatio.toFixed(3)} cm/px`;
            persistState();
            updateDataTable();
            updateGraph();
        } else {
            logDebug("無効な距離が入力されました。");
        }
        cal.scaleTempStart = null;
        setPendingCapture(null);
        drawVideoFrame();
    });
}

// 選択ポイント状態の切り替え
function setSelectedPoint(id) {
    appState.selectedPointId = id;
    const btnDel = document.getElementById('btn-delete-selected');
    if (btnDel) {
        if (id !== null) {
            btnDel.disabled = false;
            btnDel.style.opacity = '1';
        } else {
            btnDel.disabled = true;
            btnDel.style.opacity = '0.5';
        }
    }
}

// 選択ポイント削除ボタンイベント設定
function setupDeletionEvent() {
    const btnDel = document.getElementById('btn-delete-selected');
    if (btnDel) {
        btnDel.addEventListener('click', () => {
            if (appState.selectedPointId !== null) {
                pushHistory();
                appState.trackingData = appState.trackingData.filter(p => p.id !== appState.selectedPointId);
                logDebug(`選択ポイント削除: ID ${appState.selectedPointId}`);
                setSelectedPoint(null);
                persistState();
                updateDataTable();
                drawVideoFrame();
                updateGraph();
            }
        });
    }
}

// --- 色サンプリングと色自動追跡 ---
function sampleColor(vx, vy) {
    if (!offscreenCtx) return null;
    
    const x = Math.round(vx);
    const y = Math.round(vy);
    const w = offscreenCanvas.width;
    const h = offscreenCanvas.height;
    
    if (x < 0 || x >= w || y < 0 || y >= h) return null;
    
    const radius = 2;
    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    
    const startX = Math.max(0, x - radius);
    const endX = Math.min(w - 1, x + radius);
    const startY = Math.max(0, y - radius);
    const endY = Math.min(h - 1, y + radius);
    
    const imgData = offscreenCtx.getImageData(startX, startY, (endX - startX) + 1, (endY - startY) + 1);
    const data = imgData.data;
    
    for (let i = 0; i < data.length; i += 4) {
        rSum += data[i];
        gSum += data[i+1];
        bSum += data[i+2];
        count++;
    }
    
    return {
        r: Math.round(rSum / count),
        g: Math.round(gSum / count),
        b: Math.round(bSum / count)
    };
}

function trackColorStep() {
    if (!appState.targetColor) {
        logDebug("追跡対象の色が設定されていません。トラックモードで一度ポイントをタップして色を登録してください。");
        return Promise.resolve(false);
    }
    
    const currentPoint = appState.trackingData.find(p => p.frame === appState.currentFrame && p.objectId === appState.activeObjectId);
    if (!currentPoint) {
        logDebug("現在のフレームに基準ポイントがありません。");
        return Promise.resolve(false);
    }
    
    const prevX = currentPoint.x;
    const prevY = currentPoint.y;
    const nextFrame = appState.currentFrame + appState.trackingStepSize;
    
    if (nextFrame > appState.totalFrames) {
        logDebug("動画の末尾に達しました。");
        return Promise.resolve(false);
    }
    
    return new Promise((resolve) => {
        const onSeeked = () => {
            appState.videoElement.removeEventListener('seeked', onSeeked);
            
            updateOffscreenCanvas();
            
            const winSize = parseInt(document.getElementById('track-window-size').value) || 60;
            const threshold = parseInt(document.getElementById('track-threshold').value) || 40;
            
            const w = offscreenCanvas.width;
            const h = offscreenCanvas.height;
            
            const startX = Math.max(0, Math.round(prevX - winSize / 2));
            const endX = Math.min(w - 1, Math.round(prevX + winSize / 2));
            const startY = Math.max(0, Math.round(prevY - winSize / 2));
            const endY = Math.min(h - 1, Math.round(prevY + winSize / 2));
            
            const rectW = endX - startX + 1;
            const rectH = endY - startY + 1;
            
            if (rectW <= 0 || rectH <= 0) {
                logDebug("探索窓が動画範囲外です。");
                resolve(false);
                return;
            }
            
            const imgData = offscreenCtx.getImageData(startX, startY, rectW, rectH);
            const data = imgData.data;
            
            let sumX = 0;
            let sumY = 0;
            let matchCount = 0;
            
            for (let y = startY; y <= endY; y++) {
                for (let x = startX; x <= endX; x++) {
                    const localX = x - startX;
                    const localY = y - startY;
                    const idx = (localY * rectW + localX) * 4;
                    
                    const r = data[idx];
                    const g = data[idx+1];
                    const b = data[idx+2];
                    
                    const dist = Math.hypot(r - appState.targetColor.r, g - appState.targetColor.g, b - appState.targetColor.b);
                    
                    if (dist <= threshold) {
                        sumX += x;
                        sumY += y;
                        matchCount++;
                    }
                }
            }
            
            if (matchCount > 0) {
                const nextX = sumX / matchCount;
                const nextY = sumY / matchCount;
                
                const existingIndex = appState.trackingData.findIndex(p => p.frame === appState.currentFrame && p.objectId === appState.activeObjectId);
                const newPoint = {
                    id: Date.now(),
                    frame: appState.currentFrame,
                    time: appState.currentFrame / appState.videoFps,
                    x: nextX,
                    y: nextY,
                    objectId: appState.activeObjectId
                };
                
                if (existingIndex >= 0) {
                    appState.trackingData[existingIndex] = newPoint;
                } else {
                    appState.trackingData.push(newPoint);
                }
                
                persistState();
                updateDataTable();
                drawVideoFrame();
                updateGraph();
                logDebug(`追跡成功: Frame ${appState.currentFrame}, X: ${nextX.toFixed(1)}, Y: ${nextY.toFixed(1)}`);
                resolve(true);
            } else {
                logDebug(`追跡失敗: 一致する色が探索窓内で見つかりませんでした (閾値: ${threshold})`);
                resolve(false);
            }
        };
        
        appState.videoElement.addEventListener('seeked', onSeeked);
        seekToFrame(nextFrame);
    });
}

async function runAutoTracking() {
    if (appState.isAutoTracking) return;
    
    appState.isAutoTracking = true;
    document.getElementById('btn-auto-track-run').style.display = 'none';
    document.getElementById('btn-auto-track-stop').style.display = 'inline-flex';
    logDebug("自動色追跡を開始しました。");
    
    while (appState.isAutoTracking) {
        const success = await trackColorStep();
        if (!success) {
            stopAutoTracking();
            break;
        }
        await new Promise(r => setTimeout(r, 100));
    }
}

function stopAutoTracking() {
    appState.isAutoTracking = false;
    document.getElementById('btn-auto-track-run').style.display = 'inline-flex';
    document.getElementById('btn-auto-track-stop').style.display = 'none';
    logDebug("自動色追跡を停止しました。");
}

function setupAutoTrackerUI() {
    const btnStep = document.getElementById('btn-auto-track-step');
    const btnRun = document.getElementById('btn-auto-track-run');
    const btnStop = document.getElementById('btn-auto-track-stop');
    const thresholdInput = document.getElementById('track-threshold');
    const lblThreshold = document.getElementById('lbl-threshold');
    
    if (btnStep) btnStep.addEventListener('click', trackColorStep);
    if (btnRun) btnRun.addEventListener('click', runAutoTracking);
    if (btnStop) btnStop.addEventListener('click', stopAutoTracking);
    
    if (thresholdInput && lblThreshold) {
        thresholdInput.addEventListener('input', (e) => {
            lblThreshold.textContent = e.target.value;
        });
    }
}

// --- マーカー描画 ---
function drawTrackingPoints() {
    const scale = appState.viewState.scale;
    const baseRadius = 6;
    const r = baseRadius / scale;
    
    appState.trackingData.forEach(p => {
        const local = videoToLocalCanvas(p.x, p.y);
        
        if (p.frame === appState.currentFrame) {
            // 選択されている場合はハイライト表示を追加
            if (p.id === appState.selectedPointId) {
                appState.ctx.beginPath();
                appState.ctx.arc(local.x, local.y, r * 1.6, 0, Math.PI * 2);
                appState.ctx.strokeStyle = '#d93025'; // 赤い強調外枠
                appState.ctx.lineWidth = 2.0 / scale;
                appState.ctx.stroke();
            }
            
            // 現在フレームのマーカー
            appState.ctx.beginPath();
            appState.ctx.arc(local.x, local.y, r, 0, Math.PI * 2);
            appState.ctx.fillStyle = COLOR_MAP[(p.objectId - 1) % COLOR_MAP.length];
            appState.ctx.fill();
            appState.ctx.strokeStyle = '#000000';
            appState.ctx.lineWidth = 1.5 / scale;
            appState.ctx.stroke();
            
            // 十字マーク
            appState.ctx.beginPath();
            appState.ctx.moveTo(local.x - r * 1.5, local.y);
            appState.ctx.lineTo(local.x + r * 1.5, local.y);
            appState.ctx.moveTo(local.x, local.y - r * 1.5);
            appState.ctx.lineTo(local.x, local.y + r * 1.5);
            appState.ctx.strokeStyle = '#ffffff';
            appState.ctx.lineWidth = 1.0 / scale;
            appState.ctx.stroke();
        } else {
            // 他のフレームの軌跡表示
            appState.ctx.beginPath();
            appState.ctx.arc(local.x, local.y, r * 0.4, 0, Math.PI * 2);
            appState.ctx.fillStyle = COLOR_MAP[(p.objectId - 1) % COLOR_MAP.length] + '55';
            appState.ctx.fill();
        }
    });
}

function drawCalibrationMarkers() {
    const scale = appState.viewState.scale;
    
    // 原点描画
    if (appState.calibration.origin) {
        const localO = videoToLocalCanvas(appState.calibration.origin.x, appState.calibration.origin.y);
        appState.ctx.beginPath();
        appState.ctx.moveTo(localO.x - 40 / scale, localO.y);
        appState.ctx.lineTo(localO.x + 40 / scale, localO.y);
        appState.ctx.moveTo(localO.x, localO.y - 40 / scale);
        appState.ctx.lineTo(localO.x, localO.y + 40 / scale);
        appState.ctx.strokeStyle = '#d93025';
        appState.ctx.lineWidth = 1.5 / scale;
        appState.ctx.stroke();
        
        appState.ctx.fillStyle = '#d93025';
        appState.ctx.font = `bold ${11 / scale}px IBM Plex Sans JP`;
        appState.ctx.fillText("x", localO.x + 45 / scale, localO.y + 4 / scale);
        appState.ctx.fillText("y", localO.x - 4 / scale, localO.y - 45 / scale);
    }
    
    // スケール描画
    if (appState.calibration.scaleStart && appState.calibration.scaleEnd) {
        const localS = videoToLocalCanvas(appState.calibration.scaleStart.x, appState.calibration.scaleStart.y);
        const localE = videoToLocalCanvas(appState.calibration.scaleEnd.x, appState.calibration.scaleEnd.y);
        
        appState.ctx.beginPath();
        appState.ctx.moveTo(localS.x, localS.y);
        appState.ctx.lineTo(localE.x, localE.y);
        appState.ctx.strokeStyle = '#5AA9E6';
        appState.ctx.lineWidth = 2.0 / scale;
        appState.ctx.stroke();
        
        const angle = Math.atan2(localE.y - localS.y, localE.x - localS.x);
        const perp = angle + Math.PI / 2;
        const barLen = 8 / scale;
        
        const drawEndBar = (pt) => {
            appState.ctx.beginPath();
            appState.ctx.moveTo(pt.x - Math.cos(perp) * barLen, pt.y - Math.sin(perp) * barLen);
            appState.ctx.lineTo(pt.x + Math.cos(perp) * barLen, pt.y + Math.sin(perp) * barLen);
            appState.ctx.stroke();
        };
        drawEndBar(localS);
        drawEndBar(localE);
        
        appState.ctx.fillStyle = '#5AA9E6';
        appState.ctx.font = `${11 / scale}px IBM Plex Sans JP`;
        const midX = (localS.x + localE.x) / 2;
        const midY = (localS.y + localE.y) / 2;
        appState.ctx.fillText(`${appState.calibration.scaleActual} cm`, midX + 10 / scale, midY - 10 / scale);
    } else if (appState.calibration.scaleTempStart) {
        const localTemp = videoToLocalCanvas(appState.calibration.scaleTempStart.x, appState.calibration.scaleTempStart.y);
        appState.ctx.beginPath();
        appState.ctx.arc(localTemp.x, localTemp.y, 5 / scale, 0, Math.PI * 2);
        appState.ctx.fillStyle = '#5AA9E6';
        appState.ctx.fill();
    }
}

// --- 測定データテーブルの更新 ---
function updateDataTable() {
    const tableBody = document.querySelector('#data-table tbody');
    if (!tableBody) return;
    
    tableBody.innerHTML = '';
    
    const filteredData = appState.trackingData
        .filter(p => p.objectId === appState.activeObjectId)
        .sort((a, b) => a.frame - b.frame);
        
    if (filteredData.length === 0) {
        tableBody.innerHTML = `<tr class="empty-row"><td colspan="4">データがありません</td></tr>`;
        updateStepGuide();
        return;
    }
    
    filteredData.forEach(p => {
        const tr = document.createElement('tr');
        
        let physX = p.x;
        let physY = p.y;
        
        if (appState.calibration.origin) {
            physX = p.x - appState.calibration.origin.x;
            physY = appState.calibration.origin.y - p.y; // Y軸反転
        }
        
        if (appState.calibration.scaleRatio) {
            physX *= appState.calibration.scaleRatio;
            physY *= appState.calibration.scaleRatio;
        }
        
        tr.innerHTML = `
            <td>${p.time.toFixed(3)}</td>
            <td>${physX.toFixed(1)}</td>
            <td>${physY.toFixed(1)}</td>
            <td>
                <button class="btn-danger-small" onclick="deletePoint(${p.id})">削除</button>
            </td>
        `;
        
        // 選択された行のスタイルを変更
        if (p.id === appState.selectedPointId) {
            tr.style.background = '#e8f0fe';
            tr.style.fontWeight = 'bold';
        }
        
        tr.addEventListener('click', (e) => {
            if (e.target.tagName !== 'BUTTON') {
                setSelectedPoint(p.id);
                seekToFrame(p.frame);
                drawVideoFrame();
                updateDataTable(); // 行選択の再描画
            }
        });
        
        tableBody.appendChild(tr);
    });

    updateStepGuide();
}

function deletePoint(id) {
    pushHistory();
    appState.trackingData = appState.trackingData.filter(p => p.id !== id);
    if (appState.selectedPointId === id) {
        setSelectedPoint(null);
    }
    persistState();
    updateDataTable();
    drawVideoFrame();
    updateGraph();
    logDebug(`ポイント削除: ID ${id}`);
}

window.deletePoint = deletePoint;

// --- リアルタイムグラフの描画 ---
function setupGraphEvents() {
    const selector = document.getElementById('graph-type-select');
    if (selector) {
        selector.addEventListener('change', updateGraph);
    }
}

function updateGraph() {
    const graphCanvas = document.getElementById('graph-canvas');
    if (!graphCanvas) return;
    
    // 親要素のサイズに Canvas の物理解像度をフィットさせる
    const container = graphCanvas.parentElement;
    if (container.clientWidth > 0 && container.clientHeight > 0) {
        graphCanvas.width = container.clientWidth;
        graphCanvas.height = container.clientHeight;
    }
    
    const gCtx = graphCanvas.getContext('2d');
    gCtx.clearRect(0, 0, graphCanvas.width, graphCanvas.height);
    
    const data = appState.trackingData
        .filter(p => p.objectId === appState.activeObjectId)
        .sort((a, b) => a.frame - b.frame);
        
    if (data.length === 0) {
        gCtx.fillStyle = '#7A828E';
        gCtx.font = '11px IBM Plex Sans JP';
        gCtx.textAlign = 'center';
        gCtx.textBaseline = 'middle';
        gCtx.fillText("測定が開始されると自動で描画されます", graphCanvas.width / 2, graphCanvas.height / 2);
        return;
    }
    
    const graphType = document.getElementById('graph-type-select').value; // 'y-t' | 'x-t' | 'y-x'
    
    // 物理座標変換ヘルパー
    const getPhysCoord = (p) => {
        let physX = p.x;
        let physY = p.y;
        if (appState.calibration.origin) {
            physX = p.x - appState.calibration.origin.x;
            physY = appState.calibration.origin.y - p.y;
        }
        if (appState.calibration.scaleRatio) {
            physX *= appState.calibration.scaleRatio;
            physY *= appState.calibration.scaleRatio;
        }
        return { x: physX, y: physY, t: p.time };
    };
    
    const points = data.map(getPhysCoord);
    
    let valX = [], valY = [];
    let labelX = "", labelY = "";
    const unit = appState.calibration.scaleRatio ? "cm" : "px";
    
    if (graphType === 'y-t') {
        valX = points.map(p => p.t);
        valY = points.map(p => p.y);
        labelX = "t (s)";
        labelY = `y (${unit})`;
    } else if (graphType === 'x-t') {
        valX = points.map(p => p.t);
        valY = points.map(p => p.x);
        labelX = "t (s)";
        labelY = `x (${unit})`;
    } else if (graphType === 'y-x') {
        valX = points.map(p => p.x);
        valY = points.map(p => p.y);
        labelX = `x (${unit})`;
        labelY = `y (${unit})`;
    }
    
    let minX = Math.min(...valX);
    let maxX = Math.max(...valX);
    let minY = Math.min(...valY);
    let maxY = Math.max(...valY);
    
    // 最大最小が一致する場合のフラット防止
    if (maxX === minX) { maxX += 1; minX -= 1; }
    if (maxY === minY) { maxY += 1; minY -= 1; }
    
    // マージン
    const padL = 35;
    const padR = 15;
    const padT = 15;
    const padB = 22;
    
    const plotW = graphCanvas.width - padL - padR;
    const plotH = graphCanvas.height - padT - padB;
    
    const toCanvasX = (val) => padL + ((val - minX) / (maxX - minX)) * plotW;
    const toCanvasY = (val) => padT + plotH - ((val - minY) / (maxY - minY)) * plotH;
    
    // グリッド背景線
    gCtx.strokeStyle = '#222933';
    gCtx.lineWidth = 1;
    
    // X軸の補助線と目盛りラベル
    const xSteps = 4;
    for (let i = 0; i <= xSteps; i++) {
        const ratio = i / xSteps;
        const val = minX + ratio * (maxX - minX);
        const cx = toCanvasX(val);
        
        gCtx.beginPath();
        gCtx.moveTo(cx, padT);
        gCtx.lineTo(cx, padT + plotH);
        gCtx.stroke();
        
        gCtx.fillStyle = '#7A828E';
        gCtx.font = '8px IBM Plex Mono';
        gCtx.textAlign = 'center';
        gCtx.fillText(val.toFixed(2), cx, padT + plotH + 11);
    }
    
    // Y軸の補助線と目盛りラベル
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
        const ratio = i / ySteps;
        const val = minY + ratio * (maxY - minY);
        const cy = toCanvasY(val);
        
        gCtx.beginPath();
        gCtx.moveTo(padL, cy);
        gCtx.lineTo(padL + plotW, cy);
        gCtx.stroke();
        
        gCtx.fillStyle = '#7A828E';
        gCtx.font = '8px IBM Plex Mono';
        gCtx.textAlign = 'right';
        gCtx.fillText(val.toFixed(1), padL - 5, cy + 3);
    }
    
    // 主軸線
    gCtx.strokeStyle = '#3A434F';
    gCtx.lineWidth = 1.2;
    gCtx.beginPath();
    gCtx.moveTo(padL, padT);
    gCtx.lineTo(padL, padT + plotH);
    gCtx.lineTo(padL + plotW, padT + plotH);
    gCtx.stroke();
    
    // 軸名ラベルの描画
    gCtx.fillStyle = '#9AA3AE';
    gCtx.font = '8px IBM Plex Sans JP';
    gCtx.textAlign = 'right';
    gCtx.fillText(labelX, graphCanvas.width - 4, graphCanvas.height - 4);
    gCtx.textAlign = 'left';
    gCtx.fillText(labelY, 4, 8);
    
    // 線グラフ描画
    gCtx.strokeStyle = COLOR_MAP[(appState.activeObjectId - 1) % COLOR_MAP.length];
    gCtx.lineWidth = 1.8;
    gCtx.beginPath();
    
    valX.forEach((vx, idx) => {
        const cx = toCanvasX(vx);
        const cy = toCanvasY(valY[idx]);
        if (idx === 0) {
            gCtx.moveTo(cx, cy);
        } else {
            gCtx.lineTo(cx, cy);
        }
    });
    gCtx.stroke();
    
    // ドットプロット描画
    valX.forEach((vx, idx) => {
        const cx = toCanvasX(vx);
        const cy = toCanvasY(valY[idx]);
        gCtx.beginPath();
        
        // 選択されたポイントはプロット上でも大きく表示する
        const isSel = (data[idx].id === appState.selectedPointId);
        gCtx.arc(cx, cy, isSel ? 4.5 : 3.0, 0, Math.PI * 2);
        gCtx.fillStyle = COLOR_MAP[(appState.activeObjectId - 1) % COLOR_MAP.length];
        gCtx.fill();
        gCtx.strokeStyle = isSel ? '#d93025' : '#ffffff';
        gCtx.lineWidth = isSel ? 1.5 : 1;
        gCtx.stroke();
    });
}

// --- エクスポート ---
function setupExport() {
    const btnExport = document.getElementById('btn-export');
    if (!btnExport) return;
    
    btnExport.addEventListener('click', () => {
        if (appState.trackingData.length === 0) {
            logDebug("エクスポートするデータがありません。");
            return;
        }
        
        let csvContent = "t (s)\tx (cm_or_px)\ty (cm_or_px)\tobject_id\n";
        
        const sorted = [...appState.trackingData].sort((a, b) => {
            if (a.objectId !== b.objectId) return a.objectId - b.objectId;
            return a.frame - b.frame;
        });
        
        sorted.forEach(p => {
            let physX = p.x;
            let physY = p.y;
            if (appState.calibration.origin) {
                physX = p.x - appState.calibration.origin.x;
                physY = appState.calibration.origin.y - p.y;
            }
            if (appState.calibration.scaleRatio) {
                physX *= appState.calibration.scaleRatio;
                physY *= appState.calibration.scaleRatio;
            }
            csvContent += `${p.time.toFixed(3)}\t${physX.toFixed(3)}\t${physY.toFixed(3)}\t${p.objectId}\n`;
        });
        
        const dialogText = `
            <textarea style="width:100%; height:130px; font-family:'IBM Plex Mono',monospace; background:#0F1216; color:#E6EAEF; border:1px solid #2B333D; border-radius:5px; padding:8px; font-size:0.8rem;" readonly>${csvContent}</textarea>
            <div style="margin-top:10px; display:flex; gap:8px;">
                <button class="btn btn-secondary" id="btn-copy-tsv" style="flex:1; font-size:0.8rem;">コピー</button>
                <button class="btn btn-primary" id="btn-download-tsv" style="flex:1; font-size:0.8rem;">ファイル保存</button>
            </div>
        `;
        
        showInputDialog("データエクスポート (TSV形式)", dialogText, "", () => {});
        
        document.getElementById('btn-copy-tsv').addEventListener('click', () => {
            navigator.clipboard.writeText(csvContent)
                .then(() => logDebug("TSVをコピーしました"))
                .catch(() => logDebug("コピー失敗"));
        });
        
        document.getElementById('btn-download-tsv').addEventListener('click', () => {
            const blob = new Blob([csvContent], { type: 'text/tab-separated-values;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.setAttribute("href", url);
            link.setAttribute("download", "tracking_data.tsv");
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            logDebug("TSVファイルをダウンロードしました");
        });
    });
}

// --- ダイアログの制御 ---
function showInputDialog(title, bodyText, defaultValue, onOk) {
    const overlay = document.getElementById('dialog-overlay');
    const titleEl = document.getElementById('dialog-title');
    const bodyEl = document.getElementById('dialog-body');
    const btnCancel = document.getElementById('dialog-btn-cancel');
    const btnOk = document.getElementById('dialog-btn-ok');
    
    if (!overlay) return;
    
    titleEl.textContent = title;
    
    if (bodyText.includes("<textarea>") || bodyText.includes("<input>")) {
        bodyEl.innerHTML = bodyText;
    } else {
        bodyEl.innerHTML = `
            <p>${bodyText}</p>
            <input type="text" id="dialog-input-val" value="${defaultValue}">
        `;
    }
    
    overlay.style.display = 'flex';
    
    const cleanup = () => {
        overlay.style.display = 'none';
        const newOk = btnOk.cloneNode(true);
        const newCancel = btnCancel.cloneNode(true);
        btnOk.parentNode.replaceChild(newOk, btnOk);
        btnCancel.parentNode.replaceChild(newCancel, btnCancel);
    };
    
    document.getElementById('dialog-btn-ok').addEventListener('click', () => {
        const inputEl = document.getElementById('dialog-input-val');
        const val = inputEl ? inputEl.value : "";
        cleanup();
        onOk(val);
    });
    
    document.getElementById('dialog-btn-cancel').addEventListener('click', () => {
        cleanup();
    });
}

// --- Node.js テスト用および統合テスト用エクスポート ---
window.canvasToVideo = canvasToVideo;
window.videoToCanvas = videoToCanvas;
window.videoToLocalCanvas = videoToLocalCanvas;
window.seekToFrame = seekToFrame;
window.stepFrame = stepFrame;
window.setPendingCapture = setPendingCapture;
window.confirmAtCrosshair = confirmAtCrosshair;
window.getCrosshairVideoCoord = getCrosshairVideoCoord;
window.resetZoom = resetZoom;
window.updateGraph = updateGraph;
window.deletePoint = deletePoint;
window.undo = undo;

if (typeof module !== 'undefined') {
    module.exports = {
        appState,
        canvasToVideo,
        videoToCanvas,
        videoToLocalCanvas,
        seekToFrame,
        stepFrame,
        sampleColor,
        test_setVars: (vars) => {
            if (vars.canvas !== undefined) appState.canvas = vars.canvas;
            if (vars.videoElement !== undefined) appState.videoElement = vars.videoElement;
            if (vars.viewState !== undefined) appState.viewState = vars.viewState;
            if (vars.calibration !== undefined) appState.calibration = vars.calibration;
            if (vars.trackingData !== undefined) appState.trackingData = vars.trackingData;
        }
    };
}
