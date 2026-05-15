// Core types shared across diff/patch engine, watcher, and config.

/** Options controlling diff generation behaviour. Port of C# DiffOptions. */
export interface DiffOptions {
  /** When true, restrict to full absolute XPath; when false (default), use // shorthand when globally unique. */
  onlyFullPath: boolean;
  /** Include all attributes (not just the minimal distinguishing set) in XPath predicates. */
  useAllAttributes: boolean;
  /** Attribute name to ignore when comparing elements. null = compare all attributes. */
  ignoreDiffInAttribute: string | null;
}

/** Resolved and validated watcher configuration (derived from VS Code settings). */
export interface WatcherConfig {
  originalFolder: string;
  mainFolderRole: 'modified' | 'diff';
  modifiedFolder: string;
  diffFolder: string;
  /** Absolute path to diff.xsd, or null if the file does not exist. */
  xsdPath: string | null;
  onlyFullPath: boolean;
  useAllAttributes: boolean;
  ignoreDiffInAttribute: string | null;
  reflectToMainFolder: boolean;
  passOtherFiles: boolean;
  showDiffEditorOnSave: boolean;
  allowDoubles: boolean;
  watchMode: 'onSave' | 'onTheFly';
  debounceMs: number;
}

/** Minimal logging interface used by the engine layer. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Logger that discards all messages. */
export const NoOpLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
