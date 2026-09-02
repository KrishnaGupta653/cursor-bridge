/**
 * DOM extraction scripts for Cursor Agent UI via Runtime.evaluate.
 *
 * Cursor is Electron; UI changes over time. Heuristics prefer broad text /
 * accessibility signals over brittle CSS. Never invent conversation/plan data.
 */

export const EXTRACT_AGENT_DOM_SCRIPT = `(() => {
  const notes = [];
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const now = new Date().toISOString();

  function hashId(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function roleFromEl(el, text) {
    const t = (text || '').toLowerCase();
    const attrs = [
      el.getAttribute('data-message-role'),
      el.getAttribute('data-role'),
      el.getAttribute('data-author'),
      el.getAttribute('aria-label'),
      el.className && String(el.className),
    ].filter(Boolean).join(' ').toLowerCase();
    if (/\\b(user|human|you)\\b/.test(attrs)) return 'user';
    if (/\\b(assistant|agent|ai|bot|model)\\b/.test(attrs)) return 'assistant';
    if (/\\b(tool|terminal|command|reading|edited)\\b/.test(attrs)) return 'tool';
    if (/^(you|user|human)\\b/.test(t)) return 'user';
    if (/^(assistant|agent|cursor|ai)\\b/.test(t)) return 'assistant';
    if (/^(running command|reading file|edited |searched |grep |terminal)/i.test(t)) return 'tool';
    // Layout heuristic: user bubbles often right-aligned / blue-ish containers
    try {
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth || 1200;
      if (r.width > 40 && r.left > vw * 0.45) return 'user';
    } catch (_) {}
    return 'assistant';
  }

  function isSkippableChrome(text) {
    return /^(file|edit|selection|view|go|run|terminal|help|new chat|search|pinned|repositories|more|copy|insert|apply|undo|redo)$/i.test(text)
      || /^(new chat|search|automations|customize)\\b/i.test(text);
  }

  // Do NOT use [class*="sidebar"] — Cursor body has "unifiedsidebarhidden"
  // which matches that selector and would drop every conversation node.
  function isInsideSidebar(el) {
    if (!el || !el.closest) return false;
    if (el.closest('nav.ui-sidebar, .ui-sidebar, .glass-sidebar-agent-list-container, aside.ui-sidebar')) {
      return true;
    }
    // Narrow class match: whole token contains "sidebar" but not body chrome flags
    let n = el;
    while (n && n !== document.documentElement) {
      if (n === document.body) break;
      const cls = String(n.className || '');
      if (/\\b(ui-sidebar|glass-sidebar|agents-sidebar)\\b/i.test(cls)) return true;
      n = n.parentElement;
    }
    return false;
  }

  function isChromeMetaText(text) {
    return /^(thought\\s+\\d+s|\\d+[smhd]\\s+ago|copy|insert|apply|undo|redo|thinking…|working…)$/i.test(text)
      || /^\\d+[smhd]\\s+ago$/i.test(text)
      || /^worked for\\b/i.test(text)
      || (/^thought\\s+/i.test(text) && text.length < 40);
  }

  // Workspace / window title (best-effort from document title)
  let workspace = '';
  const docTitle = clean(document.title || '');
  if (docTitle) {
    const parts = docTitle.split(/[—\\-|]/);
    workspace = clean(parts[parts.length - 1] || docTitle).slice(0, 120);
  }
  // Prefer Agents sidebar section head for repo name
  try {
    const activeHead = document.querySelector('.ui-sidebar-section-head [aria-expanded="true"], .ui-sidebar-section-head');
    const headText = clean(activeHead && activeHead.innerText);
    if (headText && headText.length < 80 && !/pinned|repositories/i.test(headText)) {
      workspace = headText;
    }
  } catch (_) {}

  // Model label if visible near agent chrome
  let model = '';
  try {
    const modelEl = Array.from(document.querySelectorAll('button, [role="combobox"], [class*="model"]'))
      .find((el) => /claude|gpt|sonnet|opus|gemini|composer|cursor|o[134]|haiku|flash/i.test(el.innerText || ''));
    if (modelEl) model = clean(modelEl.innerText || '').slice(0, 80);
  } catch (_) {}

  // Prefer Cursor Agents composer turns (virtualized rows) — live + visible history
  const messages = [];
  const seenIds = new Set();
  const seenText = new Set();

  function pushMessage(role, text, el) {
    text = clean(text);
    if (!text || text.length < 2 || text.length > 50000) return;
    if (isSkippableChrome(text) || isChromeMetaText(text)) return;
    if (role !== 'user' && text.split(/\\s+/).length < 2 && text.length < 6) return;
    const domId = (el && (el.getAttribute('data-message-id') || el.getAttribute('data-id'))) || '';
    const id = domId || ('dom-' + hashId(role + '::' + text.slice(0, 96)));
    if (seenIds.has(id)) {
      const existing = messages.find((m) => m.id === id);
      if (existing && text.length > existing.text.length) existing.text = text;
      return;
    }
    const textKey = role + '::' + text.slice(0, 160);
    if (seenText.has(textKey)) return;
    // Drop shorter duplicate of same role
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== role) continue;
      if (m.text === text) return;
      if (text.startsWith(m.text) && text.length > m.text.length + 8) {
        messages.splice(i, 1);
        seenIds.delete(m.id);
        seenText.delete(m.role + '::' + m.text.slice(0, 160));
        continue;
      }
      if (m.text.startsWith(text) && m.text.length > text.length + 8) return;
    }
    seenIds.add(id);
    seenText.add(textKey);
    messages.push({
      id,
      role,
      text: text.slice(0, 50000),
      status: 'complete',
      timestamp: now,
    });
  }

  function extractFromComposerRows() {
    const rows = document.querySelectorAll(
      '.composer-react-virtual-plane-row, .virtualized-composer-messages-row, .agent-transcript-row'
    );
    if (!rows.length) return 0;
    rows.forEach((row) => {
      if (isInsideSidebar(row)) return;
      // User turn
      const human = row.querySelector(
        '.composer-human-message-content, .composer-human-message, .composer-human-message-container'
      );
      if (human) {
        pushMessage('user', human.innerText || human.textContent || '', human);
        return;
      }
      // Assistant markdown turn
      const md = row.querySelector(
        '.agent-transcript-row-markdown .ui-markdown, .agent-transcript-row-markdown, .markdown-root, .ui-markdown'
      );
      if (md) {
        pushMessage('assistant', md.innerText || md.textContent || '', md);
        return;
      }
      // Tool / work group — keep as tool when substantive
      const work = row.querySelector('.agent-transcript-work-group, [class*="tool"]');
      if (work) {
        const t = clean(work.innerText || '');
        if (t.length > 12 && !isChromeMetaText(t)) pushMessage('tool', t.slice(0, 2000), work);
      }
    });
    return messages.length;
  }

  let composerHits = 0;
  try { composerHits = extractFromComposerRows(); } catch (_) {}

  // Fallback: older / non-Agents chat surfaces
  if (composerHits === 0) {
    const selectorGroups = [
      '[data-message-id]',
      '[data-testid*="message"]',
      '.composer-rendered-message',
      '[class*="composer-human-message"]',
      '[class*="chat-message"]',
      '[class*="message-content"]',
      '[class*="markdown-root"]',
      'article',
    ];
    const candidates = [];
    const seenNodes = new Set();
    for (const sel of selectorGroups) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch { continue; }
      nodes.forEach((el) => {
        if (seenNodes.has(el) || isInsideSidebar(el)) return;
        seenNodes.add(el);
        candidates.push(el);
      });
    }
    for (const el of candidates) {
      const cls = String(el.className || '').toLowerCase();
      let role = roleFromEl(el, el.innerText || '');
      if (/human|user/.test(cls)) role = 'user';
      else if (/agent-transcript|markdown|assistant|ai-/.test(cls)) role = 'assistant';
      // Prefer leaf human content over outer wrappers
      if (/composer-rendered-message/.test(cls) && el.querySelector('.composer-human-message')) {
        const human = el.querySelector('.composer-human-message-content, .composer-human-message');
        if (human) {
          pushMessage('user', human.innerText || '', human);
          continue;
        }
      }
      pushMessage(role, el.innerText || el.textContent || '', el);
      if (messages.length >= 120) break;
    }
  }

  notes.push('Extracted ' + messages.length + ' conversation node(s)' + (composerHits ? ' (composer)' : ''));

  let pendingApproval = null;
  const bodyText = clean(document.body ? document.body.innerText : '');
  const approvalHints = [
    /run\\s+this\\s+command/i,
    /allow\\s+this/i,
    /approve/i,
    /permission/i,
    /wants?\\s+to\\s+run/i,
    /accept\\s+and\\s+run/i,
    /run command/i,
  ];
  const hasApprovalUi = approvalHints.some((re) => re.test(bodyText));
  if (hasApprovalUi) {
    let detail = '';
    const code = document.querySelector('code, pre, [class*="command"], [class*="terminal"]');
    if (code) detail = clean(code.innerText || code.textContent || '').slice(0, 500);
    if (!detail) {
      const m = bodyText.match(/(?:run|execute|command)[:\\s]+(.{8,200})/i);
      detail = m ? m[1] : 'A permission / approval prompt is visible in Cursor.';
    }
    pendingApproval = {
      id: 'perm-' + Date.now(),
      title: 'Permission Required',
      detail,
      rawText: bodyText.slice(0, 800),
    };
    notes.push('Permission UI heuristics matched page text (PARTIALLY_SUPPORTED)');
  }

  let state = 'UNKNOWN';
  if (pendingApproval) state = 'WAITING_FOR_PERMISSION';
  else if (/generating|thinking|running|working|executing|streaming/i.test(bodyText)) state = 'RUNNING';
  else if (/waiting for (your )?input|continue|type a message/i.test(bodyText)) state = 'WAITING_FOR_INPUT';
  else if (messages.length > 0) state = 'IDLE';
  else {
    state = 'UNKNOWN';
    notes.push('No reliable chat messages found in DOM');
  }

  // Plan heuristics
  let plan = { title: '', steps: [], available: false, support: 'NOT_CURRENTLY_ACCESSIBLE' };
  const planHeader = Array.from(document.querySelectorAll('h1,h2,h3,[class*="plan"]'))
    .find((el) => /plan/i.test(el.textContent || ''));
  if (planHeader) {
    const steps = [];
    const list = planHeader.parentElement && planHeader.parentElement.querySelectorAll('li, [class*="step"]');
    if (list) {
      list.forEach((li, i) => {
        const t = clean(li.innerText || '');
        if (!t) return;
        let status = 'unknown';
        const low = t.toLowerCase();
        if (/✓|✔|done|completed/i.test(t) || li.querySelector('[class*="complete"]')) status = 'completed';
        else if (/●|running|in progress/i.test(t)) status = 'running';
        else if (/○|pending|todo/i.test(t)) status = 'pending';
        steps.push({ id: 'step-' + i, text: t.slice(0, 300), status });
      });
    }
    plan = {
      title: clean(planHeader.textContent || 'Plan'),
      steps,
      available: steps.length > 0,
      support: steps.length > 0 ? 'PARTIALLY_SUPPORTED' : 'NOT_CURRENTLY_ACCESSIBLE',
    };
    if (!steps.length) notes.push('Plan header found but steps unavailable');
  } else {
    notes.push('Plan UI not detected');
  }

  // File changes — SCM / explorer heuristics (often NOT accessible in Agent webview)
  const fileChanges = { items: [], available: false, support: 'NOT_CURRENTLY_ACCESSIBLE', note: 'File change list not reliably exposed in Agent DOM' };
  const scmCandidates = document.querySelectorAll('[class*="scm"], [class*="monaco-list-row"], [aria-label*="Changes"]');
  const fileItems = [];
  const fileSeen = new Set();
  scmCandidates.forEach((el) => {
    const t = clean(el.getAttribute('aria-label') || el.innerText || '');
    if (!t || t.length > 200) return;
    if (!/\\.[a-z0-9]{1,8}\\b/i.test(t) && !/[\\\\/]/.test(t)) return;
    if (fileSeen.has(t)) return;
    fileSeen.add(t);
    let changeType = 'unknown';
    if (/^M\\b|modified/i.test(t)) changeType = 'modified';
    else if (/^A\\b|added|new file/i.test(t)) changeType = 'added';
    else if (/^D\\b|deleted/i.test(t)) changeType = 'deleted';
    fileItems.push({ path: t.slice(0, 200), changeType });
  });
  if (fileItems.length > 0) {
    fileChanges.items = fileItems.slice(0, 40);
    fileChanges.available = true;
    fileChanges.support = 'PARTIALLY_SUPPORTED';
    fileChanges.note = 'Detected via SCM/list heuristics; diffs may be unavailable';
  }

  // Activity lines from body / tool-looking messages
  const activity = [];
  const activityPatterns = [
    { re: /reading\\s+[\\w./\\\\-]+/i, kind: 'reading' },
    { re: /running\\s+(command|tests?|npm|yarn|pnpm)/i, kind: 'command' },
    { re: /thinking|generating|working/i, kind: 'thinking' },
    { re: /permission|waiting for approval|approve/i, kind: 'permission' },
    { re: /completed|done|finished/i, kind: 'completed' },
    { re: /error|failed/i, kind: 'error' },
  ];
  const lines = bodyText.split(/(?<=[.!?])\\s+|\\n/).map(clean).filter((l) => l.length > 8 && l.length < 180);
  let latestActivity = '';
  for (const line of lines.slice(-20)) {
    for (const p of activityPatterns) {
      if (p.re.test(line)) {
        activity.push({ id: 'act-' + activity.length, text: line, kind: p.kind, timestamp: now });
        latestActivity = line;
        break;
      }
    }
    if (activity.length >= 15) break;
  }
  if (state === 'RUNNING' && !latestActivity) {
    latestActivity = 'Agent working…';
    activity.push({ id: 'act-running', text: latestActivity, kind: 'thinking', timestamp: now });
  }
  if (pendingApproval) {
    latestActivity = 'Waiting for permission';
    activity.unshift({
      id: 'act-perm',
      text: 'Waiting for permission: ' + (pendingApproval.detail || '').slice(0, 100),
      kind: 'permission',
      timestamp: now,
    });
  }

  if (messages.length === 0) {
    notes.push('Conversation extraction: PARTIALLY_SUPPORTED / may be empty for this target');
  }

  const fingerprint = [
    state,
    workspace,
    model,
    messages.length,
    messages.map((m) => m.id + ':' + m.text.length + ':' + m.text.slice(0, 48)).join('|').slice(0, 800),
    pendingApproval ? pendingApproval.detail.slice(0, 80) : '',
    plan.steps.map((s) => s.status + s.text.slice(0, 20)).join('|').slice(0, 200),
    fileChanges.items.map((f) => f.path).join('|').slice(0, 200),
    latestActivity.slice(0, 80),
  ].join('::');

  return {
    messages: messages.slice(-100),
    state,
    pendingApproval,
    plan,
    fileChanges,
    activity: activity.slice(0, 20),
    workspace,
    model: model || undefined,
    latestActivity,
    notes,
    fingerprint,
  };
})()`;

