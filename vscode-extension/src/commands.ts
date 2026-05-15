/**
 * Explorer context-menu commands for X4 Diff and Patch.
 *
 * Three commands are registered here; all accept the standard VS Code explorer
 * multi-selection arguments (uri, uri[]).  When invoked from the command
 * palette (no arguments) the active editor document is used.
 *
 *  x4diffandpatch.resetToOriginal     — copies original file(s) over modified
 *  x4diffandpatch.reconstructFromDiff — applies diff(s) to original → modified
 *  x4diffandpatch.regenerateDiff      — diffs modified against original → diff
 */
import * as vscode from 'vscode';
import * as path from 'path';
import type { WatcherManager } from './watcher.js';

// ─── Types ─────────────────────────────────────────────────────────────────

type Operation = 'resetToOriginal' | 'reconstructFromDiff' | 'regenerateDiff';

const REQUIRED_ROLE: Record<Operation, 'modified' | 'diff' | null> = {
  resetToOriginal: 'modified',
  reconstructFromDiff: 'modified',
  // regenerateDiff accepts both roles: diff-folder selection regenerates existing
  // diffs; modified-folder selection regenerates from the modified files and also
  // removes orphan diff files that have no counterpart in the modified folder.
  regenerateDiff: null,
};

const OP_TITLE: Record<Operation, string> = {
  resetToOriginal: 'Resetting to Original',
  reconstructFromDiff: 'Reconstructing from Diff',
  regenerateDiff: 'Regenerating Diffs',
};

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Recursively collects all .xml URIs under a URI (file or directory). */
async function collectXmlUris(uri: vscode.Uri): Promise<vscode.Uri[]> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      const results: vscode.Uri[] = [];
      for (const [name, type] of entries) {
        if (type & (vscode.FileType.File | vscode.FileType.Directory)) {
          results.push(...(await collectXmlUris(vscode.Uri.joinPath(uri, name))));
        }
      }
      return results;
    }
    if (uri.fsPath.toLowerCase().endsWith('.xml')) {
      return [uri];
    }
  } catch {
    // unreadable entry — skip silently
  }
  return [];
}

// ─── Core executor ─────────────────────────────────────────────────────────

async function executeOperation(
  op: Operation,
  rawUris: vscode.Uri[],
  getWatchers: () => WatcherManager[]
): Promise<void> {
  const watchers = getWatchers();
  const allFiles: vscode.Uri[] = [];
  // For regenerateDiff on a modified-role folder: track for orphan diff cleanup.
  const orphanTargets: Array<{ watcher: WatcherManager; relDir: string }> = [];

  for (const uri of rawUris) {
    let isDir = false;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      isDir = !!(stat.type & vscode.FileType.Directory);
    } catch { /* unreadable — skip */ }

    allFiles.push(...(await collectXmlUris(uri)));

    if (isDir && op === 'regenerateDiff') {
      for (const watcher of watchers) {
        const roleInfo = watcher.getFileRole(uri.fsPath);
        if (roleInfo?.role === 'modified') {
          orphanTargets.push({ watcher, relDir: roleInfo.relPath });
          break;
        }
      }
    }
  }

  if (allFiles.length === 0 && orphanTargets.length === 0) {
    vscode.window.showInformationMessage(
      'X4 Diff and Patch: No XML files found in the selection.'
    );
    return;
  }

  const requiredRole = REQUIRED_ROLE[op];

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `X4 Diff and Patch: ${OP_TITLE[op]}…`,
      cancellable: false,
    },
    async (progress) => {
      let processed = 0;
      let skipped = 0;
      const fileIncrement = orphanTargets.length > 0 ? 85 / Math.max(allFiles.length, 1) : 100 / Math.max(allFiles.length, 1);

      for (const fileUri of allFiles) {
        progress.report({
          message: path.basename(fileUri.fsPath),
          increment: fileIncrement,
        });

        let handled = false;
        for (const watcher of watchers) {
          const roleInfo = watcher.getFileRole(fileUri.fsPath);
          if (!roleInfo) continue;
          if (requiredRole !== null && roleInfo.role !== requiredRole) continue;

          let ok = false;
          if (op === 'resetToOriginal') {
            ok = await watcher.runResetToOriginal(roleInfo.relPath);
          } else if (op === 'reconstructFromDiff') {
            ok = await watcher.runReconstructFromDiff(roleInfo.relPath);
          } else {
            ok = await watcher.runRegenerateDiff(roleInfo.relPath);
          }

          handled = true;
          if (ok) processed++;
          else skipped++;
          break; // first matching watcher wins
        }

        if (!handled) skipped++;
      }

      // Orphan cleanup: delete diff files with no corresponding modified file.
      let orphansDeleted = 0;
      if (orphanTargets.length > 0) {
        progress.report({ message: 'Cleaning orphan diffs…', increment: 15 });
        for (const { watcher, relDir } of orphanTargets) {
          orphansDeleted += await watcher.runCleanOrphanDiffs(relDir);
        }
      }

      const parts: string[] = [];
      if (allFiles.length > 0) {
        parts.push(`${processed} file(s) processed`);
        if (skipped > 0) parts.push(`${skipped} skipped`);
      }
      if (orphansDeleted > 0) parts.push(`${orphansDeleted} orphan diff(s) deleted`);

      const msg = parts.length > 0
        ? `X4 Diff and Patch: ${parts.join(', ')}.`
        : 'X4 Diff and Patch: No applicable files found.';
      vscode.window.showInformationMessage(msg);
    }
  );
}

// ─── Registration ──────────────────────────────────────────────────────────

export function registerExplorerCommands(
  context: vscode.ExtensionContext,
  getWatchers: () => WatcherManager[]
): void {
  const register = (id: string, op: Operation): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        id,
        async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
          // Resolve URIs: multi-selection → single → active editor
          const uris: vscode.Uri[] =
            selected?.length
              ? selected
              : uri
              ? [uri]
              : vscode.window.activeTextEditor
              ? [vscode.window.activeTextEditor.document.uri]
              : [];

          if (uris.length === 0) {
            vscode.window.showWarningMessage(
              'X4 Diff and Patch: No file or folder selected.'
            );
            return;
          }

          await executeOperation(op, uris, getWatchers);
        }
      )
    );
  };

  register('x4diffandpatch.resetToOriginal', 'resetToOriginal');
  register('x4diffandpatch.reconstructFromDiff', 'reconstructFromDiff');
  register('x4diffandpatch.regenerateDiff', 'regenerateDiff');
}
