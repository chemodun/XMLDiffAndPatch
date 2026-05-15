/**
 * File-save watcher.
 *
 * Implements §6 of the specification:
 *   - Watches the main folder and (when reflectToMainFolder = true) the
 *     secondary folder.
 *   - On save, resolves which operation to run (DiffEngine / PatchEngine /
 *     passOtherFiles copy), writes the output, and guards against loops.
 *   - Supports both "onSave" mode (workspace.onDidSaveTextDocument) and
 *     "onTheFly" mode (FileSystemWatcher with debounce).
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

/** Returns true when the diff Document root has no child operation elements. */
function isDiffEmpty(doc: Document): boolean {
  const root = doc.documentElement;
  if (!root) return true;
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === ELEMENT_NODE) return false;
  }
  return true;
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
function makeLogger(channel: vscode.OutputChannel, label: string): Logger {
  const tag = `[${label}]`;
  return {
    info: (msg) => channel.appendLine(`[INFO]  ${tag} ${msg}`),
    warn: (msg) => channel.appendLine(`[WARN]  ${tag} ${msg}`),
    error: (msg) => channel.appendLine(`[ERROR] ${tag} ${msg}`),
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
    this.logger = makeLogger(outputChannel, config.configLabel);
  }

  // ─── Setup ────────────────────────────────────────────────────────────────

  setup(): void {
    const { mainFolderRole, modifiedFolder, diffFolder, reflectToMainFolder, watchMode } =
      this.config;

    const mainFolder = mainFolderRole === 'modified' ? modifiedFolder : diffFolder;
    const secondaryFolder = mainFolderRole === 'modified' ? diffFolder : modifiedFolder;

    if (watchMode === 'onSave') {
      this.disposables.push(
        vscode.workspace.onDidSaveTextDocument((doc) =>
          this.handleSaveEvent(doc.uri.fsPath, mainFolder, secondaryFolder)
        )
      );
    } else {
      // onTheFly — FileSystemWatcher for main folder
      this.addFsWatcher(mainFolder, mainFolder, secondaryFolder);

      if (reflectToMainFolder && secondaryFolder) {
        this.addFsWatcher(secondaryFolder, mainFolder, secondaryFolder);
      }
    }
  }

  private addFsWatcher(
    watchedFolder: string,
    mainFolder: string,
    secondaryFolder: string
  ): void {
    const pattern = new vscode.RelativePattern(watchedFolder, '**/*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handler = (uri: vscode.Uri) =>
      this.handleDebounced(uri.fsPath, mainFolder, secondaryFolder);

    watcher.onDidChange(handler);
    watcher.onDidCreate(handler);
    this.disposables.push(watcher);
  }

  private handleDebounced(
    filePath: string,
    mainFolder: string,
    secondaryFolder: string
  ): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.handleSaveEvent(filePath, mainFolder, secondaryFolder);
    }, this.config.debounceMs);
    this.debounceTimers.set(filePath, timer);
  }

  // ─── Core handler ─────────────────────────────────────────────────────────

  private handleSaveEvent(
    filePath: string,
    mainFolder: string,
    secondaryFolder: string
  ): void {
    // Loop guard
    if (this.outputPaths.has(filePath)) {
      return;
    }

    const relMain = getRelativePath(filePath, mainFolder);
    const relSecondary = secondaryFolder
      ? getRelativePath(filePath, secondaryFolder)
      : null;

    if (relMain !== null) {
      this.processFile(filePath, relMain, 'main', mainFolder, secondaryFolder).catch((err) =>
        this.logger.error(`Unhandled error processing '${filePath}': ${err}`)
      );
    } else if (relSecondary !== null && this.config.reflectToMainFolder) {
      this.processFile(filePath, relSecondary, 'secondary', mainFolder, secondaryFolder).catch(
        (err) => this.logger.error(`Unhandled error processing '${filePath}': ${err}`)
      );
    }
  }

  // ─── File processing ───────────────────────────────────────────────────────

  private async processFile(
    savedPath: string,
    relPath: string,
    source: 'main' | 'secondary',
    mainFolder: string,
    secondaryFolder: string
  ): Promise<void> {
    const { config } = this;
    const isXml = path.extname(savedPath).toLowerCase() === '.xml';
    // pathPrefix is inserted between originalFolder and the file's relative path
    // so the original can live in a sub-tree that differs from the mod layout.
    // The prefix is NOT applied to the output (diff / patch / copy) path.
    const originalPath = path.join(config.originalFolder, config.pathPrefix, relPath);
    const originalExists = fsSync.existsSync(originalPath);
    this.logger.info(`[Check] original: '${originalPath}' — ${originalExists ? 'found' : 'NOT FOUND'}`);

    // Determine output folder and operation
    let outputFolder: string;
    let operation: 'diff' | 'patch' | 'copy';

    if (source === 'main') {
      outputFolder = secondaryFolder;
      if (isXml && originalExists) {
        operation = config.mainFolderRole === 'modified' ? 'diff' : 'patch';
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
      // secondary → reflect back to main
      outputFolder = mainFolder;
      if (isXml && originalExists) {
        operation = config.mainFolderRole === 'modified' ? 'patch' : 'diff';
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
      switch (behavior) {
        case 'skip':
          this.logger.info(`[Diff] No differences found — skipped: '${outputPath}'`);
          return;
        case 'warn':
          this.logger.warn(`[Diff] No differences found — output not written: '${outputPath}'`);
          return;
        case 'delete':
          if (fsSync.existsSync(outputPath)) {
            await fs.unlink(outputPath);
            this.logger.info(`[Diff] No differences — deleted existing output: '${outputPath}'`);
          } else {
            this.logger.info(`[Diff] No differences — nothing to delete: '${outputPath}'`);
          }
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
      await fs.copyFile(sourcePath, outputPath);
    } finally {
      setTimeout(() => this.outputPaths.delete(outputPath), 500);
    }
  }

  /** Writes content to outputPath, ensuring the directory exists, with loop guard. */
  private async writeOutput(outputPath: string, content: string): Promise<void> {
    await this.ensureDir(outputPath);
    this.outputPaths.add(outputPath);
    try {
      await fs.writeFile(outputPath, content, 'utf-8');
    } finally {
      setTimeout(() => this.outputPaths.delete(outputPath), 500);
    }
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

  // ─── Disposal ─────────────────────────────────────────────────────────────

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.debounceTimers.forEach((t) => clearTimeout(t));
    this.debounceTimers.clear();
  }
}
