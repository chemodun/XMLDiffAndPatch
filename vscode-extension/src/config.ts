/**
 * Configuration reader and validator.
 *
 * Supports three sources (checked in priority order per folder):
 *   1. Disk config file (`x4diffandpatch.json`) found anywhere in the workspace
 *   2. Per-folder VS Code settings (workspace folder that has any key set at
 *      the folder scope in `.vscode/settings.json` or a `.code-workspace` file)
 *   3. Global VS Code settings (fallback when nothing else is configured)
 *
 * For sources (1) and (2) the containing folder / workspace folder is treated
 * as the implicit "main" folder: if `modifiedFolder` (for `mainFolderRole='modified'`)
 * or `diffFolder` (for `mainFolderRole='diff'`) is not explicitly set, it defaults
 * to `.` — the folder that owns the configuration.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { WatcherConfig, EmptyDiffBehavior, ValidationFailBehavior } from './core/types.js';

// ─── Public constants ─────────────────────────────────────────────────────────

/** Name of the optional on-disk config file. */
export const DISK_CONFIG_FILENAME = 'x4diffandpatch.json';

// ─── Disk config file shape ───────────────────────────────────────────────────

/**
 * Shape of the JSON config file on disk.  All fields are optional; missing
 * values fall back to extension defaults.  Paths are resolved relative to the
 * file's containing folder.
 */
export interface DiskConfigFile {
  originalFolder?: string;
  mainFolderRole?: 'modified' | 'diff';
  /** If omitted and mainFolderRole='modified', defaults to '.' (the file's folder). */
  modifiedFolder?: string;
  /** If omitted and mainFolderRole='diff', defaults to '.' (the file's folder). */
  diffFolder?: string;
  xsdPath?: string;
  onlyFullPath?: boolean;
  useAllAttributes?: boolean;
  ignoreDiffInAttribute?: string | null;
  reflectToMainFolder?: boolean;
  passOtherFiles?: boolean;
  showDiffEditorOnSave?: boolean;
  allowDoubles?: boolean;
  watchMode?: 'onSave' | 'onTheFly' | 'contextMenuOnly';
  debounceMs?: number;
  /** Action when diff produces no operations (files are identical). */
  emptyDiffBehavior?: EmptyDiffBehavior;
  /** Action when structural validation of a generated diff fails. */
  validationFailBehavior?: ValidationFailBehavior;
  /**
   * Path segment prepended to the file's relative path when locating the
   * original file.  Not applied to the output path.  Only honoured for
   * disk config files; ignored for VS Code settings.
   */
  pathPrefix?: string;
  /** Enable verbose debug logging in the output channel. */
  debug?: boolean;
}

// ─── Settings keys that trigger per-folder activation ────────────────────────

const FOLDER_TRIGGER_KEYS = [
  'originalFolder',
  'mainFolderRole',
  'modifiedFolder',
  'diffFolder',
] as const;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns all active `WatcherConfig` instances by checking:
 *   1. Disk config files (`x4diffandpatch.json`) anywhere in the workspace
 *   2. Per-folder VS Code settings for each workspace folder
 *   3. Global VS Code settings (fallback if nothing else is found)
 */
export async function readAllConfigs(
  outputChannel: vscode.OutputChannel
): Promise<WatcherConfig[]> {
  const configs: WatcherConfig[] = [];
  const usedFolders = new Set<string>(); // normalised lower-case folder paths

  // 1. Disk config files — searched anywhere in the workspace
  const diskUris = await vscode.workspace.findFiles(
    `**/${DISK_CONFIG_FILENAME}`,
    '{**/node_modules/**,**/.git/**}'
  );
  for (const uri of diskUris) {
    const cfg = readFromDiskFile(uri.fsPath, outputChannel);
    if (cfg) {
      configs.push(cfg);
      usedFolders.add(path.dirname(uri.fsPath).toLowerCase());
    }
  }

  // 2. Per-folder VS Code settings
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (usedFolders.has(folder.uri.fsPath.toLowerCase())) {
      continue; // disk config already covers this folder
    }
    if (hasFolderScopedSettings(folder.uri)) {
      const cfg = readFromFolderSettings(folder, outputChannel);
      if (cfg) {
        configs.push(cfg);
        usedFolders.add(folder.uri.fsPath.toLowerCase());
      }
    }
  }

  // 3. Global fallback
  if (configs.length === 0) {
    const cfg = readGlobalConfig(outputChannel);
    if (cfg) {
      configs.push(cfg);
    }
  }

  return configs;
}