export const FIND_COMPOSER_AND_SUBMIT_SCRIPT = (text: string) => {
  const escaped = JSON.stringify(text);
  return `(() => {
    const text = ${escaped};
    const candidates = [
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
      'div.monaco-mouse-cursor-text',
      '[class*="composer"] textarea',
      '[class*="chat"] textarea',
      '[data-testid*="composer"]',
      '[aria-label*="Chat"]',
      '[aria-label*="Message"]',
      '[aria-label*="Agent"]',
      '[placeholder*="message" i]',
      '[placeholder*="Ask" i]',
      '[placeholder*="Plan" i]',
    ];
    let el = null;
    for (const sel of candidates) {
      try {
        const found = document.querySelector(sel);
        if (found) { el = found; break; }
      } catch (_) {}
    }
    if (!el) {
      return { ok: false, error: 'Composer input not found in DOM', support: 'NOT_CURRENTLY_ACCESSIBLE' };
    }
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.innerText = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    } else {
      return { ok: false, error: 'Composer element is not editable', support: 'NOT_CURRENTLY_ACCESSIBLE' };
    }
    const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
    el.dispatchEvent(enter);
    const enterUp = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
    el.dispatchEvent(enterUp);
    return { ok: true, support: 'PARTIALLY_SUPPORTED' };
  })()`;
};

