/**
 * Extension entry point.
 *
 * Wires together config reading, validation, watcher setup, status bar,
 * and output channel.  Supports multiple independent watcher instances —
 * one per workspace folder or on-disk config file.  Re-initialises when
 * VS Code settings change or an `x4diffandpatch.json` file is created,
 * modified, or deleted anywhere in the workspace.
 */
import * as vscode from 'vscode';
import { readAllConfigs, DISK_CONFIG_FILENAME } from './config.js';
import { WatcherManager } from './watcher.js';
import { StatusBarManager } from './statusBar.js';

let outputChannel: vscode.OutputChannel;
let statusBar: StatusBarManager;
let watchers: WatcherManager[] = [];

// ─── Activate ─────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('X4 Diff and Patch');
  statusBar = new StatusBarManager();

  context.subscriptions.push(outputChannel, statusBar);

  // Command to reveal the output channel (used by the status-bar click)
  context.subscriptions.push(
    vscode.commands.registerCommand('xmlDiffAndPatch.showOutput', () => {
      outputChannel.show();
    })
  );

  // Initial setup
  await initialise();

  // Re-initialise when the user changes VS Code settings
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('xmlDiffAndPatch')) {
        outputChannel.appendLine('[INFO]  Configuration changed — reinitialising…');
        void initialise();
      }
    })
  );

  // Re-initialise when any x4diffandpatch.json is created, changed, or deleted
  const cfgFileWatcher = vscode.workspace.createFileSystemWatcher(
    `**/${DISK_CONFIG_FILENAME}`
  );
  const reinitFromFile = () => {
    outputChannel.appendLine('[INFO]  Config file changed — reinitialising…');
    void initialise();
  };
  cfgFileWatcher.onDidChange(reinitFromFile);
  cfgFileWatcher.onDidCreate(reinitFromFile);
  cfgFileWatcher.onDidDelete(reinitFromFile);
  context.subscriptions.push(cfgFileWatcher);
}

// ─── Deactivate ───────────────────────────────────────────────────────────────

export function deactivate(): void {
  disposeWatchers();
}

// ─── Initialise ───────────────────────────────────────────────────────────────

async function initialise(): Promise<void> {
  disposeWatchers();

  const configs = await readAllConfigs(outputChannel);

  if (configs.length === 0) {
    statusBar.setState('error', 'X4 Diff+Patch: not configured — click to view output');
    return;
  }

  for (const config of configs) {
    outputChannel.appendLine(`[INFO]  ─── [${config.configLabel}] (${config.configSource}) ───`);
    outputChannel.appendLine(`[INFO]    role     : ${config.mainFolderRole} | mode: ${config.watchMode}${config.debug ? ' | debug: on' : ''}`);
    outputChannel.appendLine(`[INFO]    original : ${config.originalFolder}`);
    if (config.pathPrefix) {
      outputChannel.appendLine(`[INFO]    prefix   : ${config.pathPrefix}`);
    }
    outputChannel.appendLine(`[INFO]    modified : ${config.modifiedFolder}`);
    outputChannel.appendLine(`[INFO]    diff     : ${config.diffFolder}`);

    const w = new WatcherManager(config, outputChannel, statusBar);
    w.setup();
    watchers.push(w);
  }

  statusBar.setState('active');
}

function disposeWatchers(): void {
  for (const w of watchers) {
    w.dispose();
  }
  watchers = [];
}

