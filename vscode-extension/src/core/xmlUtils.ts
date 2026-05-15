/**
 * Utility helpers — port of C# XmlUtils.cs.
 * All functions are pure (no I/O, no VS Code dependencies).
 */
import type { Element, Node, Comment } from '@xmldom/xmldom';

// ─── Node type constants ──────────────────────────────────────────────────────

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;

// ─── Indentation detection ────────────────────────────────────────────────────

/**
 * Detects the per-level indentation size from XML content by examining the
 * minimum difference between distinct leading-whitespace lengths on lines that
 * start XML content.  Returns 4 if no indented lines are found.
 *
 * Port of C# XmlUtils.DetectIndentation.
 */
export function detectIndentation(xmlContent: string): number {
  const indentLengths = new Set<number>();

  for (const line of xmlContent.split(/\r?\n/)) {
    const m = line.match(/^(\s+)</);
    if (m) {
      indentLengths.add(m[1].length);
    }
  }

  if (indentLengths.size < 2) {
    return 4;
  }

  const sorted = Array.from(indentLengths).sort((a, b) => a - b);
  let minDiff = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const diff = sorted[i] - sorted[i - 1];
    if (diff > 0 && diff < minDiff) {
      minDiff = diff;
    }
  }

  return minDiff === Infinity ? 4 : minDiff;
}

// ─── Text value ───────────────────────────────────────────────────────────────

/**
 * Returns the content of the first XmlNodeType.Text child node, or "".
 * Does NOT include content from child elements.
 *
 * Port of C# XmlUtils.GetTextValue.
 */
export function getTextValue(element: Element): string {
  let child = element.firstChild;
  while (child) {
    if (child.nodeType === TEXT_NODE) {
      return (child as Node & { data: string }).data ?? child.nodeValue ?? '';
    }
    child = child.nextSibling;
  }
  return '';
}

// ─── pos=before comment ───────────────────────────────────────────────────────

/**
 * Returns true if the node immediately before `element` in its parent's node
 * list is a comment whose value (trimmed) contains pos=before / pos="before" /
 * pos='before'.
 *
 * Port of C# XmlUtils.IsElementPrecededByPosBeforeComment.
 */
export function isElementPrecededByPosBeforeComment(element: Element): boolean {
  const parent = element.parentNode;
  if (!parent) {
    return false;
  }

  let prev: Node | null = null;
  let child = parent.firstChild;
  while (child) {
    if (child === (element as unknown as Node)) {
      break;
    }
    prev = child;
    child = child.nextSibling;
  }

  if (prev && prev.nodeType === COMMENT_NODE) {
    const val = ((prev as unknown as Comment).data ?? prev.nodeValue ?? '').trim();
    return (
      val.toLowerCase().includes('pos=before') ||
      val.toLowerCase().includes('pos="before"') ||
      val.toLowerCase().includes("pos='before'")
    );
  }
  return false;
}

// ─── Debug helper ─────────────────────────────────────────────────────────────

/**
 * Returns a human-readable string like <tagName firstAttr="value" ...>.
 *
 * Port of C# XmlUtils.GetElementInfo.
 */
export function getElementInfo(element: Element | null): string {
  if (!element) {
    return '<null>';
  }
  let s = '<' + element.localName;
  const first = element.attributes?.[0];
  if (first) {
    s += ` ${first.name}="${first.value}"`;
    if (element.attributes.length > 1) {
      s += ' ...';
    }
  }
  s += '>';
  return s;
}

// ─── Child element helpers ────────────────────────────────────────────────────

/**
 * Returns all direct child elements of `element` (skips text/comment nodes).
 */
export function getChildElements(element: Element): Element[] {
  const result: Element[] = [];
  let child = element.firstChild;
  while (child) {
    if (child.nodeType === ELEMENT_NODE) {
      result.push(child as Element);
    }
    child = child.nextSibling;
  }
  return result;
}