export const CLICK_APPROVAL_SCRIPT = (approve: boolean) => {
  const want = approve ? "approve" : "reject";
  return `(() => {
    const want = ${JSON.stringify(want)};
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
    const score = (label) => {
      const t = (label || '').toLowerCase();
      if (want === 'approve') {
        if (/^(approve|allow|accept|run|continue|yes)$/i.test(t.trim())) return 10;
        if (/approve|allow|accept|run command|accept and/i.test(t)) return 6;
        if (/reject|deny|cancel|no/i.test(t)) return -5;
      } else {
        if (/^(reject|deny|cancel|no)$/i.test(t.trim())) return 10;
        if (/reject|deny|cancel/i.test(t)) return 6;
        if (/approve|allow|accept|run/i.test(t)) return -5;
      }
      return 0;
    };
    let best = null;
    let bestScore = 0;
    for (const b of buttons) {
      const label = (b.innerText || b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
      const s = score(label);
      if (s > bestScore) { bestScore = s; best = b; }
    }
    if (!best || bestScore <= 0) {
      return { ok: false, error: 'No matching approval button found', support: 'NOT_CURRENTLY_ACCESSIBLE' };
    }
    best.click();
    return { ok: true, label: (best.innerText || '').trim().slice(0, 80), support: 'PARTIALLY_SUPPORTED' };
  })()`;
};

