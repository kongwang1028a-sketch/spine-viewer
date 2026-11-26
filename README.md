# Spine 多組檢視器

**線上使用：<https://kongwang1028a-sketch.github.io/spine-viewer/>**

在瀏覽器裡同時播放、對位、比對多組 Spine 動畫的小工具。純前端，匯入的檔案只在你自己的瀏覽器裡處理，不會上傳到任何地方。

Runtime 是 spine-ts 3.8（webgl），對應 Spine 3.8.x 匯出的 `.skel` / `.json`（Cocos Creator 3.8 內建的 Spine 版本）；4.x 的檔案讀不了，會顯示檔案版本。

## 功能

- **一次匯入多組**：檔案、整個資料夾或直接拖放。同名 `.skel|.json` + `.atlas` + atlas 列的 PNG 會自動配對（`.meta` 略過）；單獨的 PNG 會變成圖片圖層。
- **座標同 Cocos**：原點在畫面中央、Y 朝上，X / Y / 縮放可以直接填 Cocos Inspector 的數值；可在畫面上直接拖圖層。
- **跟隨**：一組 Spine 每幀對齊另一組第 0 軌的動畫名與播放時間，適合「本體一組、特效 / 數字另一組」同步播。
- **骨頭掛數字**：文字跟著骨頭的位置 / 旋轉 / 縮放（同 Cocos socket），可匯入 `.ttf` / `.otf` 或 BMFont（`.fnt` + `.png`）。
- **定位骨頭**：把某根骨頭固定到指定座標（模擬程式在執行期擺骨頭，例如飛行軌跡的終點），可拖曳或填數值。
- **多軌播放**：第 1 軌以上同時播（同 `setAnimation(trackIndex, …)`），可設權重、速度、延遲、疊加（`MixBlend.add`）。
- **mix**：預設 mix、動畫配對 mix（同 `setMix(from, to, 秒)`，可一鍵試播 A→B）、播放順序每段 mix、多軌進出場 mix。
- **播放順序**：錄製 / 編輯 Start → Loop×N → End，次數 0 = 等手動「下一段」。
- **淡入 / 淡出**：圖層透明度依全域時鐘或某組 Spine 的動畫時間淡入淡出（同 `UIOpacity` + `tween`）。
- **自動對位**：匯入 Layout 圖（PNG），用元件目前這一格的畫面在 Layout 上找最像的位置，自動填 X / Y（可一起找縮放、可多選、可還原）。
- **靜 / 動態比對**：圖層角色（靜態 / 動態）＋ 全部 / 靜態 / 動態 / 疊圖 / 閃爍。
- **PMA 檢查**：可切「PMA 混色」「貼圖預乘」，重現 `premultipliedAlpha` 設定不一致造成的顏色差。
- 圖層設定依骨架名稱記在瀏覽器（localStorage）；「匯出 / 匯入工作區」JSON 可以分享設定（不含 Spine 檔本身）。

詳細操作在頁面右上角的「說明」。

## 本機執行

直接用瀏覽器開 `index.html` 也能用；若瀏覽器擋本機檔案，起一個靜態伺服器：

```bash
python -m http.server 8000
# 開 http://localhost:8000/
```

## 更新線上版

線上版是 GitHub Pages，從 `main` 分支根目錄發布；推上 `main` 後約 1 分鐘自動更新，沒有建置步驟。

如果這台電腦平常用的是**另一個** GitHub 帳號（git 預設憑證或 `GITHUB_TOKEN` 環境變數指向它），直接 `git push` 會被拒絕（403）。照下面的順序推（PowerShell，同一個視窗）：

1. commit 前確認作者是這個 repo 專用的設定，不是電腦的全域作者：

   ```powershell
   git config user.email
   ```

   沒有輸出或不是預期的信箱時，只在這個 repo 裡設定（不加 `--global`）：

   ```powershell
   git config user.name "<顯示名稱>"
   git config user.email "<這個 repo 用的信箱>"
   ```

2. 暫時清掉 `GITHUB_TOKEN`（只影響這個視窗；沒設過可以跳過）：

   ```powershell
   $env:GITHUB_TOKEN = $null
   ```

3. 把 `gh` 切到擁有這個 repo 的帳號（第一次要先 `gh auth login` 登入該帳號）：

   ```powershell
   gh auth switch --user <repo 擁有者帳號>
   ```

4. 用 `gh` 的憑證推送，不經過電腦預設的憑證管理員：

   ```powershell
   git -c credential.helper= -c "credential.helper=!gh auth git-credential" push
   ```

5. 推完把 `gh` 切回平常用的帳號：

   ```powershell
   gh auth switch --user <平常用的帳號>
   ```

## 授權

- `lib/spine-webgl-3.8.js` 來自 [EsotericSoftware/spine-runtimes](https://github.com/EsotericSoftware/spine-runtimes)（`3.8` 分支 `spine-ts/build/`），依 Spine Runtimes License（`lib/LICENSE-spine-runtimes.txt`）散布。依該授權，把 Spine Runtimes 用在自己的產品或專案中，需要持有有效的 Spine Editor 授權。
- Spine 是 Esoteric Software 的商標；本工具與 Esoteric Software 無關。
