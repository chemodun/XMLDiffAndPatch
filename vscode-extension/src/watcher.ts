/**
 * File-save watcher.
 *
 * Implements §6 of the specification:
 *   - Watches modifiedFolder and (when reflectDiffToModified = true) diffFolder.
 *   - On save, resolves which operation to run (DiffEngine / PatchEngine /
 *     passOtherFiles copy), writes the output, and guards against loops.
 *   - Supports both "onSave" mode (workspace.onDidSaveTextDocument) and
 *     "onTheFly" mode (FileSystemWatcher with debounce).
 *   - In both modes, saves in modifiedFolder generate diffs; saves in
 *     diffFolder (when reflectDiffToModified=true) apply patches.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { DOMParser } from '@xmldom/xmldom';
import type { Document } from '@xmldom/xmldom';
import type { WatcherConfig, Logger } from './core/types.js';
import { DiffEngine } from './core/diffEngine.js';
import { applyPatch } from './core/patchEngine.js';
import { detectIndentation, ELEMENT_NODE } from './core/xmlUtils.js';
import { serializeDocument } from './core/xmlSerializer.js';
import type { StatusBarManager } from './statusBar.js';

/** Recursively collects absolute paths of all .xml files under `dir`. */
async function walkXmlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await walkXmlFiles(fullPath)));
      } else if (entry.name.toLowerCase().endsWith('.xml')) {
        results.push(fullPath);
      }
    }
  } catch {
    // unreadable directory — skip
  }
  return results;
}

/** Returns true when the diff Document root has no child operation elements. */
function isDiffEmpty(doc: Document): boolean {
  const root = doc.documentElement;
  if (!root) return true;
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === ELEMENT_NODE) return false;
  }
  return true;
}

/**
 * Returns true when @xmldom/xmldom inserted a <parsererror> element, which
 * indicates the source XML was malformed and could not be fully parsed.
 */
function hasParseError(doc: Document): boolean {
  const root = doc.documentElement;
  if (!root) return true;
  if (root.nodeName === 'parsererror') return true;
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeName === 'parsererror') return true;
  }
  return false;
}

