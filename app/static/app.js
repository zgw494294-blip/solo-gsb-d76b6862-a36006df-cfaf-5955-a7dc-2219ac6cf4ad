"use strict";

// --------------------------------------------------------------------------- //
// 状态
// --------------------------------------------------------------------------- //
const state = {
  clauses: [], // { id, original, body(内部形态 [[c3]]) }
  orderIds: [],
  editingId: null,
  mergeIds: [], // 勾选待合并的两条条款 id
  preview: null, // 服务端 /api/preview 返回（仅允许“最新一次”预览写入）
  dragId: null,

  // —— 迟到响应防护 ——
  // 草稿“世代”：每次成功导入 / 回到导入页（重新导入）+1；
  // 带着旧世代的任何响应（成功或失败）一律作废，不得碰新草稿。
  gen: 0,
  // 预览请求序号：只接受序号最大的一次预览，旧预览晚到直接丢弃，
  // 避免“合并前预览晚于合并后预览返回，恢复旧列表 / 用新顺序解释旧编号”。
  previewSeq: 0,
  // 当前页面上的 preview 所对应的草稿快照键；与当前快照不一致说明预览落后。
  previewKey: null,
  // ok：已追上最新草稿；loading：最新一次预览仍在途；error：最新一次失败
  previewState: "idle",
  previewError: [],
  // 导入面板自身的请求序号（连续点“导入”时只认最后一次）
  importSeq: 0,
  importing: false,
  // 合并提交期间锁定编辑 / 删除 / 重排 / 勾选 / 重复提交；失败须恢复
  merging: false,
  saving: false,
  exporting: false,
};

const MARKER = /\[\[(?:原(\d+)\?|(\d+))\]\]/g; // 预览文本中的引用形态

const $ = (sel) => document.querySelector(sel);

const importPanel = $("#import-panel");
const desk = $("#desk");
const importText = $("#import-text");
const importErrors = $("#import-errors");
const importBtn = $("#import-btn");
const clauseList = $("#clause-list");
const previewText = $("#preview-text");
const previewStatus = $("#preview-status");
const brokenBanner = $("#broken-banner");
const downloadBtn = $("#download-btn");
const mergeBtn = $("#merge-btn");
const reimportBtn = $("#reimport-btn");
const statCount = $("#stat-count");
const statBroken = $("#stat-broken");

// --------------------------------------------------------------------------- //
// 工具
// --------------------------------------------------------------------------- //
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error("api error");
    err.status = res.status;
    err.errors = (data.detail && data.detail.errors) || ["请求失败"];
    throw err;
  }
  return data;
}

function snapshot() {
  return {
    order_ids: state.orderIds,
    clauses: state.clauses.map((c) => ({ id: c.id, body: c.body })),
  };
}

// 草稿快照指纹：响应回来时核对它是不是为“当前这份草稿”发出的
function keyOf(snap) {
  return JSON.stringify(snap);
}
function currentKey() {
  return keyOf(snapshot());
}

function bumpGen() {
  state.gen += 1;
  // 新世代没有任何“在途最新预览”：旧世代在途请求的序号全部作废，
  // 不能让它们占用新世代的序号（否则其晚到的失败会污染新草稿）
  state.previewSeq += 1;
}

// 预览已追上最新草稿（下载 / 合并 / 进入编辑的前提）
function isPreviewFresh() {
  return state.previewState === "ok" && state.previewKey !== null && state.previewKey === currentKey();
}

// --------------------------------------------------------------------------- //
// 导入 / 重新导入
// --------------------------------------------------------------------------- //
const SAMPLE = [
  "1|甲方应在合同签订后七日内交付设备。",
  "2|乙方按第 [[1]] 条验收合格后三十日内付款。",
  "3|设备规格与数量见附件，不符合的按 [[1]] 退换。",
  "4|因本合同产生的争议，按 [[5]] 处理。",
  "5|争议提交甲方所在地仲裁委员会仲裁。",
].join("\n");

$("#sample-btn").addEventListener("click", () => {
  importText.value = SAMPLE;
  importErrors.hidden = true;
});

