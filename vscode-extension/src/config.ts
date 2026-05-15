/**
 * Configuration reader and validator.
 *
 * Reads the `xmlDiffAndPatch.*` VS Code workspace settings, resolves relative
 * paths, validates the required fields (§5 of the spec), and returns either a
 * fully-resolved WatcherConfig or null (when a fatal error is found).
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { WatcherConfig } from './core/types.js';

/** Workspace root for resolving relative paths (first workspace folder). */
function workspaceRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function resolvePath(p: string, root: string): string {
  if (!p) {
    return '';
  }
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}

/**
 * Reads and validates the extension settings.
 *
 * @param outputChannel Used to log warnings.
 * @returns Resolved WatcherConfig, or null if a fatal configuration error is found.
 */
export function readConfig(
  outputChannel: vscode.OutputChannel
): WatcherConfig | null {
  const root = workspaceRoot();
  if (!root) {
    outputChannel.appendLine(
      '[ERROR] No workspace folder is open. Extension will not activate.'
    );
    return null;
  }

  const cfg = vscode.workspace.getConfiguration('xmlDiffAndPatch');

  // ── Read raw values ──────────────────────────────────────────────────────────
  const rawOriginal: string = cfg.get('originalFolder') ?? '';
  const mainFolderRole: 'modified' | 'diff' = cfg.get('mainFolderRole') ?? 'modified';
  const rawModified: string = cfg.get('modifiedFolder') ?? '';
  const rawDiff: string = cfg.get('diffFolder') ?? '';
  const rawXsd: string = cfg.get('xsdPath') ?? './diff.xsd';

  const originalFolder = resolvePath(rawOriginal, root);
  const modifiedFolder = resolvePath(rawModified, root);
  const diffFolder = resolvePath(rawDiff, root);
  const xsdResolved = resolvePath(rawXsd, root);

  // ── Fatal validation (§5) ────────────────────────────────────────────────────
  if (!originalFolder) {
    const msg =
      '[FATAL] xmlDiffAndPatch.originalFolder is not set. Disabling watchers.';
    outputChannel.appendLine(msg);
    vscode.window.showErrorMessage(msg);
    return null;
  }

  if (mainFolderRole === 'modified' && !diffFolder) {
    const msg =
      '[FATAL] xmlDiffAndPatch.diffFolder is required when mainFolderRole = "modified". Disabling watchers.';
    outputChannel.appendLine(msg);
    vscode.window.showErrorMessage(msg);
    return null;
  }

  if (mainFolderRole === 'diff' && !modifiedFolder) {
    const msg =
      '[FATAL] xmlDiffAndPatch.modifiedFolder is required when mainFolderRole = "diff". Disabling watchers.';
    outputChannel.appendLine(msg);
    vscode.window.showErrorMessage(msg);
    return null;
  }

  // ── Warning validation — folder existence ────────────────────────────────────
  for (const [label, p] of [
    ['originalFolder', originalFolder],
    ['modifiedFolder', modifiedFolder],
    ['diffFolder', diffFolder],
  ]) {
    if (p && !fs.existsSync(p)) {
      outputChannel.appendLine(
        `[WARN] Configured folder '${label}' does not exist on disk: ${p}`
      );
    }
  }

  // ── XSD path ─────────────────────────────────────────────────────────────────
  const xsdPath = fs.existsSync(xsdResolved) ? xsdResolved : null;
  if (!xsdPath) {
    outputChannel.appendLine(
      `[INFO] XSD file not found at '${xsdResolved}' — validation will be skipped.`
    );
  }

  return {
    originalFolder,
    mainFolderRole,
    modifiedFolder,
    diffFolder,
    xsdPath,
    onlyFullPath: cfg.get('onlyFullPath') ?? false,
    useAllAttributes: cfg.get('useAllAttributes') ?? false,
    ignoreDiffInAttribute: cfg.get('ignoreDiffInAttribute') ?? null,
    reflectToMainFolder: cfg.get('reflectToMainFolder') ?? true,
    passOtherFiles: cfg.get('passOtherFiles') ?? true,
    showDiffEditorOnSave: cfg.get('showDiffEditorOnSave') ?? false,
    allowDoubles: cfg.get('allowDoubles') ?? false,
    watchMode: cfg.get('watchMode') ?? 'onSave',
    debounceMs: cfg.get('debounceMs') ?? 500,
  };
}
