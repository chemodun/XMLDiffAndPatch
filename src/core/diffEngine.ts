/**
 * Diff engine — port of C# DiffEngine.cs.
 *
 * Generates an XML diff document describing the operations needed to transform
 * `original` into `modified`.
 */
import { DOMParser } from '@xmldom/xmldom';
import type { Document, Element } from '@xmldom/xmldom';
import type { DiffOptions, Logger } from './types.js';
import { NoOpLogger } from './types.js';
import { getTextValue, getChildElements, isElementPrecededByPosBeforeComment } from './xmlUtils.js';
import { generateXPath } from './xpathGenerator.js';

const NUMERIC_INDEX_PATTERN = /\[\d+\]/;

export class DiffEngine {
  private readonly options: DiffOptions;
  private readonly logger: Logger;
  private diffDoc!: Document;

  constructor(options: DiffOptions, logger: Logger = NoOpLogger) {
    this.options = options;
    this.logger = logger;
  }

  // ─── Public entry point ────────────────────────────────────────────────────

  /**
   * Compares two XML documents and returns a <diff> document containing the
   * minimum set of add/replace/remove operations.
   *
   * Port of C# DiffEngine.GenerateDiff.
   */
  generateDiff(original: Document, modified: Document): Document {
    this.diffDoc = new DOMParser().parseFromString('<diff/>', 'text/xml');
    const diffRoot = this.diffDoc.documentElement!;

    if (!original.documentElement || !modified.documentElement) {
      return this.diffDoc;
    }

    this.compareElements(original, modified, diffRoot);
    return this.diffDoc;
  }

  // ─── Core recursive comparison ─────────────────────────────────────────────

  /**
   * Recursively compares elements and emits diff operations into diffRoot.
   * Returns true if any difference was detected (meaningful only in checkOnly mode).
   *
   * Port of C# DiffEngine.CompareElements.
   */
  private compareElements(
    original: Document,
    modified: Document,
    diffRoot: Element,
    originalElem: Element | null = null,
    modifiedElem: Element | null = null
  ): void {
    // ── Step 1: element-level comparison ──────────────────────────────────────
    if (originalElem && modifiedElem) {
      if (originalElem.localName !== modifiedElem.localName) {
        return;
      }

      const origText = getTextValue(originalElem).trim();
      const modText = getTextValue(modifiedElem).trim();

      if (origText !== modText) {

        const xp = generateXPath(originalElem, this.options);
        if (modText) {
          const replaceOp = this.createElement('replace');
          replaceOp.setAttribute('sel', xp);
          replaceOp.appendChild(this.diffDoc.createTextNode(modText));
          this.diffRootAddOperation(diffRoot, replaceOp);
          this.logger.info(`[Operation replace] text in ${xp}`);
        } else {
          const removeOp = this.createElement('remove');
          removeOp.setAttribute('sel', xp + '/text()');
          this.diffRootAddOperation(diffRoot, removeOp);
          this.logger.info(`[Operation remove] text in ${xp}`);
        }
      }
    }

    // ── Step 2: resolve element references ────────────────────────────────────
    const origEl = originalElem ?? original.documentElement!;
    const modEl = modifiedElem ?? modified.documentElement!;
    const originalChildren = getChildElements(origEl);
    const modifiedChildren = getChildElements(modEl);

    // ── Step 3: root attribute comparison (only at actual document roots) ──────
    if (!originalElem) {
      const { savedOp: rootSavedOp } = this.compareAttributes(
        original.documentElement!,
        modified.documentElement!,
        false
      );
      if (rootSavedOp) {
        this.diffRootAddOperation(diffRoot, rootSavedOp);
      }
    }

    const editSteps = computeDiff(originalChildren, modifiedChildren);
    let lastRemovedOrReplaced = -1;
    let s = 0;

    while (s < editSteps.length) {
      const step = editSteps[s];

      if (step.op === 'equal') {
        this.compareElements(original, modified, diffRoot,
          originalChildren[step.indexA], modifiedChildren[step.indexB]);
        s++;
      } else {
        const deletes: number[] = [];
        const inserts: number[] = [];
        while (s < editSteps.length && editSteps[s].op !== 'equal') {
          if (editSteps[s].op === 'delete') deletes.push(editSteps[s].indexA);
          else inserts.push(editSteps[s].indexB);
          s++;
        }
        const nextOrigIdx = s < editSteps.length ? editSteps[s].indexA : originalChildren.length;
        lastRemovedOrReplaced = this.processEditBlock(
          deletes, inserts, nextOrigIdx,
          original, modified, originalChildren, modifiedChildren,
          origEl, diffRoot, lastRemovedOrReplaced
        );
      }
    }

  }