importBtn.addEventListener("click", async () => {
  if (state.importing) return; // 重复提交直接忽略
  const seq = ++state.importSeq;
  state.importing = true;
  importBtn.disabled = true;
  importBtn.textContent = "导入中…";
  importErrors.hidden = true;
  try {
    const data = await api("/api/import", { text: importText.value });
    // 期间又点过导入 / 重新导入过：旧成功响应不得切换草稿
    if (seq !== state.importSeq) return;
    state.preview = null;
    state.previewKey = null;
    state.previewState = "loading";
    state.previewError = [];
    state.clauses = data.clauses.map((c) => ({
      id: c.id,
      original: c.original,
      body: c.body,
    }));
    state.orderIds = state.clauses.map((c) => c.id);
    state.editingId = null;
    state.mergeIds = [];
    state.merging = false;
    state.saving = false;
    state.exporting = false;
    state.dragId = null;
    bumpGen(); // 新草稿进入新世代，导入前所有在途响应全部作废
    previewText.textContent = "";
    previewText.classList.remove("blocked");
    importErrors.hidden = true;
    importPanel.hidden = true;
    desk.hidden = false;
    render();
  } catch (e) {
    // 旧请求的失败不得覆盖新请求（或新草稿）的提示与按钮状态
    if (seq !== state.importSeq) return;
    importErrors.innerHTML = e.errors.map((m) => `<li>${esc(m)}</li>`).join("");
    importErrors.hidden = false;
  } finally {
    if (seq === state.importSeq) {
      state.importing = false;
      importBtn.disabled = false;
      importBtn.textContent = "导入";
    }
  }
});

reimportBtn.addEventListener("click", () => {
  // 合并 / 保存 / 下载提交期间锁定（按钮也已禁用，双保险）
  if (state.merging || state.saving || state.exporting) return;
  if (!confirm("重新导入将丢弃当前草稿，确定继续？")) return;
  state.clauses = [];
  state.orderIds = [];
  state.editingId = null;
  state.mergeIds = [];
  state.preview = null;
  state.previewKey = null;
  state.previewState = "idle";
  state.previewError = [];
  state.merging = false;
  state.saving = false;
  state.exporting = false;
  state.dragId = null;
  bumpGen(); // 回到导入页即开启新世代：旧草稿的在途响应（成功/失败）全部失效
  previewStatus.hidden = true;
  previewStatus.textContent = "";
  desk.hidden = true;
  importPanel.hidden = false;
});

// --------------------------------------------------------------------------- //
// 预览与渲染（数据全部以服务端 /api/preview 为准，且只认最新一次）
// --------------------------------------------------------------------------- //
async function render() {
  const seq = ++state.previewSeq;
  const gen = state.gen;
  state.previewState = "loading";
  state.previewError = [];
  paintChrome();

  let data;
  try {
    data = await api("/api/preview", snapshot());
  } catch (e) {
    // 迟到的失败响应不得清掉新预览的状态
    if (seq !== state.previewSeq || gen !== state.gen) return;
    state.previewState = "error";
    state.previewError = e.errors;
    paintChrome();
    return;
  }
  // 只允许“最新一次、同一草稿世代”的预览写入页面
  if (seq !== state.previewSeq || gen !== state.gen) return;
  state.previewState = "ok";
  state.previewError = [];
  state.preview = data;
  state.previewKey = currentKey();
  paint(data);
}

// 只刷新工具栏 / 状态条 / 按钮可用性，不重建卡片（预览在途或保存失败时用）
function paintChrome() {
  const fresh = isPreviewFresh();
  const hasBroken = !!state.preview && state.preview.has_broken;

  if (state.preview) {
    statCount.textContent = `共 ${state.preview.items.length} 条`;
    statBroken.hidden = !state.preview.has_broken;
  } else {
    statCount.textContent = "准备中…";
    statBroken.hidden = true;
  }

  // 预览状态条
  if (state.previewState === "loading") {
    previewStatus.hidden = false;
    previewStatus.className = "preview-status wait";
    previewStatus.textContent = "预览更新中…";
  } else if (state.previewState === "error") {
    previewStatus.hidden = false;
    previewStatus.className = "preview-status error";
    previewStatus.innerHTML =
      `预览刷新失败：${esc(state.previewError.join("；") || "请求失败")} ` +
      `（旧响应不会改动草稿）<button type="button" data-action="retry-preview">重试</button>`;
  } else {
    previewStatus.hidden = true;
    previewStatus.textContent = "";
  }

  // 下载：必须有与当前草稿完全一致的预览、无失效引用且没有在途提交
  downloadBtn.disabled =
    state.merging || state.exporting || !fresh || hasBroken;
  downloadBtn.textContent = state.exporting ? "下载中…" : "下载纯文本";

  // 合并：非编辑态、恰好勾选两条、预览已追上最新改动、无在途合并
  mergeBtn.disabled =
    state.merging ||
    state.editingId !== null ||
    state.mergeIds.length !== 2 ||
    !fresh;
  mergeBtn.textContent = state.merging
    ? "合并中…"
    : state.mergeIds.length === 2
      ? "合并所选（2 条）"
      : "合并所选";

  reimportBtn.disabled = state.merging || state.saving || state.exporting;
}

