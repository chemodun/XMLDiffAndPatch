/**
 * Configuration reader and validator.
 *
 * Supports three sources (checked in priority order per folder):
 *   1. Disk config file (`x4diffandpatch.json`) found anywhere in the workspace
 *   2. Per-folder VS Code settings (workspace folder that has any key set at
 *      the folder scope in `.vscode/settings.json` or a `.code-workspace` file)
 *   3. Global VS Code settings (fallback when nothing else is configured)
 *
 * Both `modifiedFolder` and `diffFolder` must always be configured and must
 * resolve to different paths on disk.  Either can be set to "." to refer to
 * the workspace / config-file folder itself.  They must never point to the
 * same directory.
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
  modifiedFolder?: string;
  diffFolder?: string;
  xsdPath?: string;
  onlyFullPath?: boolean;
  useAllAttributes?: boolean;
  ignoreDiffInAttribute?: string | null;
  reflectDiffToModified?: boolean;
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
 * Paths are resolved relative to the file's containing folder.
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

  return buildConfig(root, data, label, 'disk-file', outputChannel);
}

// ─── Per-source readers ───────────────────────────────────────────────────────

/** Reads per-folder VS Code settings; paths resolve relative to the workspace folder. */
function readFromFolderSettings(
  folder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel
): WatcherConfig | null {
  const root = folder.uri.fsPath;
  const label = `folder:${folder.name}`;
  const cfg = vscode.workspace.getConfiguration('xmlDiffAndPatch', folder.uri);

  const data: DiskConfigFile = {
    originalFolder: getInheritedString(cfg, 'originalFolder'),
    modifiedFolder: getInheritedString(cfg, 'modifiedFolder'),
    diffFolder: getInheritedString(cfg, 'diffFolder'),
    xsdPath: getInheritedString(cfg, 'xsdPath') || './diff.xsd',
    onlyFullPath: cfg.get<boolean>('onlyFullPath') ?? false,
    useAllAttributes: cfg.get<boolean>('useAllAttributes') ?? false,
    ignoreDiffInAttribute: getInheritedString(cfg, 'ignoreDiffInAttribute') || null,
    reflectDiffToModified: cfg.get<boolean>('reflectDiffToModified') ?? true,
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
    originalFolder: getInheritedString(cfg, 'originalFolder'),
    modifiedFolder: getInheritedString(cfg, 'modifiedFolder'),
    diffFolder: getInheritedString(cfg, 'diffFolder'),
    xsdPath: getInheritedString(cfg, 'xsdPath') || './diff.xsd',
    onlyFullPath: cfg.get<boolean>('onlyFullPath') ?? false,
    useAllAttributes: cfg.get<boolean>('useAllAttributes') ?? false,
    ignoreDiffInAttribute: getInheritedString(cfg, 'ignoreDiffInAttribute') || null,
    reflectDiffToModified: cfg.get<boolean>('reflectDiffToModified') ?? true,
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
  const originalFolder = resolvePath(data.originalFolder ?? '', root);
  const modifiedFolder = resolvePath(data.modifiedFolder ?? '', root);
  const diffFolder = resolvePath(data.diffFolder ?? '', root);
  const xsdResolved = resolvePath(data.xsdPath ?? './diff.xsd', root);

  // ── Fatal validation ──────────────────────────────────────────────────────
  if (!originalFolder) {
    const msg = `[FATAL] [${label}] originalFolder is not set. Skipping.`;
    outputChannel.appendLine(msg);
    vscode.window.showErrorMessage(msg);
    return null;
  }

  if (!modifiedFolder) {
    const msg = `[FATAL] [${label}] modifiedFolder is not set. Skipping.`;
    outputChannel.appendLine(msg);
    vscode.window.showErrorMessage(msg);
    return null;
  }

  if (!diffFolder) {
    const msg = `[FATAL] [${label}] diffFolder is not set. Skipping.`;
    outputChannel.appendLine(msg);
    vscode.window.showErrorMessage(msg);
    return null;
  }

  if (modifiedFolder === diffFolder) {
    const msg = `[FATAL] [${label}] modifiedFolder and diffFolder must not be the same directory ('${modifiedFolder}'). Skipping.`;
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
    modifiedFolder,
    diffFolder,
    xsdPath,
    onlyFullPath: data.onlyFullPath ?? false,
    useAllAttributes: data.useAllAttributes ?? false,
    ignoreDiffInAttribute: data.ignoreDiffInAttribute ?? null,
    reflectDiffToModified: data.reflectDiffToModified ?? true,
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