  // ─── LCS edit block processor ─────────────────────────────────────────────

  /**
   * Processes one edit block (consecutive Delete/Insert steps between two Equal anchors).
   * Greedily pairs deletes with compatible inserts (same name + ≤1 attr diff).
   * Returns the updated lastRemovedOrReplaced index.
   *
   * Port of C# DiffEngine.ProcessEditBlock.
   */
  private processEditBlock(
    deletes: number[],
    inserts: number[],
    nextOrigIdx: number,
    original: Document,
    modified: Document,
    originalChildren: Element[],
    modifiedChildren: Element[],
    origEl: Element,
    diffRoot: Element,
    lastRemovedOrReplaced: number
  ): number {
    const usedInserts = new Array<boolean>(inserts.length).fill(false);
    const paired: Array<[number, number]> = [];
    const unpairedDeletes: number[] = [];

    // Greedily pair each delete with the first compatible insert (same name + ≤1 attr diff)
    for (const origIdx of deletes) {
      let found = false;
      for (let ii = 0; ii < inserts.length; ii++) {
        if (usedInserts[ii]) continue;
        const origElem = originalChildren[origIdx];
        const modElem = modifiedChildren[inserts[ii]];
        if (origElem.localName === modElem.localName &&
            this.compareAttributes(origElem, modElem, true).matchedEnough) {
          usedInserts[ii] = true;
          paired.push([origIdx, inserts[ii]]);
          found = true;
          break;
        }
      }
      if (!found) unpairedDeletes.push(origIdx);
    }

    const unpairedInserts: number[] = [];
    for (let ii = 0; ii < inserts.length; ii++) {
      if (!usedInserts[ii]) unpairedInserts.push(inserts[ii]);
    }

    // Emit paired operations: attribute change (+ child recurse) or full replace
    for (const [origIdx, modIdx] of paired) {
      const origElem = originalChildren[origIdx];
      const modElem = modifiedChildren[modIdx];
      const { matchedEnough, savedOp } = this.compareAttributes(origElem, modElem, false);
      if (matchedEnough) {
        if (savedOp) {
          this.diffRootAddOperation(diffRoot, savedOp);
          this.logger.info(`[Operation ${savedOp.localName}] attribute: ${savedOp.getAttribute('sel')}`);
          // Attribute was renamed — XPath identity changed, treat as unavailable for pos="after" anchoring
          lastRemovedOrReplaced = Math.max(lastRemovedOrReplaced, origIdx);
        }
        this.compareElements(original, modified, diffRoot, origElem, modElem);
      } else {
        const xpath = generateXPath(origElem, this.options);
        const replaceOp = this.createElement('replace');
        replaceOp.setAttribute('sel', xpath);
        replaceOp.appendChild(this.diffDoc.importNode(modElem, true));
        this.diffRootAddOperation(diffRoot, replaceOp);
        this.logger.info(`[Operation replace] ${xpath}`);
        lastRemovedOrReplaced = origIdx;
      }
    }

    // Positionally pair remaining deletes and inserts as <replace> operations.
    // Even though element names differ (same-name pairing skipped them), if both sides
    // have the same count they are 1:1 positional replacements. If counts differ,
    // pair as many as possible and leave the surplus as remove/add.
    const replacePairCount = Math.min(unpairedDeletes.length, unpairedInserts.length);
    for (let pi = 0; pi < replacePairCount; pi++) {
      const origIdx = unpairedDeletes[pi];
      const modIdx  = unpairedInserts[pi];
      const xpath = generateXPath(originalChildren[origIdx], this.options);
      const replaceOp = this.createElement('replace');
      replaceOp.setAttribute('sel', xpath);
      replaceOp.appendChild(modifiedChildren[modIdx].cloneNode(true) as Element);
      this.diffRootAddOperation(diffRoot, replaceOp);
      this.logger.info(`[Operation replace] ${xpath}`);
      lastRemovedOrReplaced = Math.max(lastRemovedOrReplaced, origIdx);
    }

    // Emit any surplus removes (when deletes > inserts)
    for (let di = replacePairCount; di < unpairedDeletes.length; di++) {
      const origIdx = unpairedDeletes[di];
      const xpath = generateXPath(originalChildren[origIdx], this.options);
      const removeOp = this.createElement('remove');
      removeOp.setAttribute('sel', xpath);
      this.diffRootAddOperation(diffRoot, removeOp);
      this.logger.info(`[Operation remove] ${xpath}`);
      lastRemovedOrReplaced = origIdx;
    }

    // Emit any surplus inserts (when inserts > deletes) as a batched <add>
    const remainingInserts = unpairedInserts.slice(replacePairCount);
    if (remainingInserts.length > 0) {
      const j = remainingInserts[0];
      const k = remainingInserts[remainingInserts.length - 1] + 1;

      // Any element touched (removed OR paired/renamed) may have a stale XPath as pos="after" anchor.
      // Use the highest touched original index so buildAddOperation can switch to pos="before".
      let maxBlockOrigIdx = lastRemovedOrReplaced;
      for (const [origIdx] of paired) {
        maxBlockOrigIdx = Math.max(maxBlockOrigIdx, origIdx);
      }

      const addOp = this.buildAddOperation(
        originalChildren, modifiedChildren, origEl,
        nextOrigIdx, j, k, maxBlockOrigIdx
      );
      this.diffRootAddOperation(diffRoot, addOp);
      this.logger.info(`[Operation add] ${remainingInserts.length} element(s)`);
    }

    return lastRemovedOrReplaced;
  }