previewStatus.addEventListener("click", (ev) => {
  if (ev.target.closest('[data-action="retry-preview"]')) render();
});

function paint(data) {
  clauseList.textContent = "";
  let brokenTotal = 0;
  const brokenLines = [];

  for (const item of data.items) {
    brokenTotal += item.broken.length;
    if (item.broken.length) {
      const marks = item.broken.map((b) => `[[原${b.original}?]]`).join("、");
      brokenLines.push(
        `<li>第 ${item.display} 条（导入时原第 ${item.original} 条）中的 ${esc(marks)} 已失去目标（原条款已删除）</li>`,
      );
    }

    const li = document.createElement("li");
    li.className =
      "card" +
      (item.broken.length ? " source-broken" : "") +
      (state.mergeIds.includes(item.id) ? " selected" : "");
    li.id = `card-${item.id}`;
    li.dataset.id = item.id;

    const isEditing = state.editingId === item.id;
    const locked = state.merging; // 合并提交中：编辑 / 删除 / 重排 / 勾选全部锁定
    // 预览落后时不允许进入编辑：编辑器按旧编号起草会造成绑定歧义
    const editDisabled = locked || !!state.editingId || !isPreviewFresh();
    li.innerHTML = `
      <div class="card-head">
        <input type="checkbox" class="merge-pick" title="勾选后与另一条合并（按当前显示顺序）"
          ${state.mergeIds.includes(item.id) ? "checked" : ""}
          ${state.editingId || locked ? "disabled" : ""} />
        <span class="grip ${locked ? "is-locked" : ""}" title="拖拽调整顺序">⠿</span>
        <span class="num">${item.display}</span>
        <span class="orig">（原第 ${item.original} 条）</span>
        ${item.broken.length ? '<span class="warn-tag">含失效引用</span>' : ""}
        <span class="card-actions">
          ${
            isEditing
              ? ""
              : `<button data-action="up" ${
                  item.display === 1 || state.editingId || locked ? "disabled" : ""
                }>↑</button>
                 <button data-action="down" ${
                   item.display === data.items.length || state.editingId || locked
                     ? "disabled"
                     : ""
                 }>↓</button>
                 <button data-action="edit" ${editDisabled ? "disabled" : ""}>编辑正文</button>
                 <button data-action="delete" class="danger" ${
                   state.editingId || locked ? "disabled" : ""
                 }>删除</button>`
          }
        </span>
      </div>
      ${isEditing ? editorHtml(item) : `<div class="card-body">${bodyHtml(item, data.items)}</div>`}
    `;
    clauseList.appendChild(li);
  }

  statBroken.textContent = `${brokenTotal} 处失效引用`;

  // 失效引用横幅
  if (brokenLines.length) {
    brokenBanner.hidden = false;
    brokenBanner.innerHTML =
      `<strong>存在失效引用，修复前禁止下载。</strong>请编辑下列条款，把失效标记改为有效的 [[当前编号]]，或删除该标记：<ul>${brokenLines.join(
        "",
      )}</ul>`;
  } else {
    brokenBanner.hidden = true;
    brokenBanner.textContent = "";
  }

  // 纯文本预览：直接用服务端解析出的 text 拼装，与 /api/export 完全同一逻辑
  const plain = data.items.map((it) => `${it.display}|${it.text}`).join("\n");
  previewText.textContent = plain;
  previewText.classList.toggle("blocked", data.has_broken);

  paintChrome();
  attachDnd();
}