/**
 * Reads a single config from a disk JSON file.
 * The file's containing folder becomes the implicit main folder.
 */
export function readFromDiskFile(
  configFilePath: string,
  outputChannel: vscode.OutputChannel
): WatcherConfig | null {
  const root = path.dirname(configFilePath);
  const label = `disk:${configFilePath}`;
  let data: DiskConfigFile;
  try {
    const raw = fs.readFileSync(configFilePath, 'utf-8');
    data = JSON.parse(raw) as DiskConfigFile;
  } catch (err) {
    outputChannel.appendLine(`[ERROR] Failed to read/parse config file '${configFilePath}': ${err}`);
    return null;
  }

  const mainFolderRole: 'modified' | 'diff' = data.mainFolderRole ?? 'modified';
  // The file's folder IS the main folder — default the main-role path to '.'
  const withDefaults: DiskConfigFile = {
    ...data,
    modifiedFolder: data.modifiedFolder ?? (mainFolderRole === 'modified' ? '.' : ''),
    diffFolder: data.diffFolder ?? (mainFolderRole === 'diff' ? '.' : ''),
  };

  return buildConfig(root, withDefaults, label, 'disk-file', outputChannel);
}

// ─── Per-source readers ───────────────────────────────────────────────────────

/** Reads per-folder VS Code settings; the workspace folder is the implicit main folder. */
function readFromFolderSettings(
  folder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel
): WatcherConfig | null {
  const root = folder.uri.fsPath;
  const label = `folder:${folder.name}`;
  const cfg = vscode.workspace.getConfiguration('xmlDiffAndPatch', folder.uri);

  const mainFolderRole: 'modified' | 'diff' = cfg.get('mainFolderRole') ?? 'modified';
  const data: DiskConfigFile = {
    mainFolderRole,
    originalFolder: getInheritedString(cfg, 'originalFolder'),
    // Default the main-role folder to '.' (the workspace folder itself)
    modifiedFolder: getInheritedString(cfg, 'modifiedFolder') || (mainFolderRole === 'modified' ? '.' : ''),
    diffFolder: getInheritedString(cfg, 'diffFolder') || (mainFolderRole === 'diff' ? '.' : ''),
    xsdPath: getInheritedString(cfg, 'xsdPath') || './diff.xsd',
    onlyFullPath: cfg.get<boolean>('onlyFullPath') ?? false,
    useAllAttributes: cfg.get<boolean>('useAllAttributes') ?? false,
    ignoreDiffInAttribute: getInheritedString(cfg, 'ignoreDiffInAttribute') || null,
    reflectToMainFolder: cfg.get<boolean>('reflectToMainFolder') ?? true,
    passOtherFiles: cfg.get<boolean>('passOtherFiles') ?? true,
    showDiffEditorOnSave: cfg.get<boolean>('showDiffEditorOnSave') ?? false,
    allowDoubles: cfg.get<boolean>('allowDoubles') ?? false,
    watchMode: cfg.get<'onSave' | 'onTheFly' | 'contextMenuOnly'>('watchMode') ?? 'onSave',
    debounceMs: cfg.get<number>('debounceMs') ?? 500,
    emptyDiffBehavior: cfg.get<EmptyDiffBehavior>('emptyDiffBehavior') ?? 'delete',
    validationFailBehavior: cfg.get<ValidationFailBehavior>('validationFailBehavior') ?? 'warn',
    pathPrefix: getInheritedString(cfg, 'pathPrefix'),
    debug: cfg.get<boolean>('debug') ?? false,
  };

  return buildConfig(root, data, label, 'vscode-folder', outputChannel);
}

