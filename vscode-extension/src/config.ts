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
import * as fsAsync from 'fs/promises';
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
      configs.push(...await readFromFolderSettings(folder, outputChannel));
    }
  }

  // 2. Global fallback
  if (configs.length === 0) {
    configs.push(...await readGlobalConfig(outputChannel));
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
async function readFromFolderSettings(
  folder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel
): Promise<WatcherConfig[]> {
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
  return await buildConfigsFromPairs(root, label, 'vscode-folder', shared, pairs, outputChannel);
}

/** Reads global VS Code settings; the first workspace folder is the path root. */
async function readGlobalConfig(outputChannel: vscode.OutputChannel): Promise<WatcherConfig[]> {
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
  return await buildConfigsFromPairs(root, 'global', 'vscode-global', shared, pairs, outputChannel);
}

// ─── Config builders ──────────────────────────────────────────────────────────

/**
 * Validates and expands a list of raw folder pairs into WatcherConfig objects.
 * `originalFolder` is validated once for the whole source; each pair is
 * validated independently so one bad pair does not block the others.
 *
 * Both `originalFolder` and each pair's `modifiedFolder` / `diffFolder` may
 * contain `*`, `?`, or `**` glob wildcards.  The wildcards are expanded
 * against the filesystem before validation:
 *
 *  - `originalFolder`: glob is expanded; the **first** alphabetical match is
 *    used (a warning is logged when multiple directories match).
 *  - `modifiedFolder` + `diffFolder`: each is expanded independently; the two
 *    result lists must have the same length — they are then **zipped** into
 *    individual WatcherConfig entries.
 */
async function buildConfigsFromPairs(
  root: string,
  label: string,
  source: WatcherConfig['configSource'],
  shared: ConfigData,
  pairs: FolderPairRaw[],
  outputChannel: vscode.OutputChannel
): Promise<WatcherConfig[]> {
  // ── Resolve and glob-expand originalFolder ─────────────────────────────────
  const rawOriginal = resolvePath(shared.originalFolder ?? '', root);
  if (!rawOriginal) {
    const msg = `[FATAL] [${label}] originalFolder is not set. Skipping.`;
    outputChannel.appendLine(msg);
    vscode.window.showErrorMessage(msg);
    return [];
  }
  const expandedOriginals = await expandGlobDirs(rawOriginal);
  if (expandedOriginals.length === 0) {
    const msg = `[FATAL] [${label}] originalFolder glob matched no directories: ${rawOriginal}. Skipping.`;
    outputChannel.appendLine(msg);
    vscode.window.showErrorMessage(msg);
    return [];
  }
  const resolvedOriginal = expandedOriginals[0];
  if (expandedOriginals.length > 1) {
    outputChannel.appendLine(
      `[WARN]  [${label}] originalFolder glob matched ${expandedOriginals.length} directories; ` +
      `using first: ${resolvedOriginal}`
    );
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

    const rawMod  = resolvePath(pair.modifiedFolder, root);
    const rawDiff = resolvePath(pair.diffFolder, root);

    const expandedMod  = await expandGlobDirs(rawMod);
    const expandedDiff = await expandGlobDirs(rawDiff);

    if (hasGlobChars(rawMod) && expandedMod.length === 0) {
      outputChannel.appendLine(
        `[WARN]  [${pairLabel}] modifiedFolder glob matched no directories: ${rawMod}. Skipping pair.`
      );
      continue;
    }
    if (hasGlobChars(rawDiff) && expandedDiff.length === 0) {
      outputChannel.appendLine(
        `[WARN]  [${pairLabel}] diffFolder glob matched no directories: ${rawDiff}. Skipping pair.`
      );
      continue;
    }
    if (expandedMod.length !== expandedDiff.length) {
      outputChannel.appendLine(
        `[WARN]  [${pairLabel}] modifiedFolder glob matched ${expandedMod.length} ` +
        `director${expandedMod.length === 1 ? 'y' : 'ies'} but diffFolder glob matched ` +
        `${expandedDiff.length} — counts must match for zipping. Skipping pair.`
      );
      continue;
    }

    // Zip the expanded lists into individual WatcherConfig entries
    for (let j = 0; j < expandedMod.length; j++) {
      const subLabel = expandedMod.length > 1 ? `${pairLabel}[${j}]` : pairLabel;
      const pairData: ConfigData = {
        ...shared,
        originalFolder: resolvedOriginal,
        modifiedFolder: expandedMod[j],
        diffFolder:     expandedDiff[j],
        pathPrefix: pair.pathPrefix ?? '',
      };
      const wc = buildConfig(root, pairData, subLabel, source, outputChannel);
      if (wc) results.push(wc);
    }
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

// ─── Glob expansion ───────────────────────────────────────────────────────────

const GLOB_CHARS_RE = /[*?[{]/;

function hasGlobChars(p: string): boolean {
  return GLOB_CHARS_RE.test(p);
}

/**
 * Expands a path that may contain `*` / `?` / `**` wildcards into an array of
 * existing **directory** paths, sorted alphabetically.  Paths without glob
 * characters are returned as-is in a single-element array (no I/O).
 *
 * Rules:
 *   `*`  — any sequence of chars that does not include a path separator
 *   `?`  — any single char that is not a path separator
 *   `**` — zero or more directory levels
 */
async function expandGlobDirs(pattern: string): Promise<string[]> {
  if (!hasGlobChars(pattern)) return [pattern];

  const parts = pattern.split(/[\\/]/);

  // Separate the static prefix (before the first glob segment)
  let staticCount = 0;
  for (let i = 0; i < parts.length; i++) {
    if (hasGlobChars(parts[i])) break;
    staticCount++;
  }

  // Reconstruct base using the platform separator so Windows drive roots
  // like ["C:", "Games"] join correctly into "C:\Games".
  const base =
    staticCount === 0
      ? path.isAbsolute(pattern)
        ? path.parse(pattern).root   // e.g. "/" or "C:\\"
        : '.'
      : parts.slice(0, staticCount).join(path.sep);

  return matchGlobParts(base, parts.slice(staticCount));
}

async function matchGlobParts(base: string, remaining: string[]): Promise<string[]> {
  if (remaining.length === 0) {
    try {
      return (await fsAsync.stat(base)).isDirectory() ? [base] : [];
    } catch { return []; }
  }

  const [head, ...tail] = remaining;

  // `**` — match zero-or-more directory levels
  if (head === '**') {
    const results: string[] = [];
    // Zero levels: skip ** and continue
    results.push(...await matchGlobParts(base, tail));
    // One-or-more levels: recurse into each subdirectory keeping **
    try {
      for (const e of (await fsAsync.readdir(base, { withFileTypes: true }))
                        .filter(e => e.isDirectory())
                        .sort((a, b) => a.name.localeCompare(b.name))) {
        results.push(...await matchGlobParts(path.join(base, e.name), remaining));
      }
    } catch { /* unreadable — skip */ }
    return results;
  }

  // Wildcard segment: build regex from the pattern segment
  const regex = segmentToRegex(head);
  try {
    const results: string[] = [];
    for (const e of (await fsAsync.readdir(base, { withFileTypes: true }))
                      .filter(e => e.isDirectory() && regex.test(e.name))
                      .sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(base, e.name);
      if (tail.length === 0) {
        results.push(child);
      } else {
        results.push(...await matchGlobParts(child, tail));
      }
    }
    return results;
  } catch { return []; }
}

function segmentToRegex(segment: string): RegExp {
  const reStr = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex metacharacters
    .replace(/\*/g, '[^\\\\/]*')           // * → any chars except path separator
    .replace(/\?/g, '[^\\\\/]');           // ? → any single char except separator
  return new RegExp(`^${reStr}$`, process.platform === 'win32' ? 'i' : undefined);
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

