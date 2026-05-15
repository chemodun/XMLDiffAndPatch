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
import { getTextValue, getChildElements, isElementPrecededByPosBeforeComment, getElementInfo, ELEMENT_NODE } from './xmlUtils.js';
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
    modifiedElem: Element | null = null,
    checkOnly = false
  ): boolean {
    // ── Step 1: element-level comparison ──────────────────────────────────────
    if (originalElem && modifiedElem) {
      if (originalElem.localName !== modifiedElem.localName) {
        return true; // name mismatch — only valid in checkOnly context
      }

      const origText = getTextValue(originalElem);
      const modText = getTextValue(modifiedElem);

      if (origText !== modText) {
        if (checkOnly) {
          return true;
        }

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
    if (!checkOnly && !originalElem) {
      const { savedOp: rootSavedOp } = this.compareAttributes(
        original.documentElement!,
        modified.documentElement!,
        false
      );
      if (rootSavedOp) {
        this.diffRootAddOperation(diffRoot, rootSavedOp);
      }
    }

    // ── Step 4: early exit in checkOnly when children counts differ ───────────
    if (checkOnly && originalChildren.length !== modifiedChildren.length) {
      return true;
    }

    // ── Step 5: two-pointer child comparison ──────────────────────────────────
    let i = 0;
    let j = 0;
    let lastRemovedOrReplaced = -1;

    while (i < originalChildren.length && j < modifiedChildren.length) {
      const originalChild = originalChildren[i];
      const modifiedChild = modifiedChildren[j];
      let matchedEnough = false;

      if (originalChild.localName === modifiedChild.localName) {
        const { matchedEnough: attrMatched, savedOp } = this.compareAttributes(
          originalChild,
          modifiedChild,
          checkOnly
        );
        matchedEnough = attrMatched;

        if (matchedEnough && savedOp) {
          // One attribute diff — verify children and next siblings also align.
          const childrenMatch = !this.compareElements(
            original,
            modified,
            diffRoot,
            originalChild,
            modifiedChild,
            true
          );

          const siblingsAlign =
            i + 1 === originalChildren.length ||
            j + 1 === modifiedChildren.length ||
            (originalChildren[i + 1].localName === modifiedChildren[j + 1].localName &&
              this.compareAttributes(originalChildren[i + 1], modifiedChildren[j + 1], true)
                .matchedEnough);

          if (childrenMatch && siblingsAlign) {
            if (!checkOnly) {
              this.diffRootAddOperation(diffRoot, savedOp);
            }
            // matchedEnough stays true
          } else {
            matchedEnough = false;
          }
        }
      }

      if (matchedEnough) {
        if (checkOnly) {
          if (
            this.compareElements(
              original,
              modified,
              diffRoot,
              originalChild,
              modifiedChild,
              true
            )
          ) {
            return true;
          }
        } else {
          this.compareElements(
            original,
            modified,
            diffRoot,
            originalChild,
            modifiedChild,
            false
          );
        }
        i++;
        j++;
      } else {
        if (checkOnly) {
          return true;
        }

        // ── Phase A: look for originalChild further ahead in modifiedChildren ──
        let foundMatch = false;
        for (let k = j + 1; k < modifiedChildren.length; k++) {
          if (exactlyMatches(modifiedChildren[k], originalChild)) {
            // modifiedChildren[j..k-1] are new → emit a single <add>
            const addOp = this.buildAddOperation(
              originalChildren,
              modifiedChildren,
              origEl,
              i,
              j,
              k,
              lastRemovedOrReplaced
            );
            this.diffRootAddOperation(diffRoot, addOp);
            this.logger.info(
              `[Operation add] ${k - j} element(s) before ${getElementInfo(originalChild)}`
            );
            j = k;
            foundMatch = true;
            break;
          }
        }

        if (!foundMatch) {
          // ── Phase B: decide between remove and replace ─────────────────────
          const nextOriginalFoundLaterInModified =
            i + 1 < originalChildren.length &&
            modifiedChildren
              .slice(j + 1)
              .some((mc) => exactlyMatches(mc, originalChildren[i + 1]));

          const nextOriginalIsCurrentModified = originalChildren
            .slice(i + 1)
            .some((oc) => exactlyMatches(oc, modifiedChild));

          const shouldReplace =
            !nextOriginalIsCurrentModified &&
            ((originalChild.localName === modifiedChild.localName &&
              Array.from(originalChild.attributes).some(
                (a) => modifiedChild.getAttribute(a.name) === a.value
              )) ||
              i + 1 === originalChildren.length ||
              nextOriginalFoundLaterInModified);

          if (shouldReplace) {
            const xp = generateXPath(originalChild, this.options);
            const replaceOp = this.createElement('replace');
            replaceOp.setAttribute('sel', xp);
            replaceOp.appendChild(this.diffDoc.importNode(modifiedChild, true));

            // Bundle additional modified children that don't match the next original
            let k = j + 1;
            while (k < modifiedChildren.length) {
              if (
                i + 1 < originalChildren.length &&
                exactlyMatches(modifiedChildren[k], originalChildren[i + 1])
              ) {
                break;
              }
              replaceOp.appendChild(this.diffDoc.importNode(modifiedChildren[k], true));
              k++;
            }

            this.diffRootAddOperation(diffRoot, replaceOp);
            this.logger.info(`[Operation replace] ${xp}`);
            lastRemovedOrReplaced = i;
            i++;
            j = k;
          } else {
            const xp = generateXPath(originalChild, this.options);
            const removeOp = this.createElement('remove');
            removeOp.setAttribute('sel', xp);
            this.diffRootAddOperation(diffRoot, removeOp);
            this.logger.info(`[Operation remove] ${xp}`);
            lastRemovedOrReplaced = i;
            i++;
            // j intentionally stays the same
          }
        }
      }
    }

    // ── Drain remaining original children (all removed) ───────────────────────
    while (i < originalChildren.length) {
      const xp = generateXPath(originalChildren[i], this.options);
      const removeOp = this.createElement('remove');
      removeOp.setAttribute('sel', xp);
      this.diffRootAddOperation(diffRoot, removeOp);
      this.logger.info(`[Operation remove] ${xp}`);
      i++;
    }

    // ── Drain remaining modified children (all appended) ──────────────────────
    if (j < modifiedChildren.length) {
      const parentXPath = generateXPath(origEl, this.options);
      const addOp = this.createElement('add');
      addOp.setAttribute('sel', parentXPath);
      for (let k = j; k < modifiedChildren.length; k++) {
        addOp.appendChild(this.diffDoc.importNode(modifiedChildren[k], true));
      }
      this.diffRootAddOperation(diffRoot, addOp);
      this.logger.info(`[Operation add] append to ${parentXPath}`);
    }

    return false;
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
          if (checkOnly) {
            return { matchedEnough: true, savedOp: null }; // has diff but ≤1 total
          }
          differencesCount++;
          if (differencesCount > 1 || originalAttrs.size === 1) {
            matchedEnough = false;
            break;
          }
          const xp = generateXPath(originalElement, this.options);
          savedOp = this.createElement('remove');
          savedOp.setAttribute('sel', `${xp}/@${key}`);
        }
      }
    }

    if (matchedEnough && differencesCount === 1) {
      if (checkOnly) {
        return { matchedEnough: true, savedOp: null };
      }
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
        pos = 'after';
        sel = prevXPath;
      }
    }

    const addOp = this.createElement('add');
    addOp.setAttribute('sel', sel);
    addOp.setAttribute('pos', pos);

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
  return true;
}