// 预览正文：把 [[n]] 渲染为可点击引用、[[原X?]] 渲染为失效标记。
// 注意：跳转目标必须按“本次预览自己的顺序”解释编号，
// 不能用可能已经更新的 state.orderIds 解读旧编号。
function bodyHtml(item, items) {
  let html = "";
  let last = 0;
  for (const m of item.text.matchAll(MARKER)) {
    html += esc(item.text.slice(last, m.index));
    if (m[1] !== undefined) {
      html += `<span class="ref dead" title="失效引用：原第 ${m[1]} 条已删除，请编辑本条修复">[[原${m[1]}?]]</span>`;
    } else {
      const target = items[parseInt(m[2], 10) - 1];
      if (target) {
        html += `<button type="button" class="ref" data-goto="${esc(target.id)}">[[${m[2]}]]</button>`;
      } else {
        html += esc(m[0]);
      }
    }
    last = m.index + m[0].length;
  }
  html += esc(item.text.slice(last));
  return html;
}

function editorHtml(item) {
  return `
    <div class="editor">
      <textarea data-role="edit-text">${esc(item.text)}</textarea>
      <div class="editor-actions">
        <button data-action="save" class="primary" ${state.saving ? "disabled" : ""}>
          ${state.saving ? "保存中…" : "保存"}
        </button>
        <button data-action="cancel" ${state.saving ? "disabled" : ""}>取消</button>
        <span class="edit-hint">
          单行条款（回车不换行）；[[数字]] 按保存当刻的显示编号绑定；${
            item.broken.length ? "<b>请先修复 [[原X?]] 标记</b>，否则无法保存；" : ""
          }Ctrl+Enter 快速保存
        </span>
      </div>
      <ul class="edit-errors" data-role="edit-errors" hidden></ul>
    </div>`;
}

// 保存提交期间只切换编辑器内按钮，不重绘卡片（避免清空用户输入）
function paintEditorBusy() {
  if (!state.editingId) return;
  const card = clauseList.querySelector(`#card-${state.editingId}`);
  if (!card) return;
  const saveBtn = card.querySelector('[data-action="save"]');
  const cancelBtn = card.querySelector('[data-action="cancel"]');
  if (saveBtn) {
    saveBtn.disabled = state.saving;
    saveBtn.textContent = state.saving ? "保存中…" : "保存";
  }
  if (cancelBtn) cancelBtn.disabled = state.saving;
  paintChrome();
}

// --------------------------------------------------------------------------- //
// 合并两条条款
// --------------------------------------------------------------------------- //
clauseList.addEventListener("change", (ev) => {
  const pick = ev.target.closest(".merge-pick");
  if (!pick) return;
  if (state.merging || state.editingId) return; // 提交期间的勾选变更全部忽略
  const id = pick.closest(".card").dataset.id;
  if (pick.checked) {
    if (state.mergeIds.length >= 2) {
      // 一次只能合并两条：取消本次勾选并提示
      pick.checked = false;
      alert("一次只能合并两条条款：请先取消已勾选的条款。");
      return;
    }
    state.mergeIds.push(id);
  } else {
    state.mergeIds = state.mergeIds.filter((x) => x !== id);
  }
  document.getElementById(`card-${id}`).classList.toggle("selected", pick.checked);
  paintChrome();
});

