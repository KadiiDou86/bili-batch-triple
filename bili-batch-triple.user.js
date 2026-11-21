// ==UserScript==
// @name         番剧批量三连
// @namespace    https://github.com/KadiiDou86/bili-batch-triple
// @version      1.1.2
// @author       KadiiDou86
// @description  用 B 站官方一键三连接口，批量给番剧全部剧集三连。带间隔控制与断点续跑。面板按「仅正片」显示实际集数。
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/bangumi/media/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/**
 * 用法
 *   1) Tampermonkey 安装本脚本后，打开任一集番剧播放页
 *   2) 右下角出现面板，先点「读取剧集」确认集数
 *   3) 选好间隔，点「开始」
 *
 *   也可以在浏览器控制台直接粘贴运行（无需装插件）
 *
 * 注意
 *   · 走官方 /x/web-interface/archive/like/triple 接口，一次请求完成三连
 *   · 固定投 2 币、存入默认收藏夹（这个接口不支持拆分或指定币数）
 *   · 请求过快会触发风控（返回 -352 / -412），脚本会连续失败 3 次自动暂停
 *   · 已完成剧集记在 localStorage，中断后重跑会跳过
 */

(function () {
  'use strict';

  const API_BASE = 'https://api.bilibili.com';
  const STORAGE_KEY = 'nr_bili_triple_done';
  const PANEL_ID = 'nr-triple-panel';

  const state = {
    seasonId: '',
    title: '',
    episodes: [],
    running: false,
    stopFlag: false,
    done: loadDone(),
    stats: { triple: 0, partial: 0, skip: 0, fail: 0, noCoin: 0 },
  };

  // ---------- 基础工具 ----------

  function loadDone() {
    try {
      return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
    } catch (err) {
      return new Set();
    }
  }

  function saveDone() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.done]));
    } catch (err) {
      /* 隐私模式下可能失败，忽略 */
    }
  }

  /** 把常见错误码翻成人话，便于判断是风控还是账号限制 */
  function explain(code, message) {
    const map = {
      '-101': '账号未登录',
      '-111': 'csrf 校验失败，刷新页面重试',
      '-352': '触发风控校验，请放大间隔',
      '-412': '请求被拦截，操作太快了',
      '-403': '权限不足',
      '-104': '硬币不足',
      '-404': '稿件不存在或不可操作',
      '34005': '投币数超过上限（同一 UP 主每天有限）',
      '65006': '已经点过赞',
      '-400': '请求错误',
      '10003': '稿件不存在',
    };
    const text = map[String(code)];
    return text || message || ('错误码 ' + code);
  }

  function cookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  }

  function csrf() {
    return cookie('bili_jct');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function getJson(url) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    return response.json();
  }

  async function postForm(url, params) {
    const body = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => body.append(key, value));
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    return response.json();
  }

  // ---------- 番剧信息 ----------

  function detectSeasonId() {
    const fromUrl = location.href.match(/\/bangumi\/play\/ss(\d+)/);
    if (fromUrl) {
      return fromUrl[1];
    }
    const init = window.__INITIAL_STATE__ || {};
    const fromEp = init.pgc && init.pgc.epInfo && init.pgc.epInfo.season_id;
    if (fromEp) {
      return String(fromEp);
    }
    // 番剧详情页（/bangumi/media/mdXXXX）
    const fromMedia = init.mediaInfo && init.mediaInfo.season_id;
    if (fromMedia) {
      return String(fromMedia);
    }
    return '';
  }

  async function loadEpisodes(seasonId) {
    const data = await getJson(API_BASE + '/pgc/view/web/season?season_id=' + seasonId);
    if (data.code !== 0 || !data.result) {
      throw new Error('读取番剧失败：' + (data.message || data.code));
    }
    const result = data.result;
    const list = [];

    (result.episodes || []).forEach((ep) => {
      list.push({
        aid: ep.aid,
        epId: ep.id || ep.ep_id,
        label: ep.title || '',
        longTitle: ep.long_title || '',
        group: '正片',
        badge: ep.badge || '',
      });
    });

    (result.section || []).forEach((section) => {
      (section.episodes || []).forEach((ep) => {
        list.push({
          aid: ep.aid,
          epId: ep.id || ep.ep_id,
          label: ep.title || '',
          longTitle: ep.long_title || '',
          group: section.title || '其他',
          badge: ep.badge || '',
        });
      });
    });

    return { title: result.title || '番剧', list };
  }

  // ---------- 官方三连接口 ----------

  /**
   * 一次请求完成点赞 + 投币 + 收藏。
   * 官方接口固定投 2 币、存入默认收藏夹，不能拆分。
   * code=0 时 data 里三个布尔仍可能部分为 false（如已点赞、硬币不足），
   * 所以要看布尔值判断真实结果。
   */
  async function doTriple(aid) {
    const data = await postForm(API_BASE + '/x/web-interface/archive/like/triple', {
      aid: aid,
      csrf: csrf(),
    });
    if (data.code === 0) {
      const result = data.data || {};
      const like = result.like === true;
      const coin = result.coin === true;
      const fav = result.fav === true;
      return {
        ok: like && coin && fav,
        partial: like || coin || fav,
        detail: '赞' + (like ? '✓' : '✗') + ' 币' + (coin ? '✓' : '✗') + ' 藏' + (fav ? '✓' : '✗'),
      };
    }
    const noCoin = data.code === -104 || data.code === 34005;
    return { ok: false, code: data.code, message: data.message, noCoin: noCoin };
  }

  // ---------- 面板 ----------

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) {
      return;
    }
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="nr-head">
        <span class="nr-title">番剧批量三连</span>
        <span class="nr-min" title="收起">−</span>
      </div>
      <div class="nr-body">
        <div class="nr-row">
          <button class="nr-btn" data-act="load">读取剧集</button>
          <span class="nr-info" data-role="season">未读取</span>
        </div>
        <div class="nr-row">
          <span class="nr-info">官方三连 · 每集固定 2 币 · 默认收藏夹</span>
        </div>
        <div class="nr-row">
          <label class="nr-inline">间隔
            <select data-opt="gap">
              <option value="2000">2 秒</option>
              <option value="3000" selected>3 秒</option>
              <option value="5000">5 秒</option>
              <option value="8000">8 秒</option>
            </select>
          </label>
        </div>
        <div class="nr-row">
          <label class="nr-inline"><input type="checkbox" data-opt="skipDone" checked> 跳过已完成</label>
          <label class="nr-inline"><input type="checkbox" data-opt="onlyMain" checked> 仅正片</label>
        </div>
        <div class="nr-row">
          <button class="nr-btn nr-primary" data-act="start">开始</button>
          <button class="nr-btn" data-act="stop" disabled>暂停</button>
          <button class="nr-btn" data-act="reset">清空记录</button>
        </div>
        <div class="nr-progress"><div class="nr-bar" data-role="bar"></div></div>
        <div class="nr-info" data-role="status">待开始</div>
        <div class="nr-log" data-role="log"></div>
      </div>
    `;
    document.body.appendChild(panel);

    const style = document.createElement('style');
    style.textContent = `
      #${PANEL_ID} {
        position: fixed; right: 16px; bottom: 16px; width: 300px; z-index: 999999;
        background: #1c1c1e; color: #e6e2da; border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,.45); font-size: 12px;
        font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif;
        overflow: hidden; border: 1px solid #333;
      }
      #${PANEL_ID} .nr-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 12px; background: #26262a; cursor: move; user-select: none;
      }
      #${PANEL_ID} .nr-title { font-weight: 600; font-size: 13px; color: #f0a8a0; }
      #${PANEL_ID} .nr-min { cursor: pointer; width: 18px; text-align: center; }
      #${PANEL_ID} .nr-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
      #${PANEL_ID}.nr-collapsed .nr-body { display: none; }
      #${PANEL_ID} .nr-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      #${PANEL_ID} .nr-opts label { display: flex; align-items: center; gap: 4px; }
      #${PANEL_ID} .nr-inline { display: flex; align-items: center; gap: 4px; }
      #${PANEL_ID} .nr-btn {
        flex: 1; padding: 5px 8px; border-radius: 6px; border: 1px solid #3a3a40;
        background: #2c2c31; color: #e6e2da; cursor: pointer; font-size: 12px;
      }
      #${PANEL_ID} .nr-btn:hover:not(:disabled) { background: #3a3a42; }
      #${PANEL_ID} .nr-btn:disabled { opacity: .45; cursor: not-allowed; }
      #${PANEL_ID} .nr-primary { background: #b4453b; border-color: #b4453b; }
      #${PANEL_ID} .nr-primary:hover:not(:disabled) { background: #c95046; }
      #${PANEL_ID} .nr-progress { height: 4px; background: #333; border-radius: 2px; overflow: hidden; }
      #${PANEL_ID} .nr-bar { height: 100%; width: 0; background: #b4453b; transition: width .2s; }
      #${PANEL_ID} .nr-info { color: #9a9186; font-size: 11px; }
      #${PANEL_ID} .nr-log {
        max-height: 120px; overflow-y: auto; background: #141416; border-radius: 6px;
        padding: 6px; font-size: 11px; line-height: 1.55; color: #a8a198;
        font-family: ui-monospace, Consolas, monospace;
      }
      #${PANEL_ID} .nr-log .ok { color: #7fb069; }
      #${PANEL_ID} .nr-log .warn { color: #d4a259; }
      #${PANEL_ID} .nr-log .err { color: #d97a72; }
      #${PANEL_ID} select { background: #2c2c31; color: #e6e2da; border: 1px solid #3a3a40; border-radius: 4px; padding: 1px 4px; }
    `;
    document.head.appendChild(style);

    panel.querySelector('.nr-min').addEventListener('click', () => {
      panel.classList.toggle('nr-collapsed');
    });

    // 拖动
    const head = panel.querySelector('.nr-head');
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    head.addEventListener('mousedown', (event) => {
      if (event.target.classList.contains('nr-min')) {
        return;
      }
      dragging = true;
      offsetX = event.clientX - panel.offsetLeft;
      offsetY = event.clientY - panel.offsetTop;
      event.preventDefault();
    });
    document.addEventListener('mousemove', (event) => {
      if (!dragging) {
        return;
      }
      panel.style.left = event.clientX - offsetX + 'px';
      panel.style.top = event.clientY - offsetY + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      dragging = false;
    });

    panel.addEventListener('click', (event) => {
      const act = event.target.getAttribute('data-act');
      if (act === 'load') {
        loadAndRender();
      } else if (act === 'start') {
        run();
      } else if (act === 'stop') {
        state.stopFlag = true;
      } else if (act === 'reset') {
        state.done = new Set();
        saveDone();
        log('已清空完成记录', 'warn');
        renderStatus();
      }
    });

    // 切换「仅正片」时面板集数立即跟着变，避免误以为筛选没生效
    const onlyMainEl = document.querySelector('#nr-triple-panel [data-opt="onlyMain"]');
    if (onlyMainEl) {
      onlyMainEl.addEventListener('change', renderSeasonInfo);
    }
  }

  function $(role) {
    const panel = document.getElementById(PANEL_ID);
    return panel ? panel.querySelector('[data-role="' + role + '"]') : null;
  }

  function option(name) {
    const el = document.querySelector('#nr-triple-panel [data-opt="' + name + '"]');
    if (!el) {
      return undefined;
    }
    return el.type === 'checkbox' ? el.checked : el.value;
  }

  /** 当前「仅正片」设置下真正要执行的剧集。面板显示与运行共用，避免数字与行为不一致 */
  function currentList() {
    const onlyMain = option('onlyMain');
    return state.episodes.filter((ep) => (onlyMain ? ep.group === '正片' : true));
  }

  /** 面板上的剧集信息随「仅正片」开关实时刷新 */
  function renderSeasonInfo() {
    const seasonEl = $('season');
    if (!seasonEl) {
      return;
    }
    if (!state.title || state.episodes.length === 0) {
      seasonEl.textContent = '未读取';
      return;
    }
    const mainCount = state.episodes.filter((ep) => ep.group === '正片').length;
    const allCount = state.episodes.length;
    if (mainCount === allCount) {
      seasonEl.textContent = state.title + ' · ' + allCount + ' 集';
    } else if (option('onlyMain')) {
      seasonEl.textContent = state.title + ' · 正片 ' + mainCount + ' 集 / 全部 ' + allCount;
    } else {
      seasonEl.textContent = state.title + ' · 全部 ' + allCount + ' 集（正片 ' + mainCount + '）';
    }
  }

  function log(text, kind) {
    const box = $('log');
    if (!box) {
      return;
    }
    const line = document.createElement('div');
    if (kind) {
      line.className = kind;
    }
    line.textContent = text;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
    while (box.childElementCount > 200) {
      box.removeChild(box.firstChild);
    }
  }

  function renderStatus() {
    const s = state.stats;
    const el = $('status');
    if (el) {
      el.textContent =
        '三连 ' + s.triple +
        (s.partial ? ' · 部分成功 ' + s.partial : '') +
        ' · 跳过 ' + s.skip + ' · 失败 ' + s.fail +
        (s.noCoin ? ' · 硬币不足 ' + s.noCoin : '');
    }
  }

  function setBar(done, total) {
    const bar = $('bar');
    if (bar) {
      bar.style.width = (total > 0 ? Math.floor((done / total) * 100) : 0) + '%';
    }
  }

  // ---------- 主流程 ----------

  async function loadAndRender() {
    try {
      const seasonId = detectSeasonId();
      if (!seasonId) {
        log('没能识别番剧，请在番剧播放页使用', 'err');
        return;
      }
      state.seasonId = seasonId;
      const data = await loadEpisodes(seasonId);
      state.title = data.title;
      state.episodes = data.list;
      renderSeasonInfo();
      const mainCount = data.list.filter((ep) => ep.group === '正片').length;
      log(
        '已读取《' + data.title + '》正片 ' + mainCount + ' 集，全部 ' + data.list.length + ' 集（含预告/花絮等附加内容）',
        'ok'
      );
    } catch (err) {
      log('读取失败：' + err.message, 'err');
    }
  }

  async function run() {
    if (state.running) {
      return;
    }
    if (state.episodes.length === 0) {
      await loadAndRender();
    }
    if (state.episodes.length === 0) {
      return;
    }
    if (!csrf()) {
      log('没有找到 bili_jct，请确认已登录', 'err');
      return;
    }

    const gap = Number(option('gap') || 3000);
    const skipDone = option('skipDone');
    const onlyMain = option('onlyMain');

    const list = currentList();
    state.running = true;
    state.stopFlag = false;
    state.stats = { triple: 0, partial: 0, skip: 0, fail: 0, noCoin: 0 };
    log('使用官方三连接口，每集固定投 2 币，存入默认收藏夹', 'ok');
    log('本次将处理 ' + list.length + ' 集（' + (onlyMain ? '仅正片' : '含附加内容') + '）', 'ok');

    const btnStart = document.querySelector('#nr-triple-panel [data-act="start"]');
    const btnStop = document.querySelector('#nr-triple-panel [data-act="stop"]');
    if (btnStart) {
      btnStart.disabled = true;
    }
    if (btnStop) {
      btnStop.disabled = false;
    }

    let guardFails = 0;
    try {
      for (let index = 0; index < list.length; index++) {
        if (state.stopFlag) {
          log('已暂停在第 ' + (index + 1) + ' 集', 'warn');
          break;
        }
        const ep = list[index];
        const key = String(ep.aid);
        const name = '第' + (ep.label || index + 1) + '集' + (ep.longTitle ? '·' + ep.longTitle : '');

        if (skipDone && state.done.has(key)) {
          state.stats.skip += 1;
          setBar(index + 1, list.length);
          renderStatus();
          continue;
        }

        let res;
        try {
          res = await doTriple(ep.aid);
        } catch (err) {
          // 网络中断、接口异常都当作一次失败，避免整个流程卡死
          res = { ok: false, code: 'NETWORK', message: err.message };
        }
        // code=0 但个别动作已做过（如已点赞）时仍算完成，避免重复跑
        const ok = res.ok || res.partial;
        if (res.noCoin) {
          state.stats.noCoin += 1;
          log(name + ' 硬币不足：' + explain(res.code, res.message), 'warn');
        } else if (res.ok) {
          // 赞、币、藏全部成功
          state.stats.triple += 1;
        } else if (res.partial) {
          // 例如已点过赞，但投币收藏成功——统计里单独记一笔
          state.stats.partial += 1;
        } else {
          log(name + ' 三连失败：' + explain(res.code, res.message), 'err');
        }

        if (ok) {
          state.done.add(key);
          log(name + (res.partial ? ' ' + res.detail + ' 完成' : ' 完成'), res.ok ? 'ok' : 'warn');
          guardFails = 0;
        } else {
          state.stats.fail += 1;
          guardFails += 1;
          if (guardFails >= 3) {
            log('连续失败 3 次，可能触发风控，已暂停。建议间隔调到 5 秒以上再试', 'err');
            break;
          }
        }

        saveDone();
        setBar(index + 1, list.length);
        renderStatus();
        await sleep(gap);
      }
    } finally {
      // 无论正常结束还是异常退出，都复位运行状态与按钮，避免面板卡死
      state.running = false;
      if (btnStart) {
        btnStart.disabled = false;
      }
      if (btnStop) {
        btnStop.disabled = true;
      }
      log('本轮结束', 'warn');
      renderStatus();
    }
  }

  // ---------- 启动 ----------

  function boot() {
    buildPanel();
    // 打开页面先自动读一次，省一次点击
    setTimeout(() => {
      loadAndRender();
    }, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