/**
 * Best-effort scrape of Cursor Agents sidebar history (Pinned + Repositories).
 * PARTIALLY_SUPPORTED — DOM can change; only visible items are returned.
 */
export const EXTRACT_AGENTS_HISTORY_SCRIPT = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const items = [];
  const skipTitle = /^(more|new chat|search|automations|customize|no agents yet|pinned|repositories)$/i;

  document.querySelectorAll('section.ui-sidebar-section, .ui-sidebar-section').forEach((sec, si) => {
    const head = sec.querySelector('.ui-sidebar-section-head, [class*="sidebar-section-head"]');
    const group = clean(head ? (head.innerText || '') : '') || 'Repository';
    const isPinnedGroup = /^pinned$/i.test(group);
    // Repositories header is a container — skip empty chrome; keep real repo sections
    if (/^repositories$/i.test(group) && sec.querySelectorAll('li.ui-sidebar-menu-item, .ui-sidebar-menu-item').length === 0) {
      return;
    }
    sec.querySelectorAll('li.ui-sidebar-menu-item, .ui-sidebar-menu-item').forEach((li, ii) => {
      const titleEl = li.querySelector('.ui-sidebar-menu-button-content, [class*="menu-button-content"]');
      const timeEl = li.querySelector('.ui-sidebar-menu-button-end, [class*="menu-button-end"]');
      let title = clean(titleEl ? titleEl.innerText : (li.innerText || ''));
      const relativeTime = clean(timeEl ? timeEl.innerText : '');
      if (!title || skipTitle.test(title)) return;
      if (relativeTime && title.endsWith(relativeTime)) {
        title = clean(title.slice(0, -relativeTime.length));
      }
      if (!title || skipTitle.test(title)) return;
      items.push({
        id: (isPinnedGroup ? 'pin-' : 'hist-') + si + '-' + ii + '-' + title.slice(0, 48),
        title: title.slice(0, 160),
        relativeTime,
        group: isPinnedGroup ? 'Pinned' : group.slice(0, 120),
        kind: isPinnedGroup ? 'pinned' : 'history',
      });
    });
  });

  document.querySelectorAll('.ui-sidebar-group').forEach((g, gi) => {
    const label = clean((g.querySelector('.ui-sidebar-group-label') || {}).innerText || '');
    if (!/pinned/i.test(label)) return;
    g.querySelectorAll('li.ui-sidebar-menu-item').forEach((li, ii) => {
      const titleEl = li.querySelector('.ui-sidebar-menu-button-content');
      const timeEl = li.querySelector('.ui-sidebar-menu-button-end');
      const title = clean(titleEl ? titleEl.innerText : '');
      const relativeTime = clean(timeEl ? timeEl.innerText : '');
      if (!title || skipTitle.test(title)) return;
      items.push({
        id: 'pin-' + gi + '-' + ii + '-' + title.slice(0, 48),
        title: title.slice(0, 160),
        relativeTime,
        group: 'Pinned',
        kind: 'pinned',
      });
    });
  });

  const seen = new Set();
  const dedup = [];
  for (const it of items) {
    const k = it.group + '::' + it.title;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(it);
  }
  return {
    available: dedup.length > 0,
    support: dedup.length > 0 ? 'PARTIALLY_SUPPORTED' : 'NOT_CURRENTLY_ACCESSIBLE',
    items: dedup.slice(0, 100),
    count: dedup.length,
    note: 'History scraped from Cursor Agents sidebar DOM. Only currently visible rows. Opening is best-effort click.',
  };
})()`;

export const CLICK_AGENT_HISTORY_SCRIPT = (
  title: string,
  group?: string
) => {
  const t = JSON.stringify(title);
  const g = JSON.stringify(group || "");
  return `(() => {
    const wantTitle = ${t};
    const wantGroup = ${g};
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const items = Array.from(document.querySelectorAll('li.ui-sidebar-menu-item, .ui-sidebar-menu-item'));
    let best = null;
    for (const li of items) {
      const titleEl = li.querySelector('.ui-sidebar-menu-button-content, [class*="menu-button-content"]');
      const title = clean(titleEl ? titleEl.innerText : (li.innerText || ''));
      if (title !== wantTitle && !title.startsWith(wantTitle)) continue;
      if (wantGroup) {
        const sec = li.closest('section.ui-sidebar-section, .ui-sidebar-section, .ui-sidebar-group');
        const head = sec && (sec.querySelector('.ui-sidebar-section-head, .ui-sidebar-group-label, [class*="sidebar-section-head"]'));
        const group = clean(head ? head.innerText : '');
        if (group && group !== wantGroup && !/pinned/i.test(wantGroup)) {
          // allow match if group empty
          if (!group.includes(wantGroup) && !wantGroup.includes(group)) continue;
        }
      }
      best = li.querySelector('button, [role="button"], a') || li;
      break;
    }
    if (!best) {
      return { ok: false, error: 'History item not found in sidebar DOM', support: 'PARTIALLY_SUPPORTED' };
    }
    best.click();
    return { ok: true, support: 'PARTIALLY_SUPPORTED', title: wantTitle };
  })()`;
};