/** Returns the path relative to `folder`, or null if the file is not under it. */
function getRelativePath(filePath: string, folder: string): string | null {
  const rel = path.relative(folder, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return rel;
}

/** Creates an output-channel-backed Logger, prefixing every message with the config label. */
function makeLogger(channel: vscode.OutputChannel, label: string, debugEnabled: boolean): Logger {
  const tag = `[${label}]`;
  return {
    info: (msg) => channel.appendLine(`[INFO]  ${tag} ${msg}`),
    warn: (msg) => channel.appendLine(`[WARN]  ${tag} ${msg}`),
    error: (msg) => channel.appendLine(`[ERROR] ${tag} ${msg}`),
    debug: (msg) => { if (debugEnabled) channel.appendLine(`[DEBUG] ${tag} ${msg}`); },
  };
}

// ─── WatcherManager ───────────────────────────────────────────────────────────

export class WatcherManager {
  /** Absolute paths of files currently being written by the extension (loop guard). */
  private readonly outputPaths = new Set<string>();
  /** Debounce timers keyed by absolute file path (onTheFly mode). */
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly logger: Logger;
  private readonly parser = new DOMParser();

  constructor(
    private readonly config: WatcherConfig,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly statusBar: StatusBarManager
  ) {
    this.logger = makeLogger(outputChannel, config.configLabel, config.debug);
  }

  // ─── Setup ────────────────────────────────────────────────────────────────

  setup(): void {
    const { modifiedFolder, diffFolder, reflectDiffToModified, watchMode } = this.config;

    if (watchMode === 'contextMenuOnly') {
      // No file watchers — processing triggered exclusively via context menu commands.
      return;
    }

    if (watchMode === 'onSave') {
      this.disposables.push(
        vscode.workspace.onDidSaveTextDocument((doc) =>
          this.handleSaveEvent(doc.uri.fsPath, modifiedFolder, diffFolder)
        )
      );
    } else {
      // onTheFly — always watch modifiedFolder
      this.addFsWatcher(modifiedFolder, modifiedFolder, diffFolder);

      if (reflectDiffToModified) {
        this.addFsWatcher(diffFolder, modifiedFolder, diffFolder);
      }
    }
  }

  private addFsWatcher(
    watchedFolder: string,
    modifiedFolder: string,
    diffFolder: string
  ): void {
    const pattern = new vscode.RelativePattern(watchedFolder, '**/*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handler = (uri: vscode.Uri) =>
      this.handleDebounced(uri.fsPath, modifiedFolder, diffFolder);

    watcher.onDidChange(handler);
    watcher.onDidCreate(handler);
    this.disposables.push(watcher);
  }

  private handleDebounced(
    filePath: string,
    modifiedFolder: string,
    diffFolder: string
  ): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.handleSaveEvent(filePath, modifiedFolder, diffFolder);
    }, this.config.debounceMs);
    this.debounceTimers.set(filePath, timer);
  }

  // ─── Core handler ─────────────────────────────────────────────────────────

  private handleSaveEvent(
    filePath: string,
    modifiedFolder: string,
    diffFolder: string
  ): void {
    // Extension only processes XML files — ignore everything else immediately.
    if (path.extname(filePath).toLowerCase() !== '.xml') {
      return;
    }

    // Loop guard
    if (this.outputPaths.has(filePath)) {
      this.logger.debug(`Loop guard: skipping own output '${filePath}'`);
      return;
    }

    const relModified = getRelativePath(filePath, modifiedFolder);
    const relDiff = getRelativePath(filePath, diffFolder);

    this.logger.debug(`Save event: '${filePath}' relModified=${relModified ?? 'n/a'} relDiff=${relDiff ?? 'n/a'}`);

    // Check diffFolder FIRST: it may be a subdirectory of modifiedFolder.
    // A file inside diffFolder must never be processed as a modified-folder event.
    if (relDiff !== null) {
      if (this.config.reflectDiffToModified) {
        this.processFile(filePath, relDiff, 'diff', modifiedFolder, diffFolder).catch(
          (err) => this.logger.error(`Unhandled error processing '${filePath}': ${err}`)
        );
      }
    } else if (relModified !== null) {
      this.processFile(filePath, relModified, 'modified', modifiedFolder, diffFolder).catch((err) =>
        this.logger.error(`Unhandled error processing '${filePath}': ${err}`)
      );
    }
  }

  // ─── File processing ───────────────────────────────────────────────────────

  private async processFile(
    savedPath: string,
    relPath: string,
    source: 'modified' | 'diff',
    modifiedFolder: string,
    diffFolder: string
  ): Promise<void> {
    const { config } = this;
    const isXml = path.extname(savedPath).toLowerCase() === '.xml';
    const originalPath = config.pathPrefix
      ? path.join(config.originalFolder, config.pathPrefix, relPath)
      : path.join(config.originalFolder, relPath);
    const originalExists = fsSync.existsSync(originalPath);
    this.logger.debug(
      `processFile: source=${source} isXml=${isXml} relPath='${relPath}'` +
      ` originalPath='${originalPath}' exists=${originalExists}`
    );

    // Determine output folder and operation
    let outputFolder: string;
    let operation: 'diff' | 'patch' | 'copy';

    if (source === 'modified') {
      // Modified file saved → generate a diff into diffFolder
      outputFolder = diffFolder;
      if (isXml && originalExists) {
        operation = 'diff';
      } else if (!originalExists && config.passOtherFiles) {
        operation = 'copy';
      } else {
        if (!originalExists) {
          this.logger.warn(
            `No matching original for '${relPath}' and passOtherFiles=false. Skipping.`
          );
        }
        return;
      }
    } else {
      // Diff file saved → apply patch into modifiedFolder
      outputFolder = modifiedFolder;
      if (isXml && originalExists) {
        operation = 'patch';
      } else if (!originalExists && config.passOtherFiles) {
        operation = 'copy';
      } else {
        if (!originalExists) {
          this.logger.warn(
            `No matching original for '${relPath}' and passOtherFiles=false. Skipping.`
          );
        }
        return;
      }
    }

    const outputPath = path.join(outputFolder, relPath);
    this.logger.debug(`operation=${operation} outputPath='${outputPath}'`);
    this.statusBar.setState('processing');

    try {
      if (operation === 'copy') {
        await this.writeCopy(savedPath, outputPath);
      } else if (operation === 'diff') {
        await this.writeDiff(originalPath, savedPath, outputPath);
      } else {
        await this.writePatch(originalPath, savedPath, outputPath);
      }
      this.statusBar.setState('active');
    } catch (err) {
      this.logger.error(`Failed to process '${savedPath}': ${err}`);
      this.statusBar.setState('error', `Error processing ${path.basename(savedPath)}`);
    }
  }

  // ─── Write helpers ─────────────────────────────────────────────────────────

  private async writeDiff(
    originalPath: string,
    modifiedPath: string,
    outputPath: string
  ): Promise<void> {
    this.logger.info(`[Diff] '${modifiedPath}' → '${outputPath}'`);

    const [origContent, modContent] = await Promise.all([
      fs.readFile(originalPath, 'utf-8'),
      fs.readFile(modifiedPath, 'utf-8'),
    ]);

    const originalDoc = this.parser.parseFromString(origContent, 'text/xml');
    const modifiedDoc = this.parser.parseFromString(modContent, 'text/xml');

    if (hasParseError(modifiedDoc)) {
      this.logger.warn(`[Diff] Skipped: XML is malformed in '${modifiedPath}'`);
      return;
    }

    const diffOptions = {
      onlyFullPath: this.config.onlyFullPath,
      useAllAttributes: this.config.useAllAttributes,
      ignoreDiffInAttribute: this.config.ignoreDiffInAttribute,
    };

    const engine = new DiffEngine(diffOptions, this.logger);
    const diffDoc = engine.generateDiff(originalDoc, modifiedDoc);

    // ── Empty diff handling ─────────────────────────────────────────────────
    if (isDiffEmpty(diffDoc)) {
      const behavior = this.config.emptyDiffBehavior;
      const deleteExisting = async () => {
        if (fsSync.existsSync(outputPath)) {
          await fs.unlink(outputPath);
          this.logger.info(`[Diff] No differences — deleted existing output: '${outputPath}'`);
        } else {
          this.logger.debug(`[Diff] No differences — no existing output to delete: '${outputPath}'`);
        }
      };
      switch (behavior) {
        case 'warn':
          this.logger.warn(`[Diff] No differences found — output not written: '${outputPath}'`);
          return;
        case 'warnDelete':
          this.logger.warn(`[Diff] No differences found — removing output: '${outputPath}'`);
          await deleteExisting();
          return;
        case 'delete':
          await deleteExisting();
          return;
        case 'write':
          // Fall through — write the empty <diff/> as normal
          break;
      }
    }

    const indentSize = detectIndentation(origContent);
    const output = serializeDocument(diffDoc, indentSize);

    // ── Structural validation ───────────────────────────────────────────────
    if (this.config.validationFailBehavior !== 'off') {
      const valid = this.checkDiffStructure(output, outputPath);
      if (!valid && this.config.validationFailBehavior === 'error') {
        return; // issue already logged inside checkDiffStructure
      }
    }

    await this.writeOutput(outputPath, output);
  }

  private async writePatch(
    originalPath: string,
    diffPath: string,
    outputPath: string
  ): Promise<void> {
    this.logger.info(`[Patch] '${diffPath}' → '${outputPath}'`);

    const [origContent, diffContent] = await Promise.all([
      fs.readFile(originalPath, 'utf-8'),
      fs.readFile(diffPath, 'utf-8'),
    ]);

    const originalDoc = this.parser.parseFromString(origContent, 'text/xml');
    const diffDoc = this.parser.parseFromString(diffContent, 'text/xml');

    if (hasParseError(diffDoc)) {
      this.logger.warn(`[Patch] Skipped: XML is malformed in '${diffPath}'`);
      return;
    }

    applyPatch(diffDoc, originalDoc, this.config.allowDoubles, this.logger);

    const indentSize = detectIndentation(origContent);
    const output = serializeDocument(originalDoc, indentSize);

    await this.writeOutput(outputPath, output);
  }

  private async writeCopy(sourcePath: string, outputPath: string): Promise<void> {
    this.logger.info(`[Copy] '${sourcePath}' → '${outputPath}'`);
    await this.ensureDir(outputPath);
    this.outputPaths.add(outputPath);
    try {
      if (this.isInWorkspace(outputPath)) {
        const content = await fs.readFile(sourcePath, 'utf-8');
        await this.writeViaWorkspaceEdit(vscode.Uri.file(outputPath), content);
      } else {
        await fs.copyFile(sourcePath, outputPath);
      }
    } finally {
      setTimeout(() => this.outputPaths.delete(outputPath), 500);
    }
  }

  /**
   * Writes text content to outputPath with loop guard.
   * For workspace paths, routes through VS Code's WorkspaceEdit + workspace.save()
   * so the text file service records a Local History entry.
   * Falls back to direct fs.writeFile for paths outside the workspace, or if
   * the file is already open with unsaved user edits.
   */
  private async writeOutput(outputPath: string, content: string): Promise<void> {
    await this.ensureDir(outputPath);
    this.outputPaths.add(outputPath);
    try {
      if (this.isInWorkspace(outputPath)) {
        await this.writeViaWorkspaceEdit(vscode.Uri.file(outputPath), content);
      } else {
        await fs.writeFile(outputPath, content, 'utf-8');
      }
    } finally {
      setTimeout(() => this.outputPaths.delete(outputPath), 500);
    }
  }

  /**
   * Writes content through VS Code's text file service so Local History is recorded.
   * - New file: uses WorkspaceEdit.createFile with contents, then workspace.save().
   * - Existing file: opens as TextDocument, applies a replace edit, then workspace.save().
   * - Existing file with unsaved user edits: logs a warning, falls back to fs.writeFile.
   */
  private async writeViaWorkspaceEdit(uri: vscode.Uri, content: string): Promise<void> {
    const filePath = uri.fsPath;
    const edit = new vscode.WorkspaceEdit();

    if (!fsSync.existsSync(filePath)) {
      // Brand-new file — createFile with contents opens it as a dirty working copy
      edit.createFile(uri, { contents: Buffer.from(content, 'utf-8') });
    } else {
      // Check whether the file is already open with unsaved user edits
      const openDoc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath.toLowerCase() === filePath.toLowerCase()
      );
      if (openDoc?.isDirty) {
        this.logger.warn(
          `[History] '${path.basename(filePath)}' has unsaved edits — writing directly (no Local History).`
        );
        await fs.writeFile(filePath, content, 'utf-8');
        return;
      }
      // Load the existing document and replace its full content
      const doc = await vscode.workspace.openTextDocument(uri);
      const endPos = doc.positionAt(doc.getText().length);
      edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), endPos), content);
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      await vscode.workspace.save(uri);
    } else {
      this.logger.warn(`[History] WorkspaceEdit failed for '${filePath}' — falling back to direct write.`);
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  /** Returns true when filePath is inside one of the open workspace folders. */
  private isInWorkspace(filePath: string): boolean {
    return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath)) !== undefined;
  }

  private async ensureDir(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
  }

  // ─── Structural diff validation ────────────────────────────────────────────

  /**
   * Checks the structure of a generated diff XML (root = <diff>, children are
   * <add>/<replace>/<remove> with a `sel` attribute).  Returns true if valid.
   * Issues are logged at warn or error level depending on `validationFailBehavior`.
   */
  private checkDiffStructure(xml: string, outputPath: string): boolean {
    const logIssue =
      this.config.validationFailBehavior === 'error'
        ? (msg: string) => this.logger.error(msg)
        : (msg: string) => this.logger.warn(msg);
    let isValid = true;
    try {
      const doc = this.parser.parseFromString(xml, 'text/xml');
      const root = doc.documentElement;
      if (!root || root.localName !== 'diff') {
        logIssue(`[Validation] Root element is not 'diff' in '${outputPath}'`);
        return false;
      }
      let child = root.firstChild;
      while (child) {
        if (child.nodeType === 1 /* ELEMENT_NODE */) {
          const name = (child as { localName: string }).localName;
          if (!['add', 'replace', 'remove'].includes(name)) {
            logIssue(`[Validation] Unexpected element '${name}' in diff '${outputPath}'`);
            isValid = false;
          }
          const sel = (child as unknown as { getAttribute: (n: string) => string | null }).getAttribute('sel');
          if (!sel) {
            logIssue(`[Validation] Operation '${name}' missing 'sel' attribute in '${outputPath}'`);
            isValid = false;
          }
        }
        child = child.nextSibling;
      }
    } catch (err) {
      logIssue(`[Validation] Could not parse output diff '${outputPath}': ${err}`);
      return false;
    }
    return isValid;
  }

  // ─── Explorer command API ─────────────────────────────────────────────────

  /**
   * Returns the folder role ('modified' or 'diff') for the given absolute file
   * path within this watcher's config, or null if the file is not covered.
   * When both folders match (diff nested inside modified or vice-versa), the
   * deeper (more-specific) folder wins.
   */
  getFileRole(filePath: string): { role: 'modified' | 'diff'; relPath: string } | null {
    const relModified = getRelativePath(filePath, this.config.modifiedFolder);
    const relDiff = getRelativePath(filePath, this.config.diffFolder);

    if (relModified !== null && relDiff !== null) {
      return this.config.diffFolder.length > this.config.modifiedFolder.length
        ? { role: 'diff', relPath: relDiff }
        : { role: 'modified', relPath: relModified };
    }
    if (relDiff !== null) return { role: 'diff', relPath: relDiff };
    if (relModified !== null) return { role: 'modified', relPath: relModified };
    return null;
  }

  /** Copies the original file over the modified file ("Reset to Original"). */
  async runResetToOriginal(relPath: string): Promise<boolean> {
    const originalPath = this.config.pathPrefix
      ? path.join(this.config.originalFolder, this.config.pathPrefix, relPath)
      : path.join(this.config.originalFolder, relPath);
    if (!fsSync.existsSync(originalPath)) {
      this.logger.warn(`[ResetToOriginal] No original for '${relPath}' — skipped.`);
      return false;
    }
    const modifiedPath = path.join(this.config.modifiedFolder, relPath);
    await this.writeCopy(originalPath, modifiedPath);
    return true;
  }

  /** Applies the existing diff file to the original to regenerate the modified file ("Reconstruct from Diff"). */
  async runReconstructFromDiff(relPath: string): Promise<boolean> {
    const originalPath = this.config.pathPrefix
      ? path.join(this.config.originalFolder, this.config.pathPrefix, relPath)
      : path.join(this.config.originalFolder, relPath);
    if (!fsSync.existsSync(originalPath)) {
      this.logger.warn(`[ReconstructFromDiff] No original for '${relPath}' — skipped.`);
      return false;
    }
    const diffPath = path.join(this.config.diffFolder, relPath);
    if (!fsSync.existsSync(diffPath)) {
      this.logger.warn(`[ReconstructFromDiff] No diff file for '${relPath}' — skipped.`);
      return false;
    }
    const modifiedPath = path.join(this.config.modifiedFolder, relPath);
    await this.writePatch(originalPath, diffPath, modifiedPath);
    return true;
  }

  /** Regenerates the diff by comparing the current modified file against the original ("Regenerate Diff"). */
  async runRegenerateDiff(relPath: string): Promise<boolean> {
    const originalPath = this.config.pathPrefix
      ? path.join(this.config.originalFolder, this.config.pathPrefix, relPath)
      : path.join(this.config.originalFolder, relPath);
    if (!fsSync.existsSync(originalPath)) {
      this.logger.warn(`[RegenerateDiff] No original for '${relPath}' — skipped.`);
      return false;
    }
    const modifiedPath = path.join(this.config.modifiedFolder, relPath);
    if (!fsSync.existsSync(modifiedPath)) {
      this.logger.warn(`[RegenerateDiff] No modified file for '${relPath}' — skipped.`);
      return false;
    }
    const diffPath = path.join(this.config.diffFolder, relPath);
    await this.writeDiff(originalPath, modifiedPath, diffPath);
    return true;
  }

  /** Deletes diff files that have no corresponding file in the modified folder (orphan cleanup).
   * `modifiedRelDir` is the selected folder's path relative to modifiedFolder
   * (empty string = the entire modified folder). */
  async runCleanOrphanDiffs(modifiedRelDir: string): Promise<number> {
    const diffSubdir = modifiedRelDir
      ? path.join(this.config.diffFolder, modifiedRelDir)
      : this.config.diffFolder;

    if (!fsSync.existsSync(diffSubdir)) {
      return 0;
    }

    const diffFiles = await walkXmlFiles(diffSubdir);
    let deleted = 0;

    for (const diffFilePath of diffFiles) {
      const relInDiffFolder = path.relative(this.config.diffFolder, diffFilePath);
      const modifiedFilePath = path.join(this.config.modifiedFolder, relInDiffFolder);

      if (!fsSync.existsSync(modifiedFilePath)) {
        try {
          await fs.unlink(diffFilePath);
          this.logger.info(`[CleanOrphans] Deleted orphan diff '${relInDiffFolder}'`);
          deleted++;
        } catch (err) {
          this.logger.warn(`[CleanOrphans] Failed to delete '${relInDiffFolder}': ${err}`);
        }
      }
    }

    return deleted;
  }

  // ─── Disposal ─────────────────────────────────────────────────────────────

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.debounceTimers.forEach((t) => clearTimeout(t));
    this.debounceTimers.clear();
  }
}
