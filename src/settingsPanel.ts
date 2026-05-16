/**
 * Sidebar webview panel for managing xmlDiffAndPatch.folderPairs
 * at all settings scopes (User, Workspace, per-folder).
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';

interface FolderPairRaw {
  modifiedFolder?: string;
  diffFolder?: string;
  pathPrefix?: string;
}

interface ScopeData {
  label: string;
  /** 'global' | 'workspace' | 'folder:<folderName>' */
  target: string;
  pairs: FolderPairRaw[];
}

export class SettingsPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'xmlDiffAndPatch.settingsPanel';

  constructor(private readonly _outputChannel: vscode.OutputChannel) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    const disposables: vscode.Disposable[] = [];

    // Dispose all listeners when the view is destroyed
    webviewView.onDidDispose(() => disposables.forEach(d => d.dispose()), null, disposables);

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    const sendData = (): void => {
      webviewView.webview.postMessage({ type: 'init', scopes: this._buildScopes() });
    };

    webviewView.webview.onDidReceiveMessage(
      async (msg: { type: string; target: string; pairs: FolderPairRaw[] }) => {
        if (msg.type === 'ready') {
          sendData();
        } else if (msg.type === 'save') {
          await this._saveScope(msg.target, msg.pairs);
          webviewView.webview.postMessage({ type: 'saved' });
        }
      },
      null,
      disposables
    );

    // Refresh when folderPairs change externally (e.g. via settings.json)
    vscode.workspace.onDidChangeConfiguration(
      (e) => { if (e.affectsConfiguration('xmlDiffAndPatch.folderPairs')) sendData(); },
      null,
      disposables
    );
  }

  // ─── Data helpers ──────────────────────────────────────────────────────────

  private _buildScopes(): ScopeData[] {
    const scopes: ScopeData[] = [];

    // inspect() on the global cfg gives values at all scopes in one call
    const ins = vscode.workspace
      .getConfiguration('xmlDiffAndPatch')
      .inspect<FolderPairRaw[]>('folderPairs');

    scopes.push({ label: 'User', target: 'global', pairs: ins?.globalValue ?? [] });

    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      scopes.push({ label: 'Workspace', target: 'workspace', pairs: ins?.workspaceValue ?? [] });
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const fi = vscode.workspace
        .getConfiguration('xmlDiffAndPatch', folder.uri)
        .inspect<FolderPairRaw[]>('folderPairs');
      scopes.push({
        label: folder.name,
        target: `folder:${folder.name}`,
        pairs: fi?.workspaceFolderValue ?? [],
      });
    }

    return scopes;
  }

  private async _saveScope(target: string, pairs: FolderPairRaw[]): Promise<void> {
    const normalised = pairs
      .map(p => {
        const entry: FolderPairRaw = {
          modifiedFolder: p.modifiedFolder?.trim() || undefined,
          diffFolder: p.diffFolder?.trim() || undefined,
        };
        const pfx = p.pathPrefix?.trim();
        if (pfx) entry.pathPrefix = pfx;
        return entry;
      })
      .filter(p => p.modifiedFolder || p.diffFolder); // discard blank rows

    const value: FolderPairRaw[] | undefined = normalised.length > 0 ? normalised : undefined;

    try {
      if (target === 'global') {
        const cfg = vscode.workspace.getConfiguration('xmlDiffAndPatch');
        await cfg.update('folderPairs', value, vscode.ConfigurationTarget.Global);
      } else if (target === 'workspace') {
        const cfg = vscode.workspace.getConfiguration('xmlDiffAndPatch');
        await cfg.update('folderPairs', value, vscode.ConfigurationTarget.Workspace);
      } else if (target.startsWith('folder:')) {
        const name = target.slice(7);
        const folder = vscode.workspace.workspaceFolders?.find(f => f.name === name);
        if (folder) {
          const cfg = vscode.workspace.getConfiguration('xmlDiffAndPatch', folder.uri);
          await cfg.update('folderPairs', value, vscode.ConfigurationTarget.WorkspaceFolder);
        }
      }
      this._outputChannel.appendLine(
        `[INFO]  [settingsPanel] Saved folderPairs for scope: ${target}`
      );
    } catch (err) {
      this._outputChannel.appendLine(`[ERROR] [settingsPanel] Failed to save: ${err}`);
      vscode.window.showErrorMessage(`XML Diff & Patch: Failed to save settings — ${err}`);
    }
  }

  // ─── HTML ──────────────────────────────────────────────────────────────────

  private _getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    // The inline script uses ES5-style code (no template literals) to avoid
    // escaping issues inside the TypeScript template literal.
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
*{box-sizing:border-box;}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);
  color:var(--vscode-foreground);background:transparent;padding:8px;margin:0;}
select,input{width:100%;background:var(--vscode-input-background);
  color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border,rgba(128,128,128,.4));
  padding:3px 6px;margin-bottom:4px;font-family:inherit;font-size:inherit;}
select:focus,input:focus{outline:1px solid var(--vscode-focusBorder);
  outline-offset:-1px;border-color:var(--vscode-focusBorder);}
.pair{border:1px solid var(--vscode-widget-border,rgba(128,128,128,.35));
  padding:8px;margin-bottom:6px;border-radius:2px;}