/** Reads global VS Code settings; the first workspace folder is the path root. */
function readGlobalConfig(outputChannel: vscode.OutputChannel): WatcherConfig | null {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  if (!root) {
    outputChannel.appendLine('[ERROR] No workspace folder is open. Extension will not activate.');
    return null;
  }

  const cfg = vscode.workspace.getConfiguration('xmlDiffAndPatch');
  const data: DiskConfigFile = {
    mainFolderRole: cfg.get<'modified' | 'diff'>('mainFolderRole') ?? 'modified',
    originalFolder: getInheritedString(cfg, 'originalFolder'),
    modifiedFolder: getInheritedString(cfg, 'modifiedFolder'),
    diffFolder: getInheritedString(cfg, 'diffFolder'),
    xsdPath: getInheritedString(cfg, 'xsdPath') || './diff.xsd',
    onlyFullPath: cfg.get<boolean>('onlyFullPath') ?? false,
    useAllAttributes: cfg.get<boolean>('useAllAttributes') ?? false,
    ignoreDiffInAttribute: getInheritedString(cfg, 'ignoreDiffInAttribute') || null,
    reflectToMainFolder: cfg.get<boolean>('reflectToMainFolder') ?? true,
    passOtherFiles: cfg.get<boolean>('passOtherFiles') ?? true,
    showDiffEditorOnSave: cfg.get<boolean>('showDiffEditorOnSave') ?? false,
    allowDoubles: cfg.get<boolean>('allowDoubles') ?? false,
    watchMode: cfg.get<'onSave' | 'onTheFly' | 'contextMenuOnly'>('watchMode') ?? 'onSave',
    debounceMs: cfg.get<number>('debounceMs') ?? 500,
    emptyDiffBehavior: cfg.get<EmptyDiffBehavior>('emptyDiffBehavior') ?? 'delete',
    validationFailBehavior: cfg.get<ValidationFailBehavior>('validationFailBehavior') ?? 'warn',
    pathPrefix: getInheritedString(cfg, 'pathPrefix'),
    debug: cfg.get<boolean>('debug') ?? false,
  };

  return buildConfig(root, data, 'global', 'vscode-global', outputChannel);
}

// ─── Core config builder ──────────────────────────────────────────────────────