  // ─── Attribute comparison ──────────────────────────────────────────────────

  /**
   * Compares attributes of two elements.
   * Returns { matchedEnough, savedOp } where matchedEnough = true when there
   * is at most one attribute difference, savedOp = the single diff operation
   * to emit (null when 0 or >1 diffs, or in checkOnly mode).
   *
   * Port of C# DiffEngine.CompareAttributes.
   */
  private compareAttributes(
    originalElement: Element,
    modifiedElement: Element,
    checkOnly: boolean
  ): { matchedEnough: boolean; savedOp: Element | null } {
    let matchedEnough = true;
    let savedOp: Element | null = null;
    let differencesCount = 0;

    const originalAttrs = new Map<string, string>();
    for (let i = 0; i < originalElement.attributes.length; i++) {
      const a = originalElement.attributes[i];
      originalAttrs.set(a.name, a.value);
    }

    const modifiedAttrs = new Map<string, string>();
    for (let i = 0; i < modifiedElement.attributes.length; i++) {
      const a = modifiedElement.attributes[i];
      modifiedAttrs.set(a.name, a.value);
    }

    const ignore = this.options.ignoreDiffInAttribute;

    // Check attributes present in modified
    for (const [key, modValue] of modifiedAttrs) {
      if (key === ignore) {
        continue;
      }

      if (!originalAttrs.has(key)) {
        differencesCount++;
        if (differencesCount > 1) {
          matchedEnough = false;
          break;
        }
        if (!checkOnly) {
          const xp = generateXPath(originalElement, this.options);
          savedOp = this.createElement('add');
          savedOp.setAttribute('sel', xp);
          savedOp.setAttribute('type', '@' + key);
          savedOp.appendChild(this.diffDoc.createTextNode(modValue));
        }
      } else if (originalAttrs.get(key) !== modValue) {
        differencesCount++;
        if (differencesCount > 1) {
          matchedEnough = false;
          break;
        }
        if (!checkOnly) {
          const xp = generateXPath(originalElement, this.options);
          savedOp = this.createElement('replace');
          savedOp.setAttribute('sel', `${xp}/@${key}`);
          savedOp.appendChild(this.diffDoc.createTextNode(modValue));
        }
      }
    }

    // Check attributes present in original but absent from modified
    if (matchedEnough) {
      for (const [key] of originalAttrs) {
        if (key === ignore) {
          continue;
        }
        if (!modifiedAttrs.has(key)) {
          differencesCount++;
          if (differencesCount > 1) {
            matchedEnough = false;
            break;
          }
          if (checkOnly) continue;
          const xp = generateXPath(originalElement, this.options);
          savedOp = this.createElement('remove');
          savedOp.setAttribute('sel', `${xp}/@${key}`);
        }
      }
    }

    if (checkOnly) {
      return { matchedEnough, savedOp: null };
    }

    if (matchedEnough && differencesCount === 1) {
      return { matchedEnough: true, savedOp };
    }

    return { matchedEnough, savedOp: null };
  }

  // ─── Add operation builder ────────────────────────────────────────────────

