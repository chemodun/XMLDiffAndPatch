/**
 * Configuration reader and validator.
 *
 * Supports two sources (checked in priority order per folder):
 *   1. Per-folder VS Code settings (workspace folder that has `folderPairs` or
 *      `originalFolder` set at the folder scope in `.vscode/settings.json` or
 *      a `.code-workspace` file)
 *   2. Global VS Code settings (fallback when nothing else is configured)
 *
 * `originalFolder` must always be configured.  `folderPairs` must contain at
 * least one valid pair where both `modifiedFolder` and `diffFolder` are set and
 * resolve to different directories on disk.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { WatcherConfig, EmptyDiffBehavior, ValidationFailBehavior } from './core/types.js';

// ─── Internal config shape ────────────────────────────────────────────────────

/**
 * Internal shape passed to buildConfig.  All fields are optional; missing
 * values fall back to extension defaults.  Paths are resolved relative to the
 * root folder.
 */
interface ConfigData {
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
   * original file.  Not applied to the output path.
   */
  pathPrefix?: string;
  /** Enable verbose debug logging in the output channel. */
  debug?: boolean;
}

// ─── Settings keys that trigger per-folder activation ────────────────────────

const FOLDER_TRIGGER_KEYS = [
  'originalFolder',
  'folderPairs',
] as const;

// ─── Public API ───────────────────────────────────────────────────────────────

/** * One-time migration: if `folderPairs` is empty at a given settings scope but
 * the legacy `modifiedFolder` + `diffFolder` are both set there, writes them
 * as `folderPairs[0]` and removes the old keys.  Safe to call on every start;
 * it is a no-op once `folderPairs` is already populated.
 */
export async function migrateSettings(outputChannel: vscode.OutputChannel): Promise<void> {
  // Per-folder settings (.vscode/settings.json)
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const cfg = vscode.workspace.getConfiguration('xmlDiffAndPatch', folder.uri);
    await migrateLegacyPair(
      cfg, `folder:${folder.name}`, vscode.ConfigurationTarget.WorkspaceFolder, outputChannel
    );
  }
  // Workspace-level settings (.code-workspace)
  if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
    const cfg = vscode.workspace.getConfiguration('xmlDiffAndPatch');
    await migrateLegacyPair(
      cfg, 'workspace', vscode.ConfigurationTarget.Workspace, outputChannel
    );
  }
  // Global user settings
  {
    const cfg = vscode.workspace.getConfiguration('xmlDiffAndPatch');
    await migrateLegacyPair(
      cfg, 'global', vscode.ConfigurationTarget.Global, outputChannel
    );
  }
}

async function migrateLegacyPair(
  cfg: vscode.WorkspaceConfiguration,
  label: string,
  target: vscode.ConfigurationTarget,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  // Inspect values at the specific scope only — do not follow inheritance chain.
  const pairsIns  = cfg.inspect<FolderPairRaw[]>('folderPairs');
  const modIns    = cfg.inspect<string>('modifiedFolder');
  const diffIns   = cfg.inspect<string>('diffFolder');
  const prefixIns = cfg.inspect<string>('pathPrefix');

  let existingPairs: FolderPairRaw[] | undefined;
  let legacyMod:    string | undefined;
  let legacyDiff:   string | undefined;
  let legacyPrefix: string | undefined;

  if (target === vscode.ConfigurationTarget.WorkspaceFolder) {
    existingPairs = pairsIns?.workspaceFolderValue;
    legacyMod     = modIns?.workspaceFolderValue;
    legacyDiff    = diffIns?.workspaceFolderValue;
    legacyPrefix  = prefixIns?.workspaceFolderValue;
  } else if (target === vscode.ConfigurationTarget.Workspace) {
    existingPairs = pairsIns?.workspaceValue;
    legacyMod     = modIns?.workspaceValue;
    legacyDiff    = diffIns?.workspaceValue;
    legacyPrefix  = prefixIns?.workspaceValue;
  } else {
    existingPairs = pairsIns?.globalValue;
    legacyMod     = modIns?.globalValue;
    legacyDiff    = diffIns?.globalValue;
    legacyPrefix  = prefixIns?.globalValue;
  }

  if ((existingPairs ?? []).length > 0) return; // already migrated
  if (!legacyMod || !legacyDiff) return;         // both folders required

  const newPair: FolderPairRaw = { modifiedFolder: legacyMod, diffFolder: legacyDiff };
  if (legacyPrefix) newPair.pathPrefix = legacyPrefix;

  try {
    await cfg.update('folderPairs',     [newPair],  target);
    await cfg.update('modifiedFolder',  undefined,  target);
    await cfg.update('diffFolder',      undefined,  target);
    await cfg.update('pathPrefix',      undefined,  target);
    outputChannel.appendLine(
      `[INFO]  [${label}] Migrated legacy modifiedFolder/diffFolder settings to folderPairs[0].`
    );
  } catch (err) {
    outputChannel.appendLine(`[ERROR] [${label}] Failed to migrate legacy settings: ${err}`);
  }
}

