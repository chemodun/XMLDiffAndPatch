/**
 * Extension entry point.
 *
 * Wires together config reading, validation, watcher setup, status bar,
 * and output channel.  Supports multiple independent watcher instances —
 * one per workspace folder or on-disk config file.  Re-initialises when
 * VS Code settings change.
 */
import * as vscode from 'vscode';
import { readAllConfigs, migrateSettings } from './config.js';
import { WatcherManager } from './watcher.js';
import { StatusBarManager } from './statusBar.js';
import { registerExplorerCommands } from './commands.js';
import { SettingsPanelProvider } from './settingsPanel.js';

let outputChannel: vscode.OutputChannel;
let statusBar: StatusBarManager;
let watchers: WatcherManager[] = [];

// ─── Activate ─────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('XML Diff and Patch');
  statusBar = new StatusBarManager();

  context.subscriptions.push(outputChannel, statusBar);

  // Command to reveal the output channel (used by the status-bar click)
  context.subscriptions.push(
    vscode.commands.registerCommand('xmlDiffAndPatch.showOutput', () => {
      outputChannel.show();
    })
  );

  // Explorer context-menu commands
  registerExplorerCommands(context, () => watchers);

  // Sidebar panel for editing folderPairs per scope
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SettingsPanelProvider.viewType,
      new SettingsPanelProvider(outputChannel)
    )
  );

  // Migrate legacy modifiedFolder/diffFolder/pathPrefix settings to folderPairs
  await migrateSettings(outputChannel);

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
    statusBar.setState('error', 'XML Diff+Patch: not configured — click to view output');
    return;
  }

  for (const config of configs) {
    outputChannel.appendLine(`[INFO]  ─── [${config.configLabel}] (${config.configSource}) ───`);
    outputChannel.appendLine(`[INFO]    mode     : ${config.watchMode}${config.debug ? ' | debug: on' : ''}`);
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

