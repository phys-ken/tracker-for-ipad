// Physics Tracker - tests/e2e.test.js
// 実Chrome(ヘッドレス)を DevTools Protocol で直接駆動する E2E テスト。
// Claude 拡張も Playwright も使わず、node v22+ 内蔵 WebSocket と既存 Chrome のみで動く。
//   実行:  node tests/e2e.test.js
// 動画を実デコードして「フレーム送りが実コマを重複なくたどるか」「canvas全面化」
// 「グラフ複数表示」「主要動線(読込→スケール→原点→トラック→出力)」を検証する。

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// ---------- 簡易アサーション ----------
let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; console.log('✅ PASS: ' + msg); }
    else { fail++; console.error('❌ FAIL: ' + msg); }
}
function close(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ~${b})`); }

// ---------- 静的サーバ (serve.py 非依存) ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.mp4': 'video/mp4', '.json': 'application/json' };
function startServer() {
    return new Promise(res => {
        const srv = http.createServer((req, resp) => {
            let p = decodeURIComponent(req.url.split('?')[0]);
            if (p === '/') p = '/index.html';
            const fp = path.join(ROOT, p);
            if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
                resp.writeHead(404); resp.end('not found'); return;
            }
            resp.writeHead(200, {
                'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
                'Cache-Control': 'no-cache'
            });
            resp.end(fs.readFileSync(fp));
        });
        srv.listen(0, '127.0.0.1', () => res(srv));
    });
}

// ---------- Chrome 起動 + CDP 接続 ----------
function launchChrome() {
    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-e2e-'));
    const proc = spawn(CHROME, [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${udd}`,
        '--no-first-run', '--no-default-browser-check',
        '--disable-gpu', '--mute-audio',
        '--autoplay-policy=no-user-gesture-required',
        'about:blank'
    ], { stdio: 'ignore' });
    return { proc, udd };
}
function readDevtoolsPort(udd, timeoutMs = 12000) {
    const f = path.join(udd, 'DevToolsActivePort');
    const t0 = Date.now();
    return new Promise((res, rej) => {
        const iv = setInterval(() => {
            if (fs.existsSync(f)) {
                const c = fs.readFileSync(f, 'utf8').split('\n');
                if (c[0]) { clearInterval(iv); res(parseInt(c[0], 10)); }
            } else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); rej(new Error('DevToolsActivePort 未生成')); }
        }, 100);
    });
}
function httpGet(url) {
    return new Promise((res, rej) => {
        http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
    });
}
function connectWS(wsUrl) {
    return new Promise((res, rej) => {
        const ws = new WebSocket(wsUrl);
        ws.addEventListener('open', () => res(ws));
        ws.addEventListener('error', () => rej(new Error('WebSocket 接続失敗')));
    });
}

class CDP {
    constructor(ws) {
        this.ws = ws; this.id = 0; this.pending = new Map();
        ws.addEventListener('message', ev => {
            const m = JSON.parse(ev.data);
            if (m.id && this.pending.has(m.id)) {
                const { resolve, reject } = this.pending.get(m.id);
                this.pending.delete(m.id);
                m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
            }
        });
    }
    send(method, params = {}, sessionId) {
        const id = ++this.id;
        const msg = { id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(msg));
        });
    }
}

// ---------- ページ内 JS 実行ヘルパ ----------
async function evalAsync(cdp, S, body) {
    const r = await cdp.send('Runtime.evaluate', {
        expression: `(async () => { ${body} })()`,
        awaitPromise: true, returnByValue: true
    }, S);
    if (r.exceptionDetails) {
        const ex = r.exceptionDetails.exception;
        throw new Error('ページ内例外: ' + (ex && (ex.description || ex.value) || JSON.stringify(r.exceptionDetails)));
    }
    return r.result.value;
}
const evalExpr = (cdp, S, expr) => evalAsync(cdp, S, `return (${expr});`);

async function waitUntil(cdp, S, expr, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (await evalExpr(cdp, S, expr)) return true;
        await new Promise(r => setTimeout(r, 150));
    }
    throw new Error(`待機タイムアウト: ${label || expr}`);
}