/** * Returns all active `WatcherConfig` instances by checking:
 *   1. Per-folder VS Code settings for each workspace folder
 *   2. Global VS Code settings (fallback if nothing else is found)
 */
export async function readAllConfigs(
  outputChannel: vscode.OutputChannel
): Promise<WatcherConfig[]> {
  const configs: WatcherConfig[] = [];

  // 1. Per-folder VS Code settings
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (hasFolderScopedSettings(folder.uri)) {
      configs.push(...readFromFolderSettings(folder, outputChannel));
    }
  }

  // 2. Global fallback
  if (configs.length === 0) {
    configs.push(...readGlobalConfig(outputChannel));
  }

  return configs;
}

// ─── Per-source readers ───────────────────────────────────────────────────────

/** Raw shape of one entry in the `xmlDiffAndPatch.folderPairs` setting. */
interface FolderPairRaw {
  modifiedFolder?: string;
  diffFolder?: string;
  pathPrefix?: string;
}

/** Reads per-folder VS Code settings; paths resolve relative to the workspace folder. */
function readFromFolderSettings(
  folder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel
): WatcherConfig[] {
  const root = folder.uri.fsPath;
  const label = `folder:${folder.name}`;
  const cfg = vscode.workspace.getConfiguration('xmlDiffAndPatch', folder.uri);

  const shared: ConfigData = {
    originalFolder: getInheritedString(cfg, 'originalFolder'),
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
    debug: cfg.get<boolean>('debug') ?? false,
  };

  const pairs = cfg.get<FolderPairRaw[]>('folderPairs') ?? [];
  return buildConfigsFromPairs(root, label, 'vscode-folder', shared, pairs, outputChannel);
}

/** Reads global VS Code settings; the first workspace folder is the path root. */
function readGlobalConfig(outputChannel: vscode.OutputChannel): WatcherConfig[] {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  if (!root) {
    outputChannel.appendLine('[ERROR] No workspace folder is open. Extension will not activate.');
    return [];
  }

  const cfg = vscode.workspace.getConfiguration('xmlDiffAndPatch');
  const shared: ConfigData = {
    originalFolder: getInheritedString(cfg, 'originalFolder'),
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
    debug: cfg.get<boolean>('debug') ?? false,
  };

  const pairs = cfg.get<FolderPairRaw[]>('folderPairs') ?? [];
  return buildConfigsFromPairs(root, 'global', 'vscode-global', shared, pairs, outputChannel);
}

// ─── Config builders ──────────────────────────────────────────────────────────

/**
 * Validates and expands a list of raw folder pairs into WatcherConfig objects.
 * `originalFolder` is validated once for the whole source; each pair is
 * validated independently so one bad pair does not block the others.
 */
function buildConfigsFromPairs(
  root: string,
  label: string,
  source: WatcherConfig['configSource'],
  shared: ConfigData,
  pairs: FolderPairRaw[],
  outputChannel: vscode.OutputChannel
): WatcherConfig[] {
  const resolvedOriginal = resolvePath(shared.originalFolder ?? '', root);
  if (!resolvedOriginal) {
    const msg = `[FATAL] [${label}] originalFolder is not set. Skipping.`;
    outputChannel.appendLine(msg);
    vscode.window.showErrorMessage(msg);
    return [];
  }

  if (pairs.length === 0) {
    outputChannel.appendLine(`[WARN]  [${label}] folderPairs is empty — no folder pairs configured.`);
    return [];
  }

  const results: WatcherConfig[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const pairLabel = `${label}[${i}]`;
    if (!pair.modifiedFolder) {
      outputChannel.appendLine(`[WARN]  [${pairLabel}] modifiedFolder is not set. Skipping pair.`);
      continue;
    }
    if (!pair.diffFolder) {
      outputChannel.appendLine(`[WARN]  [${pairLabel}] diffFolder is not set. Skipping pair.`);
      continue;
    }
    const pairData: ConfigData = {
      ...shared,
      modifiedFolder: pair.modifiedFolder,
      diffFolder: pair.diffFolder,
      pathPrefix: pair.pathPrefix ?? '',
    };
    const wc = buildConfig(root, pairData, pairLabel, source, outputChannel);
    if (wc) results.push(wc);
  }
  return results;
}

function buildConfig(
  root: string,
  data: ConfigData,
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