mergeBtn.addEventListener("click", async () => {
  if (state.merging) return; // 重复提交直接忽略
  if (state.editingId) {
    alert("请先保存或取消正在编辑的正文，再合并条款。");
    return;
  }
  if (state.mergeIds.length !== 2) return;
  if (!isPreviewFresh()) {
    alert("预览尚未追上最新调整，请稍候再合并。");
    return;
  }

  // 按当前显示顺序确定较前 / 较后条款（此时 state 与页面预览同一份草稿）
  const [a, b] = state.mergeIds;
  const keepId = state.orderIds.indexOf(a) < state.orderIds.indexOf(b) ? a : b;
  const dropId = keepId === a ? b : a;
  const previewById = Object.fromEntries(state.preview.items.map((it) => [it.id, it]));
  const keep = previewById[keepId];
  const drop = previewById[dropId];
  const inbound = state.clauses.filter(
    (c) => c.body.includes(`[[${dropId}]]`),
  ).length;

  const msg =
    `将把当前第 ${drop.display} 条并入第 ${keep.display} 条：\n\n` +
    `第 ${keep.display} 条：${keep.text}\n` +
    `第 ${drop.display} 条：${drop.text}\n\n` +
    `合并后正文（全角分号连接）：\n${keep.text}；${drop.text}\n\n` +
    `合并结果沿用第 ${keep.display} 条（原第 ${keep.original} 条）的位置与身份，` +
    `第 ${drop.display} 条移除，其余条款顺序不变。\n` +
    `共有 ${inbound} 处引用指向第 ${drop.display} 条，合并后全部改指合并结果；` +
    `其他引用不变，已失效引用仍保持失效。\n` +
    `提交期间将临时锁定编辑、删除、重排等操作；此操作在重新导入或刷新前不可撤销，确定合并？`;
  if (!confirm(msg)) return;

  // 记录请求所对应的草稿；响应回来时必须仍是同一份，旧合并结果不得撤回后续操作
  const gen = state.gen;
  const sentKey = currentKey();
  state.merging = true;
  paint(state.preview); // 立即锁定全部操作按钮

  let data;
  try {
    data = await api("/api/merge", {
      ...snapshot(),
      keep_id: keepId,
      drop_id: dropId,
    });
  } catch (e) {
    state.merging = false;
    if (state.gen === gen && currentKey() === sentKey) {
      // 合并失败不改草稿：用仍与草稿一致的旧预览重绘，恢复临时锁定的操作
      paint(state.preview);
      alert("合并失败，草稿未改动：\n" + e.errors.join("\n"));
    } else {
      // 草稿已变化（理论上 UI 锁定期间不会发生）：解锁并按当前草稿重新预览
      render();
    }
    return;
  }
  state.merging = false;
  // 草稿已不是请求时那份（例如已重新导入）：旧结果整体作废，不得覆盖/恢复任何条款
  if (state.gen !== gen || currentKey() !== sentKey) {
    if (state.gen === gen) render(); // 同一份草稿但已被后续操作改动：刷新并解锁
    return;
  }

  // 仅在服务端成功、且结果仍对应当前草稿时才改动草稿，
  // 保证列表 / 预览 / 下载立即对应同一份草稿
  state.orderIds = data.order_ids;
  state.clauses = data.clauses.map((c) => ({
    id: c.id,
    original: parseInt(c.id.slice(1), 10),
    body: c.body,
  }));
  state.mergeIds = [];
  render();
});

// --------------------------------------------------------------------------- //
// 列表交互（事件委托）
// --------------------------------------------------------------------------- //
clauseList.addEventListener("click", async (ev) => {
  const goto = ev.target.closest("[data-goto]");
  if (goto) {
    const card = document.getElementById(`card-${goto.dataset.goto}`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.remove("flash");
      void card.offsetWidth;
      card.classList.add("flash");
    }
    return;
  }

  const btn = ev.target.closest("[data-action]");
  if (!btn) return;
  const card = btn.closest(".card");
  const id = card.dataset.id;
  const action = btn.dataset.action;

  if (["up", "down", "edit", "delete"].includes(action) &&
      (state.editingId || state.merging)) return;

  if (action === "up" || action === "down") {
    const idx = state.orderIds.indexOf(id);
    const j = action === "up" ? idx - 1 : idx + 1;
    if (j < 0 || j >= state.orderIds.length) return;
    [state.orderIds[idx], state.orderIds[j]] = [state.orderIds[j], state.orderIds[idx]];
    render();
  } else if (action === "edit") {
    // 预览落后时不允许编辑（按钮也已禁用）
    if (!isPreviewFresh()) return;
    state.editingId = id;
    render().then(() => {
      const ta = clauseList.querySelector(`#card-${id} textarea`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.addEventListener("keydown", onEditorKey);
      }
    });
  } else if (action === "delete") {
    const inbound = state.clauses.filter(
      (c) => c.id !== id && c.body.includes(`[[${id}]]`),
    ).length;
    const msg =
      `确定删除该条款？\n` +
      (inbound ? `有 ${inbound} 条条款引用它，删除后这些引用将标为失效，修复前无法下载。\n` : "") +
      `（编号会自动重排，此操作在重新导入或刷新前不可撤销）`;
    if (!confirm(msg)) return;
    state.orderIds = state.orderIds.filter((x) => x !== id);
    state.clauses = state.clauses.filter((c) => c.id !== id);
    state.mergeIds = state.mergeIds.filter((x) => x !== id);
    render(); // 旧合并结果即使晚到，也会因快照指纹不一致被丢弃，无法把该条款恢复
  } else if (action === "cancel") {
    if (state.saving) return;
    state.editingId = null;
    render();
  } else if (action === "save") {
    await saveEdit(id);
  }
});