.pair-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}
.pair-title{font-weight:600;font-size:.9em;}
label{display:block;font-size:.82em;margin-bottom:2px;color:var(--vscode-descriptionForeground);}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);
  border:none;padding:3px 10px;cursor:pointer;border-radius:2px;
  font-size:.85em;font-family:inherit;}
button:hover{background:var(--vscode-button-hoverBackground);}
.btn-sec{background:var(--vscode-button-secondaryBackground);
  color:var(--vscode-button-secondaryForeground);}
.btn-sec:hover{background:var(--vscode-button-secondaryHoverBackground);}
.btn-rmv{background:transparent;color:var(--vscode-errorForeground);padding:2px 6px;}
.btn-rmv:hover{background:var(--vscode-inputValidation-errorBackground,rgba(200,0,0,.15));}
.scope-row{margin-bottom:8px;}
.lbl{font-size:.82em;color:var(--vscode-descriptionForeground);margin-bottom:2px;}
.actions{display:flex;gap:6px;margin-top:8px;align-items:center;}
.empty{color:var(--vscode-descriptionForeground);font-style:italic;font-size:.85em;padding:4px 0;}
.saved{color:var(--vscode-charts-green,#4ec9b0);font-size:.82em;display:none;}
.section-title{font-size:1em;font-weight:600;margin-bottom:8px;color:var(--vscode-foreground);}
</style>
</head>
<body>
<div class="section-title">Folder Pairs</div>
<div class="scope-row">
  <div class="lbl">Scope</div>
  <select id="scopeSel"></select>
</div>
<div id="pairs"></div>
<div class="actions">
  <button class="btn-sec" id="btnAdd">+ Add Pair</button>
  <button id="btnSave">Save</button>
  <span class="saved" id="ok">Saved</span>
</div>
<script nonce="${nonce}">
(function () {
  var vsc = acquireVsCodeApi();
  var scopes = [];
  var idx = 0;
  var sel = document.getElementById('scopeSel');
  var pairsDiv = document.getElementById('pairs');
  var btnAdd = document.getElementById('btnAdd');
  var btnSave = document.getElementById('btnSave');
  var okSpan = document.getElementById('ok');

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function renderSel() {
    sel.innerHTML = '';
    scopes.forEach(function (s, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = s.label;
      sel.appendChild(opt);
    });
    sel.value = String(idx);
  }

  function renderPairs() {
    var sc = scopes[idx];
    if (!sc || sc.pairs.length === 0) {
      pairsDiv.innerHTML = '<p class="empty">No folder pairs defined for this scope.</p>';
      return;
    }
    var html = '';
    sc.pairs.forEach(function (p, i) {
      html += '<div class="pair">';
      html += '<div class="pair-hdr">';
      html += '<span class="pair-title">Pair ' + (i + 1) + '</span>';
      html += '<button class="btn-rmv" data-i="' + i + '">\u2715 Remove</button>';
      html += '</div>';
      html += '<label>Modified Folder *</label>';
      html += '<input class="f-mod" data-i="' + i + '" value="' + esc(p.modifiedFolder) + '">';
      html += '<label>Diff Folder *</label>';
      html += '<input class="f-dif" data-i="' + i + '" value="' + esc(p.diffFolder) + '">';
      html += '<label>Path Prefix</label>';
      html += '<input class="f-pfx" data-i="' + i + '" value="' + esc(p.pathPrefix) + '">';
      html += '</div>';
    });
    pairsDiv.innerHTML = html;

    pairsDiv.querySelectorAll('.btn-rmv').forEach(function (b) {
      b.addEventListener('click', function () {
        scopes[idx].pairs.splice(Number(b.dataset.i), 1);
        okSpan.style.display = 'none';
        renderPairs();
      });
    });
    pairsDiv.querySelectorAll('input').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var p = scopes[idx].pairs[Number(inp.dataset.i)];
        if (inp.classList.contains('f-mod'))      p.modifiedFolder = inp.value;
        else if (inp.classList.contains('f-dif')) p.diffFolder = inp.value;
        else if (inp.classList.contains('f-pfx')) p.pathPrefix = inp.value;
        okSpan.style.display = 'none';
      });
    });
  }

  sel.addEventListener('change', function () {
    idx = Number(sel.value);
    renderPairs();
  });

  btnAdd.addEventListener('click', function () {
    scopes[idx].pairs.push({ modifiedFolder: '', diffFolder: '', pathPrefix: '' });
    okSpan.style.display = 'none';
    renderPairs();
    // Focus the first field of the new pair
    var inputs = pairsDiv.querySelectorAll('.f-mod');
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  });

  btnSave.addEventListener('click', function () {
    vsc.postMessage({ type: 'save', target: scopes[idx].target, pairs: scopes[idx].pairs });
  });

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m.type === 'init') {
      scopes = m.scopes;
      if (idx >= scopes.length) idx = 0;
      renderSel();
      renderPairs();
    } else if (m.type === 'saved') {
      okSpan.style.display = 'inline';
      setTimeout(function () { okSpan.style.display = 'none'; }, 2000);
    }
  });

  vsc.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
  }
}
