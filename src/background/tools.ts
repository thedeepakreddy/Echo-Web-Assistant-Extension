import { requestApproval, logAction, safeNavigationUrl, currentTaskEpoch, sensitiveAction } from './safety';
import { cacheClear } from './response-cache';
import { agentScope, assertInScope, assertIsolatedUrl } from './isolation';
import { DEFAULT_SCOPE, adoptChildTab, scopeForTab, tabAccessible } from './agents/leases';

/**
 * An agent may only reach its own tab and the tabs it opened; the classic ECHO
 * may reach any tab no avatar holds. Checked wherever a tool picks a new tab.
 */
function assertTabAccess(fromTabId: number | undefined, targetTabId: number): void {
  const scope = scopeForTab(fromTabId);
  if (tabAccessible(scope, targetTabId)) return;
  throw new Error(scope === DEFAULT_SCOPE
    ? 'That tab is assigned to an ECHO avatar, so it is left alone.'
    : 'You can only use your own tab and the tabs you opened from it.');
}

// Poll until a tab's status is 'complete' or the timeout fires.
// Resolves early on chrome.runtime.lastError so callers never hang.
function waitForTabLoad(tabId: number, timeout = 9000): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab || tab.status === 'complete') { resolve(); return; }
        if (Date.now() - start > timeout) { resolve(); return; }
        setTimeout(poll, 300);
      });
    };
    setTimeout(poll, 700); // give the navigation a moment to start
  });
}

// Tools that run inside the page and are forwarded to the content script.
// The second group is used by the local (Tier 0/1) stack rather than the model.
const DOM_ACTIONS = new Set([
  'read_screen', 'click_element', 'type_text', 'press_key',
  'scroll', 'find_on_page', 'get_page_text', 'extract_table',
  'go_back', 'go_forward', 'get_video_transcript',
  // local-stack actions
  'extract_pattern', 'fill_form', 'click_selector', 'read_value',
  'record_start', 'record_stop', 'play_step',
  'render_highlights', 'clear_highlights',
]);