function onEditorKey(ev) {
  if (ev.key === "Enter" && !ev.shiftKey) {
    // 只处理单行条款：Enter 不插入换行；Ctrl/⌘+Enter 保存
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) saveEdit(state.editingId);
  }
}

async function saveEdit(id) {
  if (state.saving) return; // 防重复提交
  const card = clauseList.querySelector(`#card-${id}`);
  const textarea = card.querySelector("textarea");
  const text = textarea.value;
  const errBox = card.querySelector('[data-role="edit-errors"]');
  const gen = state.gen;
  state.saving = true;
  paintEditorBusy();
  let data;
  try {
    data = await api("/api/save", { ...snapshot(), edit_id: id, text });
  } catch (e) {
    state.saving = false;
    // 旧草稿的失败不得提示在新草稿上
    if (state.gen === gen && state.editingId === id) {
      errBox.innerHTML = e.errors.map((m) => `<li>${esc(m)}</li>`).join("");
      errBox.hidden = false;
      paintEditorBusy();
    }
    return;
  }
  state.saving = false;
  // 旧保存结果不得作用于新草稿；条款已不在则丢弃
  if (state.gen !== gen || state.editingId !== id) return;
  const clause = state.clauses.find((c) => c.id === id);
  if (!clause) return;
  clause.body = data.body;
  state.editingId = null;
  render();
}

// --------------------------------------------------------------------------- //
// 拖拽重排
// --------------------------------------------------------------------------- //
function attachDnd() {
  for (const card of clauseList.querySelectorAll(".card")) {
    const grip = card.querySelector(".grip");
    grip.addEventListener("mousedown", () => {
      if (!state.editingId && !state.merging) card.draggable = true;
    });
    card.addEventListener("mouseup", () => (card.draggable = false));

    card.addEventListener("dragstart", (ev) => {
      if (state.editingId || state.merging) {
        ev.preventDefault();
        return;
      }
      state.dragId = card.dataset.id;
      card.classList.add("dragging");
      ev.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.draggable = false;
      card.classList.remove("dragging");
      clauseList.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      state.dragId = null;
    });
    card.addEventListener("dragover", (ev) => {
      if (!state.dragId || state.dragId === card.dataset.id) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      clauseList.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      card.classList.add("drag-over");
    });
    card.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const targetId = card.dataset.id;
      if (!state.dragId || state.dragId === targetId) return;
      const rect = card.getBoundingClientRect();
      const after = ev.clientY > rect.top + rect.height / 2;
      moveClause(state.dragId, targetId, after);
    });
  }
}

function moveClause(srcId, targetId, after) {
  const ids = state.orderIds.filter((x) => x !== srcId);
  let idx = ids.indexOf(targetId);
  if (after) idx += 1;
  ids.splice(idx, 0, srcId);
  state.orderIds = ids;
  render();
}

// --------------------------------------------------------------------------- //
// 下载（以服务端 /api/export 为准；仅在预览追上当前草稿时允许，且结果须对版）
// --------------------------------------------------------------------------- //
downloadBtn.addEventListener("click", async () => {
  if (state.merging || state.exporting) return;
  if (!isPreviewFresh()) return; // 预览未追上最新改动时禁止下载
  const gen = state.gen;
  const sentKey = currentKey();
  state.exporting = true;
  paintChrome();

  let data;
  try {
    data = await api("/api/export", snapshot());
  } catch (e) {
    state.exporting = false;
    if (state.gen === gen) {
      paintChrome();
      alert(e.errors.join("\n"));
    }
    return;
  }
  state.exporting = false;
  // 下载内容必须仍与页面上的列表 / 预览是同一份草稿
  if (state.gen !== gen || currentKey() !== sentKey) {
    paintChrome();
    if (state.gen === gen) alert("草稿已有更新，请等预览刷新后重新下载。");
    return;
  }
  const blob = new Blob([data.text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  a.href = url;
  a.download = `clauses-${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  paintChrome();
});
