/**
 * Extension entry point.
 *
 * Wires together config reading, validation, watcher setup, status bar,
 * and output channel.  Re-initialises when workspace settings change.
 */
import * as vscode from 'vscode';
import { readConfig } from './config.js';
import { WatcherManager } from './watcher.js';
import { StatusBarManager } from './statusBar.js';

let outputChannel: vscode.OutputChannel;
let statusBar: StatusBarManager;
let watcher: WatcherManager | null = null;

// ─── Activate ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
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
  initialise();

  // Re-initialise when the user changes settings
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('xmlDiffAndPatch')) {
        outputChannel.appendLine('[INFO]  Configuration changed — reinitialising…');
        initialise();
      }
    })
  );
}

// ─── Deactivate ───────────────────────────────────────────────────────────────

export function deactivate(): void {
  watcher?.dispose();
  watcher = null;
}

// ─── Initialise ───────────────────────────────────────────────────────────────

function initialise(): void {
  // Tear down any previous watcher
  watcher?.dispose();
  watcher = null;

  const config = readConfig(outputChannel);

  if (!config) {
    statusBar.setState('error', 'X4 Diff+Patch: configuration error — click to view output');
    return;
  }

  outputChannel.appendLine(
    `[INFO]  Starting with mainFolderRole='${config.mainFolderRole}', watchMode='${config.watchMode}'`
  );
  outputChannel.appendLine(`[INFO]  originalFolder : ${config.originalFolder}`);
  outputChannel.appendLine(`[INFO]  modifiedFolder : ${config.modifiedFolder}`);
  outputChannel.appendLine(`[INFO]  diffFolder     : ${config.diffFolder}`);

  watcher = new WatcherManager(config, outputChannel, statusBar);
  watcher.setup();
  statusBar.setState('active');
}