function buildConfig(
  root: string,
  data: DiskConfigFile,
  label: string,
  source: WatcherConfig['configSource'],
  outputChannel: vscode.OutputChannel
): WatcherConfig | null {
  const mainFolderRole: 'modified' | 'diff' = data.mainFolderRole ?? 'modified';

  const originalFolder = resolvePath(data.originalFolder ?? '', root);
  // When a folder is the "main" role its default is the workspace root ('.')
  const modifiedFolder = resolvePath(
    data.modifiedFolder || (mainFolderRole === 'modified' ? '.' : ''),
    root
  );
  const diffFolder = resolvePath(
    data.diffFolder || (mainFolderRole === 'diff' ? '.' : ''),
    root
  );
  const xsdResolved = resolvePath(data.xsdPath ?? './diff.xsd', root);

  // ── Fatal validation ──────────────────────────────────────────────────────
  if (!originalFolder) {
    const msg = `[FATAL] [${label}] originalFolder is not set. Skipping.`;
    outputChannel.appendLine(msg);
    vscode.window.showErrorMessage(msg);
    return null;
  }

  const mainFolder = mainFolderRole === 'modified' ? modifiedFolder : diffFolder;
  if (!mainFolder) {
    const key = mainFolderRole === 'modified' ? 'modifiedFolder' : 'diffFolder';
    const msg = `[FATAL] [${label}] ${key} (main folder) is not set. Skipping.`;
    outputChannel.appendLine(msg);
    vscode.window.showErrorMessage(msg);
    return null;
  }

  if (mainFolderRole === 'modified' && !diffFolder) {
    const msg = `[FATAL] [${label}] diffFolder is required when mainFolderRole="modified". Skipping.`;
    outputChannel.appendLine(msg);
    vscode.window.showErrorMessage(msg);
    return null;
  }

  if (mainFolderRole === 'diff' && !modifiedFolder) {
    const msg = `[FATAL] [${label}] modifiedFolder is required when mainFolderRole="diff". Skipping.`;
    outputChannel.appendLine(msg);
    vscode.window.showErrorMessage(msg);
    return null;
  }

  // ── Warning validation — folder existence ─────────────────────────────────
  for (const [lbl, p] of [
    ['originalFolder', originalFolder],
    ['modifiedFolder', modifiedFolder],
    ['diffFolder', diffFolder],
  ] as [string, string][]) {
    if (p && !fs.existsSync(p)) {
      outputChannel.appendLine(`[WARN]  [${label}] '${lbl}' does not exist on disk: ${p}`);
    }
  }

  // ── XSD path ─────────────────────────────────────────────────────────────
  const xsdPath = fs.existsSync(xsdResolved) ? xsdResolved : null;
  if (!xsdPath) {
    outputChannel.appendLine(
      `[INFO]  [${label}] XSD not found at '${xsdResolved}' — validation skipped.`
    );
  }

  return {
    originalFolder,
    mainFolderRole,
    modifiedFolder,
    diffFolder,
    xsdPath,
    onlyFullPath: data.onlyFullPath ?? false,
    useAllAttributes: data.useAllAttributes ?? false,
    ignoreDiffInAttribute: data.ignoreDiffInAttribute ?? null,
    reflectToMainFolder: data.reflectToMainFolder ?? true,
    passOtherFiles: data.passOtherFiles ?? true,
    showDiffEditorOnSave: data.showDiffEditorOnSave ?? false,
    allowDoubles: data.allowDoubles ?? false,
    watchMode: data.watchMode ?? 'onSave',
    debounceMs: data.debounceMs ?? 500,
    emptyDiffBehavior: (() => {
      const v = data.emptyDiffBehavior ?? 'delete';
      return (v as string) === 'skip' ? 'delete' : v; // normalise legacy 'skip'
    })(),
    validationFailBehavior: data.validationFailBehavior ?? 'warn',
    pathPrefix: data.pathPrefix ?? '',
    configLabel: label,
    configSource: source,
    debug: data.debug ?? false,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolvePath(p: string, root: string): string {
  if (!p) return '';
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}

/**
 * Reads a string setting by walking from the most specific scope to the most
 * general, skipping explicitly-empty-string values at lower scopes.  This
 * ensures a user-level (global) value is honoured even when a workspace or
 * folder config leaves the field blank.
 *
 * Rule: path / string values inherit from upper levels when empty;
 *       booleans and enums use cfg.get() (VS Code's normal precedence).
 */
function getInheritedString(cfg: vscode.WorkspaceConfiguration, key: string): string {
  const ins = cfg.inspect<string>(key);
  for (const v of [
    ins?.workspaceFolderValue,
    ins?.workspaceValue,
    ins?.globalValue,
    ins?.defaultValue,
  ]) {
    if (v !== undefined && v !== '') return v;
  }
  return '';
}

/** Returns true if any trigger setting has an explicit value at the workspace-folder scope. */
function hasFolderScopedSettings(folderUri: vscode.Uri): boolean {
  const cfg = vscode.workspace.getConfiguration('xmlDiffAndPatch', folderUri);
  return FOLDER_TRIGGER_KEYS.some((key) => cfg.inspect(key)?.workspaceFolderValue !== undefined);
}