// ---------- メイン ----------
(async () => {
    console.log('=== E2E (実Chrome / DevTools Protocol) 開始 ===');
    const srv = await startServer();
    const base = `http://127.0.0.1:${srv.address().port}`;
    const { proc, udd } = launchChrome();
    let ws;
    try {
        const dport = await readDevtoolsPort(udd);
        const ver = JSON.parse(await httpGet(`http://127.0.0.1:${dport}/json/version`));
        ws = await connectWS(ver.webSocketDebuggerUrl);
        const cdp = new CDP(ws);
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId: S } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        await cdp.send('Page.enable', {}, S);
        await cdp.send('Runtime.enable', {}, S);
        // iPad 横向き相当の実ビューポートを与える（ヘッドレス既定は高さ0で崩れるため）
        await cdp.send('Emulation.setDeviceMetricsOverride',
            { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false }, S);

        await cdp.send('Page.navigate', { url: base + '/index.html' }, S);
        await waitUntil(cdp, S, `document.readyState==='complete' && typeof window.appState==='object'`, 10000, 'アプリ初期化');

        // --- サンプル動画を実デコードで読み込む ---
        // ボタンはサンプル選択ダイアログを開くようになったため、テストはバックドアを直接呼ぶ
        await evalExpr(cdp, S, `window.loadSampleVideo()`);
        await waitUntil(cdp, S, `window.appState.videoElement.readyState>=2 && window.appState.videoDuration>0`, 20000, '動画メタデータ');
        // プレビュー再生＋FPS実測＋フレーム時刻表構築の完了を待つ
        await waitUntil(cdp, S, `window.appState.isScanning===false && window.appState.totalFrames>0`, 30000, 'フレーム走査完了');

        const meta = await evalExpr(cdp, S, `({
            vw: appState.videoElement.videoWidth, vh: appState.videoElement.videoHeight,
            dur: +appState.videoDuration.toFixed(4), fps: appState.videoFps,
            totalFrames: appState.totalFrames, frameTimes: appState.frameTimes.length
        })`);
        console.log('  [info] video', meta.vw + 'x' + meta.vh, 'dur', meta.dur, 'fps', meta.fps,
            'totalFrames', meta.totalFrames, 'frameTimes', meta.frameTimes);

        ok(meta.vh > meta.vw, 'サンプルは縦長動画 (1080x1920) として実デコードされた');
        ok(meta.frameTimes >= 8, `実フレーム時刻表が構築された (${meta.frameTimes}枚)`);
        ok(meta.totalFrames === meta.frameTimes - 1, 'totalFrames = frameTimes.length-1 (コマ番号と1:1)');

        // --- ① レターボックス / canvas 全面化 ---
        const layout = await evalExpr(cdp, S, `(()=>{const c=document.getElementById('tracker-canvas');
            const k=document.getElementById('canvas-container');const m=window.getFitMetrics();
            return {cw:c.width, ch:c.height, contw:k.clientWidth, conth:k.clientHeight, fit:+m.fit.toFixed(4), baseX:Math.round(m.baseX), baseY:Math.round(m.baseY)};})()`);
        console.log('  [info] layout', JSON.stringify(layout));
        ok(layout.cw === layout.contw, `canvasがコンテナ幅と一致 (${layout.cw}=${layout.contw}) → ズームで横幅を使える`);
        ok(layout.baseX > 0 && layout.baseY === 0, '縦長動画は左右にレターボックス余白 (baseX>0, baseY=0)');

        // --- ③ フレーム送りが実コマを重複なくたどる (実デコードのピクセル指紋で確認) ---
        const frames = await evalAsync(cdp, S, `
            const v = appState.videoElement, N = appState.totalFrames;
            const cv = document.createElement('canvas'); cv.width=24; cv.height=24;
            const cx = cv.getContext('2d', {willReadFrequently:true});
            const seek = (n) => new Promise(r => {
                let done=false; const h=()=>{ if(done)return; done=true; v.removeEventListener('seeked',h); r(); };
                v.addEventListener('seeked', h); window.seekToFrame(n);
                setTimeout(()=>{ if(!done){done=true; v.removeEventListener('seeked',h); r(); } }, 2000);
            });
            const sigs=[];
            for(let n=0;n<=N;n++){ await seek(n); await new Promise(r=>setTimeout(r,40));
                cx.drawImage(v,0,0,24,24); const d=cx.getImageData(0,0,24,24).data;
                let h=0; for(let i=0;i<d.length;i+=4){ h=(Math.imul(h,31) + d[i] + d[i+1]*7 + d[i+2]*13) >>> 0; }
                sigs.push(h);
            }
            return {N, sigs};
        `);
        const distinct = new Set(frames.sigs).size;
        console.log('  [info] frames N+1=' + (frames.N + 1) + ' distinctSignatures=' + distinct);
        ok(frames.N + 1 >= 8, `フレーム数が妥当 (${frames.N + 1}コマ)`);
        ok(distinct === frames.N + 1, `全${frames.N + 1}コマが別フレーム (末尾重複・先頭スキップなし)`);
        ok(frames.sigs[frames.N] !== frames.sigs[frames.N - 1], '末尾2コマが別フレーム (旧バグの重複が解消)');

        // --- ② グラフ複数表示 (デフォルト y-t / v-t) ---
        const g0 = await evalExpr(cdp, S, `(()=>{const checked=[...document.querySelectorAll('#graph-type-checklist input:checked')].map(b=>b.value);
            const mg=document.querySelectorAll('#graph-stack .mini-graph').length;
            const types=[...document.querySelectorAll('#graph-stack canvas')].map(c=>c.dataset.type);
            return {checked, mg, types};})()`);
        ok(g0.mg === 2 && g0.types.join(',') === 'y-t,v-t', `既定で2枚のミニグラフ(y-t,v-t)を縦積み [${g0.types.join(',')}]`);

        // チェック追加で3枚に増える
        const g1 = await evalAsync(cdp, S, `
            const ax=document.querySelector('#graph-type-checklist input[value="a-t"]');
            ax.checked=true; ax.dispatchEvent(new Event('change',{bubbles:true}));
            return [...document.querySelectorAll('#graph-stack canvas')].map(c=>c.dataset.type);`);
        ok(g1.length === 3 && g1[2] === 'a-t', `チェック追加でグラフが3枚に増える [${g1.join(',')}]`);

        // グラフ3枚でも .graph-stack 単体が二重スクロールしない（サイドバー全体の1本スクロールに統一）
        const stackFit = await evalExpr(cdp, S, `(()=>{
            const st = document.getElementById('graph-stack');
            return { sh: st.scrollHeight, ch: st.clientHeight };
        })()`);
        ok(stackFit.sh <= stackFit.ch + 2, `グラフ3枚でも.graph-stackが二重スクロールしない (scrollHeight ${stackFit.sh} <= clientHeight ${stackFit.ch})`);

        await evalAsync(cdp, S, `const ax=document.querySelector('#graph-type-checklist input[value="a-t"]');
            ax.checked=false; ax.dispatchEvent(new Event('change',{bubbles:true})); return true;`);

        // --- 主要動線: 原点 → スケール → トラック → 出力 ---
        const flow = await evalAsync(cdp, S, `
            const s = window.appState;
            // 原点設定 (十字=canvas中央)
            window.setPendingCapture('origin'); window.confirmAtCrosshair();
            const originSet = !!s.calibration.origin;
            // スケール設定: 始点→(パンで十字位置をずらして)終点→ダイアログに実寸入力
            window.setPendingCapture('scale'); window.confirmAtCrosshair();
            s.viewState.offsetX -= 200; // 十字が指す動画座標をずらす
            window.confirmAtCrosshair();
            // showInputDialog が出ている: 実寸 50cm を入力して OK
            const dlgInput = document.getElementById('dialog-input-val');
            const dlgShown = !!dlgInput;
            if (dlgInput) dlgInput.value = '50';
            document.getElementById('dialog-btn-ok').click();
            const scaleSet = !!s.calibration.scaleRatio;
            // トラック: 数コマに点を打つ (確定でステップ送り)
            window.seekToFrame(0);
            await new Promise(r=>setTimeout(r,60));
            const before = s.trackingData.length;
            window.setPendingCapture(null);
            for (let k=0;k<4;k++){ window.confirmAtCrosshair(); await new Promise(r=>setTimeout(r,80)); }
            const tracked = s.trackingData.length - before;
            return { originSet, dlgShown, scaleSet, scaleRatio: s.calibration.scaleRatio, tracked };
        `);
        ok(flow.originSet, '原点を設定できた (setPendingCapture+confirmAtCrosshair)');
        ok(flow.dlgShown && flow.scaleSet && isFinite(flow.scaleRatio) && flow.scaleRatio > 0,
            `スケールを設定できた (${flow.scaleRatio ? flow.scaleRatio.toFixed(4) : 'n/a'} cm/px)`);
        ok(flow.tracked >= 3, `トラック点を複数登録できた (${flow.tracked}点, 確定で自動コマ送り)`);

        // 既存点の上書き（修正作業）は自動コマ送りしない。その場に留まる。
        const overwrite = await evalAsync(cdp, S, `
            const s = window.appState;
            window.seekToFrame(0);
            await new Promise(r=>setTimeout(r,80));
            const before = s.currentFrame;
            const countBefore = s.trackingData.length;
            window.confirmAtCrosshair(); // frame0には既存点がある → 上書き
            await new Promise(r=>setTimeout(r,80));
            return { before, after: s.currentFrame, countBefore, countAfter: s.trackingData.length };
        `);
        ok(overwrite.before === 0 && overwrite.after === 0,
            `既存点の上書き時は自動コマ送りしない (frame ${overwrite.before}→${overwrite.after})`);
        ok(overwrite.countBefore === overwrite.countAfter,
            `上書きは点数を増やさない (${overwrite.countBefore}→${overwrite.countAfter})`);

        // 出力: エクスポートダイアログの TSV にヘッダと行が入る
        const exp = await evalAsync(cdp, S, `
            document.getElementById('btn-export').click();
            const ta = document.querySelector('#dialog-body textarea');
            const tsv = ta ? ta.value : '';
            document.getElementById('dialog-btn-cancel').click();
            const allLines = tsv.trim().split('\\n');
            return { hasTextarea: !!ta, allLines, lines: allLines.length };
        `);
        // StageE以降、先頭にスムージング/スロー補正の状態を示すメモ行(#始まり)が付くため、
        // ヘッダは「先頭行」固定ではなく「object_idで始まる行」として探す。
        const headerLine = exp.hasTextarea ? exp.allLines.find(l => /^object_id\tframe/.test(l)) : null;
        ok(exp.hasTextarea && !!headerLine, '出力TSVに正しいヘッダが含まれる');
        ok(exp.lines >= 4, `出力TSVにヘッダ+データ行がある (${exp.lines}行)`);

        // 単位が cm 表記 (スケール設定済みなので)
        const unitHead = await evalExpr(cdp, S, `document.querySelectorAll('#data-table thead th')[1].textContent`);
        ok(/cm/.test(unitHead), `スケール設定後はデータ表ヘッダが cm 表記 (${unitHead})`);

        // ストロボ写真: 追跡点のコマを実合成し、動画解像度のPNGが得られる
        const strobe = await evalAsync(cdp, S, `
            const cv = document.createElement('canvas');
            const n = await window.generateStrobe(cv, 1, 60, null);
            const url = cv.toDataURL('image/png');
            return { n, w: cv.width, h: cv.height, png: url.startsWith('data:image/png') && url.length > 5000 };
        `);
        ok(strobe.n >= 3, `ストロボ: ${strobe.n}コマを合成できた`);
        ok(strobe.w === 1080 && strobe.h === 1920, `ストロボ: 動画実解像度で合成 (${strobe.w}x${strobe.h})`);
        ok(strobe.png, 'ストロボ: PNGデータとして出力できる');

        // 新サンプル動画: samples/ の合成動画がコンテナ解析で真値どおり読める
        await evalExpr(cdp, S, `window.loadSampleByUrl('samples/free_fall.mp4','free_fall')`);
        await waitUntil(cdp, S,
            `window.appState.videoName==='samples/free_fall.mp4' && window.appState.isScanning===false && window.appState.frameTimes.length>0`,
            30000, '新サンプル読込');
        const smp = await evalExpr(cdp, S,
            `({ n: appState.frameTimes.length, fps: appState.videoFps, vw: appState.videoElement.videoWidth })`);
        ok(smp.n >= 33 && smp.n <= 35, `新サンプル: 実時刻表 ${smp.n}コマ (期待35±微小)`);
        ok(Math.abs(smp.fps - 60) < 0.5, `新サンプル: fps≈60 (実測 ${smp.fps})`);
        ok(smp.vw === 540, `新サンプル: 540x960で実デコード`);

    } catch (e) {
        fail++;
        console.error('❌ 実行エラー: ' + e.message);
    } finally {
        try { if (ws) ws.close(); } catch (e) {}
        try { proc.kill(); } catch (e) {}
        try { srv.close(); } catch (e) {}
        try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
    }

    console.log(`=== E2E 終了: ${pass} PASS / ${fail} FAIL ===`);
    process.exit(fail === 0 ? 0 : 1);
})();
