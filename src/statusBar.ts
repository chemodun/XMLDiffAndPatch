/**
 * Status bar item manager.
 *
 * Shows the extension's operational state in the VS Code status bar.
 */
import * as vscode from 'vscode';

export type StatusBarState = 'active' | 'error' | 'processing' | 'unconfigured';

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'xmlDiffAndPatch.showOutput';
    this.setState('unconfigured');
    this.item.show();
  }

  setState(state: StatusBarState, detail?: string): void {
    switch (state) {
      case 'active':
        this.item.text = '$(check) XML Diff+Patch';
        this.item.tooltip = detail ?? 'XML Diff and Patch: watching for changes';
        this.item.backgroundColor = undefined;
        break;
      case 'processing':
        this.item.text = '$(sync~spin) XML Diff+Patch';
        this.item.tooltip = detail ?? 'XML Diff and Patch: processing…';
        this.item.backgroundColor = undefined;
        break;
      case 'error':
        this.item.text = '$(error) XML Diff+Patch';
        this.item.tooltip = detail ?? 'XML Diff and Patch: configuration error — click to view output';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
      case 'unconfigured':
        this.item.text = '$(circle-slash) XML Diff+Patch';
        this.item.tooltip = detail ?? 'XML Diff and Patch: not configured';
        this.item.backgroundColor = undefined;
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