  /**
   * Builds the <add> element for inserting modifiedChildren[j..k-1] into
   * the patched tree.  Determines pos="before", "after", or "prepend".
   *
   * Port of C# DiffEngine.BuildAddOperation.
   */
  private buildAddOperation(
    originalChildren: Element[],
    modifiedChildren: Element[],
    origEl: Element,
    i: number,
    j: number,
    k: number,
    lastRemovedOrReplaced: number
  ): Element {
    let pos: string;
    let sel: string;

    if (i === 0) {
      pos = 'prepend';
      sel = generateXPath(origEl, this.options);
    } else {
      const usePosBeforeComment = isElementPrecededByPosBeforeComment(modifiedChildren[j]);
      const prevAnchorRemoved = lastRemovedOrReplaced === i - 1;
      const prevXPath = generateXPath(originalChildren[i - 1], this.options);
      const prevHasNumericIndex = NUMERIC_INDEX_PATTERN.test(prevXPath);

      if (usePosBeforeComment || prevAnchorRemoved || prevHasNumericIndex) {
        if (i < originalChildren.length) {
          // Prefer pos="before" on the current original element
          const beforeXPath = generateXPath(originalChildren[i], this.options);
          if (!NUMERIC_INDEX_PATTERN.test(beforeXPath)) {
            pos = 'before';
            sel = beforeXPath;
          } else {
            // Fall back to pos="after" the previous element
            pos = 'after';
            sel = prevXPath;
          }
        } else {
          // No next element + stale anchor → append to parent
          pos = '';
          sel = generateXPath(origEl, this.options);
        }
      } else {
        pos = 'after';
        sel = prevXPath;
      }
    }

    const addOp = this.createElement('add');
    addOp.setAttribute('sel', sel);
    if (pos) addOp.setAttribute('pos', pos);

    for (let n = j; n < k; n++) {
      addOp.appendChild(this.diffDoc.importNode(modifiedChildren[n], true));
    }

    return addOp;
  }

  // ─── Ordering rule for diffRoot ────────────────────────────────────────────

  /**
   * Appends `op` to `diffRoot`, but inserts it BEFORE the last child when
   * that last child is a <remove> with the same sel as op.
   * This ensures correct sequential patching order.
   *
   * Port of C# DiffEngine.DiffRootAddOperation.
   */
  private diffRootAddOperation(diffRoot: Element, op: Element): void {
    const children = getChildElements(diffRoot);
    const last = children[children.length - 1] ?? null;

    if (
      last &&
      last.localName === 'remove' &&
      last.getAttribute('sel') === op.getAttribute('sel') &&
      op.localName !== 'remove'
    ) {
      diffRoot.insertBefore(op, last);
    } else {
      diffRoot.appendChild(op);
    }
  }

  // ─── Helper ───────────────────────────────────────────────────────────────

  private createElement(tagName: string): Element {
    return this.diffDoc.createElement(tagName);
  }
}

// ─── Exact element match (module-level, pure) ─────────────────────────────────

/**
 * Two elements exactly match when they have the same name, the same number of
 * attributes, and every attribute value is identical.
 *
 * Port of C# DiffEngine.ExactlyMatches.
 */
function exactlyMatches(a: Element, b: Element): boolean {
  if (a.localName !== b.localName) {
    return false;
  }
  if (a.attributes.length !== b.attributes.length) {
    return false;
  }
  for (let i = 0; i < a.attributes.length; i++) {
    const attr = a.attributes[i];
    if (b.getAttribute(attr.name) !== attr.value) {
      return false;
    }
  }
  return getTextValue(a).trim() === getTextValue(b).trim();
}

// ─── LCS edit types and helpers ──────────────────────────────────────────────

type EditOp = 'equal' | 'delete' | 'insert';

interface EditStep {
  op: EditOp;
  indexA: number;
  indexB: number;
}

/**
 * Computes the LCS-based edit script between two child element lists.
 * Returns a list of equal/delete/insert steps in forward (left-to-right) order.
 *
 * Port of C# DiffEngine.ComputeDiff.
 */
function computeDiff(a: Element[], b: Element[]): EditStep[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = exactlyMatches(a[i - 1], b[j - 1])
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result: EditStep[] = [];
  let x = n;
  let y = m;
  while (x > 0 || y > 0) {
    if (x > 0 && y > 0 && exactlyMatches(a[x - 1], b[y - 1]) && dp[x][y] === dp[x - 1][y - 1] + 1) {
      result.push({ op: 'equal', indexA: x - 1, indexB: y - 1 });
      x--;
      y--;
    } else if (y > 0 && (x === 0 || dp[x][y - 1] >= dp[x - 1][y])) {
      result.push({ op: 'insert', indexA: -1, indexB: y - 1 });
      y--;
    } else {
      result.push({ op: 'delete', indexA: x - 1, indexB: -1 });
      x--;
    }
  }
  result.reverse();
  return result;
}
