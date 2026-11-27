# 程式架構介紹

給要改這個工具的人（或 agent）看的導覽。使用者操作說明在頁面右上角「說明」，功能清單在 [README.md](README.md)。

## 檔案

| 檔案 | 內容 |
|---|---|
| `index.html` | 版面骨架：左欄圖層清單、中間畫布（`<canvas>` WebGL + 一層 2D overlay）、右欄屬性面板、工具列、時間軸、說明視窗 |
| `spine-viewer.js` | 全部邏輯（約 3000 行、單檔、沒有建置步驟、沒有外部依賴） |
| `style.css` | 樣式（深色主題、可拖拉調整的左右欄） |
| `lib/spine-webgl-3.8.js` | spine-ts 3.8 webgl runtime（官方 build，未修改），全域 `spine` |
| `lib/LICENSE-spine-runtimes.txt` | Spine Runtimes License |
| `.nojekyll` | 讓 GitHub Pages 直接當靜態檔發布 |

純靜態網頁：改完直接重新整理瀏覽器就生效。

## 座標系

世界座標同 Cocos：原點在畫面中央、Y 朝上。`w2s()` / `s2w()` 在世界與螢幕像素之間換算，`S.cam` 是檢視用的平移 / 縮放（不影響圖層數值）。

## 全域狀態

- `S`：全部執行期狀態（`layers`、`attachments`、選取、暫停、速度、比對模式、淡入淡出全域時鐘 `S.clock`、攝影機…）。
- 圖層物件由 `newLayerBase(type, name)` 建立，`type` 是 `spine` 或 `image`。Spine 圖層另有 `sk`（Skeleton）、`st`（AnimationState）。
- 持久化：`PERSIST_KEYS` 列的欄位依骨架名稱存到 localStorage（`spineViewer.layer.<名稱>`），`persistSoon()` 延遲寫入；全域設定、骨頭掛點、圖層順序、欄寬各有自己的 key（`LS_*` 常數）。
- 工作區匯出 / 匯入：`workspaceObj()` / `applyWorkspace()`（不含 Spine 檔本身）。

## 主迴圈

`frame()`（requestAnimationFrame）→ `tick(dt)` 更新所有圖層 → `render()` 用 WebGL 畫 → `drawOverlay()` 用 2D canvas 畫骨頭、掛點文字、選取框、定位骨頭的圖釘。

`tick()` 的順序很重要：Spine 圖層依 `followDepth()` 排序（被跟隨的先更新），跟隨者用來源的速度 `update` 後 `syncFollow()` 對齊；凍結的圖層把各軌 `trackTime` 固定在凍結時間；接著 `apply` → `updateWorldTransform` → `applyPins()` 把定位骨頭蓋到指定座標（每幀都蓋）。`followCreatesLoop()` 在設定跟隨時防循環。

## 各功能在哪裡

| 功能 | 主要函式 |
|---|---|
| 匯入（檔案 / 資料夾 / 拖放、自動配對 skel/json + atlas + png） | `importFiles`、`filesFromDataTransfer`、`walkHandle`、`walkEntry`、`createSpineLayer`、`createImageLayer` |
| 二進位版本偵測（讀不了 4.x 時顯示版本） | `detectBinaryVersion` |
| BMFont | `parseFnt`、`layoutBmText`、`drawBmText`；`.ttf` / `.otf` 用 `loadFont`（FontFace） |
| 掛點文字（文字框、錨點、對齊、Overflow，同 Cocos Label） | `drawAttachmentText`（由 `drawOverlay` 呼叫）、面板 `attachmentHtml` |
| 播放、從頭播 | `playAnim`、`restartLayer`、`restartAll`、`stepFrames`（逐幀前後退） |
| 播放順序（Start → Loop×N → End） | `seqStart`、`seqNext`、`seqStop`、`onComplete`、錄製 `startRecording` / `recordClick` / `stopRecording`、文字編輯 `parseSeqText` |
| Skin（切換、疊加多個） | `applySkin`、面板 `skinHtml`；圖層欄位 `skin`（主要的）、`skinExtra`（疊加的） |
| 跟隨 | `resolveFollows`、`syncFollow`、`followDepth` |
| 多軌播放（第 1 軌以上） | `applyTracks`、`applyTrack`、`clearExtraTrack`、`updateTrackLive`、`shiftExtraTracks`（上限 `MAX_TRACK`） |
| mix | `rebuildMix`（預設 mix + 配對 mix）；優先序：播放順序那一段的 mix > 配對 mix > 預設 mix |
| 淡入 / 淡出 | `EASES`（名稱同 cc.tween）、`fadeClock`、`fadeAlpha`、`layerAlpha` |
| 靜 / 動態比對 | `roleVisible`、`setCompare`（全部 / 靜態 / 動態 / 疊圖 / 閃爍） |
| 自動對位（比對 Layout 圖） | `renderLayerAlone`、`rasterizeRef`、`downsampleGrid`、`templatePoints`、`nccAt`、`alignLayer`、`runAlign`、`undoAlign` |
| 畫布上拖圖層 / 拖骨頭圖釘 | `pickLayer`、`startLayerDrag`、`pickPin`、`pickBone` |
| 屬性面板 | `renderProps`（整個重畫）、`updateLiveProps`（每幀只更新數值）、`onPropInput`（輸入事件總入口）、`syncPropInputs` |
| PMA | `makeTexture`、`reuploadTexture`（切「貼圖預乘」時重新上傳貼圖） |
| 左右欄寬度 | `applyPanelWidths`（存 `spineViewer.panels`） |

## 幾個不直覺的地方

- **多軌 mix 進場**：空的軌道直接 `setAnimation` 不會 mix。要先 `setEmptyAnimation(track, 0)` 再 `addAnimation`；而且沒被 apply 過的 empty entry 會被跳過，所以 `applyTrack` 用 add 而不是 set。
- **淡入淡出時鐘**：用全域 `S.clock` 或某組 Spine 第 0 軌的 `trackTime`。`S.clock` 會跟著「全部從頭」/ R 歸零，也會跟著逐幀倒退。圖層透明度乘數也套到掛在它骨頭上的文字。
- **自動對位**：把圖層單獨畫到 FBO（世界比例 1:1），只取不透明像素（alpha ≥ 200）當樣板；Layout 圖照世界座標格點化（透明處填灰 128），用遮罩三通道 NCC 比對。先在 1/4 解析度粗找保留前 5 名，再全解析度細修；可加找縮放 0.85–1.15。元件太大時（降解析度比對）會再用全解析度修一次。
- **預設參考圖**：沒手動選時，自動挑「目前圖層以外、面積最大的圖片圖層」當 Layout 圖。
- **renderProps 會整個重畫右欄**：輸入中的欄位要靠 `updateLiveProps` / `syncPropInputs` 更新，不要在每幀呼叫 `renderProps`。

## 改的時候

- 新增要記住的圖層欄位：加進 `PERSIST_KEYS`，`newLayerBase` 給預設值，工作區匯出會自動帶上。
- 新增 UI：在 `renderProps` 產 HTML（`data-*` 屬性），在 `onPropInput` 或點擊委派處理；同步在 `index.html` 的說明視窗加一條。
- 本機測試：`python -m http.server 8000` 後開 `http://localhost:8000/`，看 console 沒有錯誤。