export async function executeTool(toolName: string, args: any, tabId?: number): Promise<any> {
  // Stop signals and isolation belong to the scope that owns this tab.
  const epoch = currentTaskEpoch(tabId);
  // Isolated browsing: every tab-touching tool stays inside the private window.
  const scope = agentScope(scopeForTab(tabId));
  if (scope && (DOM_ACTIONS.has(toolName) || ['navigate', 'screenshot'].includes(toolName))) {
    await assertInScope(tabId);
  }
  if (DOM_ACTIONS.has(toolName)) {
    if (!tabId) throw new Error('No active tab to execute action');
    // Actions that change the page. They are all logged; only paying and
    // sending a mail or message wait for the user's approval.
    const guarded = ['click_element', 'click_selector', 'type_text', 'fill_form'].includes(toolName)
      || (toolName === 'press_key' && String(args?.key) === 'Enter');
    let detail = toolName.replace(/_/g, ' ');
    let approvalDetail = detail;
    let expectedLabel: string | undefined;
    if (guarded) {
      if (['click_element', 'click_selector', 'type_text'].includes(toolName)) {
        const inspection: any = await chrome.tabs.sendMessage(tabId, {
          type: 'DOM_ACTION', action: 'inspect_action', args: { action: toolName, ...args },
        });
        if (!inspection?.success) throw new Error('Could not inspect the target action.');
        if (toolName === 'type_text' && inspection.result?.sensitive) {
          throw new Error('ECHO will not type into password, payment, or verification fields.');
        }
        expectedLabel = inspection.result?.label;
        detail = `${detail}${toolName === 'type_text' && args?.submit ? ' and submit' : ''}: ${inspection.result?.label || 'page element'}`;
        approvalDetail = toolName === 'type_text'
          ? `${detail}. ${String(args?.text ?? '').length} characters (text hidden from this web page)`
          : detail;
      } else if (toolName === 'fill_form') {
        detail = 'fill form from saved data';
        approvalDetail = detail;
      }
      const pageUrl = (await chrome.tabs.get(tabId).catch(() => null))?.url || '';
      const kind = sensitiveAction({ tool: toolName, label: expectedLabel, url: pageUrl,
        key: String(args?.key ?? ''), submit: args?.submit === true });
      if (kind) {
        const prefix = kind === 'payment' ? 'Payment' : 'Send';
        const approved = await requestApproval(toolName, `${prefix}: ${approvalDetail}`, tabId);
        if (!approved) {
          await logAction(toolName, detail, 'denied');
          throw new Error('Action denied or approval timed out.');
        }
        if (currentTaskEpoch(tabId) !== epoch) throw new Error('Task stopped before the action.');
        await logAction(toolName, detail, 'approved');
      }
    }
    try {
      const result = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type: 'DOM_ACTION', action: toolName, args: { ...args, expectedLabel } }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response || !response.success) reject(new Error(response?.error || 'Action failed'));
        else resolve(response.result);
      });
      });
      if (guarded) await logAction(toolName, detail, 'done');
      return result;
    } catch (error) {
      if (guarded) await logAction(toolName, detail, 'failed');
      throw error;
    }
  }

  switch (toolName) {
    case 'screenshot': {
      if (!tabId) throw new Error('No tab to capture.');
      const target = await chrome.tabs.get(tabId);
      if (!target.active || target.windowId == null) throw new Error('Switch to the requested tab before capturing a screenshot.');
      if (currentTaskEpoch(tabId) !== epoch) throw new Error('Task stopped before screenshot.');
      await logAction('screenshot', 'current tab image', 'done');
      // captureVisibleTab captures the active tab in this exact window.
      return new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab(target.windowId, { format: 'png' }, (dataUrl) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve({ dataUrl });
        });
      });
    }

    case 'open_url': {
      const url = safeNavigationUrl(args.url);
      assertIsolatedUrl(url, tabId);
      if (currentTaskEpoch(tabId) !== epoch) throw new Error('Task stopped before navigation.');
      await logAction('open_url', new URL(url).origin, 'done');
      // Create the tab, wait for it to fully load, then return the NEW tab's id.
      // The brain loops watch for `newTabId` in the result and update their
      // activeTabId so all subsequent DOM actions go to the right tab.
      const newTab = await new Promise<chrome.tabs.Tab>((resolve, reject) => {
        chrome.tabs.create(scope ? { url, windowId: scope.windowId } : { url }, (tab) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(tab);
        });
      });
      // A tab an avatar opens is part of its lease: it may keep working there.
      const owner = scopeForTab(tabId);
      if (owner !== DEFAULT_SCOPE && newTab.id != null) await adoptChildTab(owner, newTab.id);
      await waitForTabLoad(newTab.id!);
      return { success: true, newTabId: newTab.id, message: `Opened ${args.url} in a new tab (id: ${newTab.id}). Use read_screen now to see it.` };
    }

    case 'navigate': {
      if (!tabId) throw new Error('No active tab to navigate');
      const url = safeNavigationUrl(args.url);
      assertIsolatedUrl(url, tabId);
      if (currentTaskEpoch(tabId) !== epoch) throw new Error('Task stopped before navigation.');
      await logAction('navigate', new URL(url).origin, 'done');
      await new Promise<void>((resolve, reject) => {
        chrome.tabs.update(tabId, { url }, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
      // Wait for the page to finish loading before the brain calls read_screen.
      await waitForTabLoad(tabId);
      return { success: true, message: `Navigated to ${args.url} — page loaded, ready for read_screen.` };
    }

    case 'list_tabs': {
      const caller = scopeForTab(tabId);
      return new Promise((resolve, reject) => {
        chrome.tabs.query(scope ? { windowId: scope.windowId } : {}, (tabs) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          const list = tabs.filter(t => t.id != null && tabAccessible(caller, t.id)).slice(0, 30).map(t => ({
            id: t.id,
            title: (t.title || '').substring(0, 70),
            url: (t.url || '').substring(0, 120),
            active: t.active
          }));
          resolve({ success: true, tabs: list });
        });
      });
    }

    case 'switch_tab': {
      assertTabAccess(tabId, Number(args.tabId));
      await assertInScope(Number(args.tabId));
      return new Promise((resolve, reject) => {
        chrome.tabs.update(Number(args.tabId), { active: true }, (tab) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (tab?.windowId != null) chrome.windows.update(tab.windowId, { focused: true });
          resolve({ success: true, message: `Switched to tab ${args.tabId}` });
        });
      });
    }

    case 'close_tab': {
      const targetTabId = Number(args.tabId);
      if (!Number.isInteger(targetTabId) || targetTabId <= 0) throw new Error('Invalid tab ID.');
      assertTabAccess(tabId, targetTabId);
      await assertInScope(targetTabId);
      if (currentTaskEpoch(tabId) !== epoch) throw new Error('Task stopped before closing the tab.');
      await logAction('close_tab', `tab ${targetTabId}`, 'done');
      return new Promise((resolve, reject) => {
        chrome.tabs.remove(targetTabId, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve({ success: true, message: `Closed tab ${args.tabId}` });
        });
      });
    }

    case 'download_data': {
      const content = String(args.content ?? '');
      const filename = String(args.filename || 'echo-download.txt');
      if (!/^[^/\\\x00-\x1f]{1,120}$/.test(filename) || filename === '.' || filename === '..')
        throw new Error('Invalid download filename.');
      if (currentTaskEpoch(tabId) !== epoch) throw new Error('Task stopped before download.');
      await logAction('download_data', filename, 'done');
      const mime = filename.endsWith('.json') ? 'application/json'
        : filename.endsWith('.csv') ? 'text/csv' : 'text/plain';
      const dataUrl = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
      return new Promise((resolve, reject) => {
        chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve({ success: true, message: `Downloaded ${filename}`, downloadId: id });
        });
      });
    }

    case 'list_memory': {
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_memory'], (result) => {
          const memory = (result.echo_memory || {}) as Record<string, string>;
          resolve({ success: true, memory });
        });
      });
    }

    case 'save_task': {
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_tasks'], (r) => {
          const tasks = (r.echo_tasks || {}) as Record<string, string>;
          tasks[args.name] = args.instructions;
          chrome.storage.local.set({ echo_tasks: tasks }, () =>
            resolve({ success: true, message: `Saved task '${args.name}'.` }));
        });
      });
    }

    case 'list_tasks': {
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_tasks'], (r) =>
          resolve({ success: true, tasks: (r.echo_tasks || {}) as Record<string, string> }));
      });
    }

    case 'delete_task': {
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_tasks'], (r) => {
          const tasks = (r.echo_tasks || {}) as Record<string, string>;
          delete tasks[args.name];
          chrome.storage.local.set({ echo_tasks: tasks }, () =>
            resolve({ success: true, message: `Deleted task '${args.name}'.` }));
        });
      });
    }

    case 'run_task': {
      // Returns the saved instructions so the model can carry them out in the
      // same loop with its normal tools (no nested agent invocation).
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_tasks'], (r) => {
          const tasks = (r.echo_tasks || {}) as Record<string, string>;
          const instructions = tasks[args.name];
          if (!instructions) resolve({ success: true, result: `No saved task named '${args.name}'. Saved tasks: ${Object.keys(tasks).join(', ') || '(none)'}` });
          else resolve({ success: true, result: `Now carry out this saved task step by step:\n${instructions}` });
        });
      });
    }

    case 'schedule_reminder': {
      const minutes = Math.max(0.5, Number(args.in_minutes) || 1);
      const alarmName = `echo_reminder_${Date.now()}`;
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_reminders'], (r) => {
          const reminders = (r.echo_reminders || {}) as Record<string, any>;
          reminders[alarmName] = { message: args.message || 'ECHO reminder', taskName: args.task_name || null };
          chrome.storage.local.set({ echo_reminders: reminders }, () => {
            chrome.alarms.create(alarmName, { delayInMinutes: minutes });
            resolve({ success: true, message: `Reminder set for ~${minutes} min from now.` });
          });
        });
      });
    }

    case 'save_memory': {
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_memory'], (result) => {
          const memory: Record<string, string> = (result.echo_memory || {}) as Record<string, string>;
          memory[args.key] = args.value;
          chrome.storage.local.set({ echo_memory: memory }, () => {
            resolve({ success: true, message: `Saved '${args.key}' to memory.` });
          });
        });
      });
    }

    case 'delete_memory': {
      return new Promise((resolve) => {
        chrome.storage.local.get(['echo_memory'], (result) => {
          const memory: Record<string, string> = (result.echo_memory || {}) as Record<string, string>;
          delete memory[args.key];
          chrome.storage.local.set({ echo_memory: memory }, async () => {
            await cacheClear();
            // Memories are shared by every avatar, so every conversation forgets.
            const { forgetCloudConversationAfterReply } = await import('./brain');
            forgetCloudConversationAfterReply();
            resolve({ success: true, message: `Deleted '${args.key}' from memory.` });
          });
        });
      });
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
