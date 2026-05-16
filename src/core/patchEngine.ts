/**
 * Patch engine — port of C# PatchEngine.cs.
 *
 * Applies an XML diff document to an original XML document, producing a
 * patched document.
 */
import * as xpath from 'xpath';
import type { Document, Element, Node } from '@xmldom/xmldom';
import type { Logger } from './types.js';
import { NoOpLogger } from './types.js';
import { getElementInfo, ELEMENT_NODE, TEXT_NODE, COMMENT_NODE } from './xmlUtils.js';

// ─── Public patch entry point ─────────────────────────────────────────────────

/**
 * Iterates over all operations in `diffDoc` and applies them to `originalDoc`
 * in order.  Returns the mutated `originalDoc`.
 */
export function applyPatch(
  diffDoc: Document,
  originalDoc: Document,
  allowDoubles: boolean,
  logger: Logger = NoOpLogger
): Document {
  const diffRoot = diffDoc.documentElement;
  if (!diffRoot || diffRoot.localName !== 'diff') {
    logger.error(`Diff root element is not 'diff'. Found: '${diffRoot?.localName}'. Skipping.`);
    return originalDoc;
  }

  const originalRoot = originalDoc.documentElement;
  if (!originalRoot) {
    logger.error('Original document has no root element. Skipping.');
    return originalDoc;
  }

  let child = diffRoot.firstChild;
  while (child) {
    if (child.nodeType === ELEMENT_NODE) {
      const op = child as Element;
      switch (op.localName) {
        case 'add':
          applyAdd(op, originalRoot, allowDoubles, logger);
          break;
        case 'replace':
          applyReplace(op, originalRoot, logger);
          break;
        case 'remove':
          applyRemove(op, originalRoot, logger);
          break;
        default:
          logger.warn(`Unknown diff operation '${op.localName}'. Skipping.`);
      }
    }
    child = child.nextSibling;
  }

  return originalDoc;
}

// ─── ApplyAdd ─────────────────────────────────────────────────────────────────

/**
 * Applies an <add> operation to `originalRoot`.
 *
 * Port of C# PatchEngine.ApplyAdd.
 */
export function applyAdd(
  addElement: Element,
  originalRoot: Element,
  allowDoubles: boolean,
  logger: Logger = NoOpLogger
): void {
  const sel = addElement.getAttribute('sel');
  const type = addElement.getAttribute('type');
  let pos = addElement.getAttribute('pos');

  if (!sel) {
    logger.warn("Add operation missing 'sel' attribute. Skipping.");
    return;
  }

  if (!pos && !type) {
    pos = 'append';
  }

  logger.info(`[Operation add] sel='${sel}' pos='${pos}' type='${type}'`);

  let targets: Element[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    targets = (xpath.select(sel, originalRoot as any) as any[]).filter(
      (n): n is Element => n && n.nodeType === ELEMENT_NODE
    );
  } catch (e) {
    logger.warn(`[Operation add] Invalid XPath '${sel}': ${e}. Skipping.`);
    return;
  }

  if (targets.length === 0) {
    logger.warn(
      `[Operation add] No element found for sel='${sel}'. Last resolvable: '${lastApplicableNode(sel, originalRoot)}'. Skipping.`
    );
    return;
  }
  if (targets.length > 1) {
    logger.warn(
      `[Operation add] Multiple elements (${targets.length}) found for sel='${sel}'. Skipping.`
    );
    return;
  }

  const target = targets[0];
  const ownerDoc = originalRoot.ownerDocument!;

  // ── Attribute add (type="@attrName") ────────────────────────────────────────
  if (type) {
    if (type.startsWith('@') && type.length > 1) {
      target.setAttribute(type.slice(1), addElement.textContent ?? '');
      logger.info(
        `[Operation add] Set attribute '${type.slice(1)}' = '${addElement.textContent}' on ${getElementInfo(target)}`
      );
    } else {
      logger.warn(`[Operation add] Unsupported type value '${type}'. Skipping.`);
    }
    return;
  }

  // ── Element / comment add (positional) ──────────────────────────────────────
  let latestAdded: Node | null = null;

  let addChild = addElement.firstChild;
  while (addChild) {
    const isElem = addChild.nodeType === ELEMENT_NODE;
    const isComment = addChild.nodeType === COMMENT_NODE;

    if (!isElem && !isComment) {
      addChild = addChild.nextSibling;
      continue;
    }

    const cloned = ownerDoc.importNode(addChild, true) as Element;

    if (!latestAdded) {
      // First node: apply duplicate check for elements, then insert at position
      if (isElem && !allowDoubles) {
        const clonedElem = cloned as Element;
        const searchIn: Element[] = pos === 'before' || pos === 'after'
          ? getChildElements(target.parentNode as Element)
          : getChildElements(target);

        const isDuplicate = searchIn.some(
          (e) =>
            e.localName === clonedElem.localName &&
            Array.from(e.attributes).every(
              (a) => clonedElem.getAttribute(a.name) === a.value
            ) &&
            Array.from(clonedElem.attributes).every(
              (a) => e.getAttribute(a.name) === a.value
            )
        );

        if (isDuplicate) {
          logger.warn(
            `[Operation add] Duplicate element ${getElementInfo(clonedElem)} already exists. Skipping.`
          );
          addChild = addChild.nextSibling;
          continue;
        }
      }

      switch (pos) {
        case 'before':
          target.parentNode!.insertBefore(cloned, target);
          logger.info(`[Operation add] Inserted before ${getElementInfo(target)}`);
          break;
        case 'after': {
          const next = target.nextSibling;
          if (next) {
            target.parentNode!.insertBefore(cloned, next);
          } else {
            target.parentNode!.appendChild(cloned);
          }
          logger.info(`[Operation add] Inserted after ${getElementInfo(target)}`);
          break;
        }
        case 'prepend':
          target.insertBefore(cloned, target.firstChild);
          logger.info(`[Operation add] Prepended to ${getElementInfo(target)}`);
          break;
        case 'append':
        default:
          target.appendChild(cloned);
          logger.info(`[Operation add] Appended to ${getElementInfo(target)}`);
          break;
      }

      latestAdded = cloned;
    } else {
      // Subsequent nodes: always insertAfter the latest to preserve insertion order
      const next = latestAdded.nextSibling;
      if (next) {
        latestAdded.parentNode!.insertBefore(cloned, next);
      } else {
        latestAdded.parentNode!.appendChild(cloned);
      }
      latestAdded = cloned;
      logger.info(`[Operation add] Added subsequent node after previous`);
    }

    addChild = addChild.nextSibling;
  }
}

// ─── ApplyReplace ─────────────────────────────────────────────────────────────

/**
 * Applies a <replace> operation to `originalRoot`.
 *
 * Port of C# PatchEngine.ApplyReplace.
 */
export function applyReplace(
  replaceElement: Element,
  originalRoot: Element,
  logger: Logger = NoOpLogger
): void {
  const sel = replaceElement.getAttribute('sel');
  if (!sel) {
    logger.warn("Replace operation missing 'sel' attribute. Skipping.");
    return;
  }

  logger.info(`[Operation replace] sel='${sel}'`);

  let results: unknown[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    results = xpath.select(sel, originalRoot as any) as unknown[];
  } catch (e) {
    logger.warn(`[Operation replace] Invalid XPath '${sel}': ${e}. Skipping.`);
    return;
  }

  if (!results || results.length === 0) {
    logger.warn(
      `[Operation replace] No nodes found for sel='${sel}'. Last resolvable: '${lastApplicableNode(sel, originalRoot)}'. Skipping.`
    );
    return;
  }

  const ownerDoc = originalRoot.ownerDocument!;

  for (const result of results) {
    const node = result as Node;
    if (node.nodeType === ELEMENT_NODE) {
      const target = node as Element;
      // Collect replacement elements from the <replace> body
      const replaceContent: Element[] = [];
      let c = replaceElement.firstChild;
      while (c) {
        if (c.nodeType === ELEMENT_NODE) {
          replaceContent.push(ownerDoc.importNode(c, true) as Element);
        }
        c = c.nextSibling;
      }

      if (replaceContent.length > 0) {
        const parent = target.parentNode!;
        // Insert all replacements before target, then remove target
        for (const rc of replaceContent) {
          parent.insertBefore(rc, target);
        }
        parent.removeChild(target);
        logger.info(
          `[Operation replace] Replaced ${getElementInfo(target)} with ${replaceContent.length} element(s)`
        );
      } else {
        logger.warn(
          `[Operation replace] No child elements in replace for sel='${sel}'. Skipping.`
        );
      }
    } else if (node.nodeType === TEXT_NODE) {
      (node as Node & { data: string }).data = replaceElement.textContent ?? '';
      logger.info(
        `[Operation replace] Set text node value to '${replaceElement.textContent}'`
      );
    } else if ((node as unknown as { nodeType: number }).nodeType === 2 /* ATTRIBUTE */) {
      // Attr node
      (node as unknown as { value: string }).value = replaceElement.textContent ?? '';
      logger.info(
        `[Operation replace] Set attribute value to '${replaceElement.textContent}'`
      );
    } else {
      logger.warn(
        `[Operation replace] Unsupported node type for sel='${sel}'. Skipping.`
      );
    }
  }
}

// ─── ApplyRemove ─────────────────────────────────────────────────────────────

/**
 * Applies a <remove> operation to `originalRoot`.
 *
 * Port of C# PatchEngine.ApplyRemove.
 */
export function applyRemove(
  removeElement: Element,
  originalRoot: Element,
  logger: Logger = NoOpLogger
): void {
  const sel = removeElement.getAttribute('sel');
  if (!sel) {
    logger.warn("Remove operation missing 'sel' attribute. Skipping.");
    return;
  }

  logger.info(`[Operation remove] sel='${sel}'`);

  let results: unknown[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    results = xpath.select(sel, originalRoot as any) as unknown[];
  } catch (e) {
    logger.warn(`[Operation remove] Invalid XPath '${sel}': ${e}. Skipping.`);
    return;
  }

  if (!results || results.length === 0) {
    logger.warn(
      `[Operation remove] No nodes found for sel='${sel}'. Last resolvable: '${lastApplicableNode(sel, originalRoot)}'. Skipping.`
    );
    return;
  }

  for (const result of results) {
    const node = result as Node;
    if (node.nodeType === ELEMENT_NODE && node.parentNode) {
      node.parentNode.removeChild(node);
      logger.info(`[Operation remove] Removed element ${getElementInfo(node as Element)}`);
    } else if ((node as unknown as { nodeType: number }).nodeType === 2 /* ATTRIBUTE */ && (node as unknown as { ownerElement: Element | null }).ownerElement) {
      const attr = node as unknown as { ownerElement: Element; name: string };
      attr.ownerElement.removeAttribute(attr.name);
      logger.info(`[Operation remove] Removed attribute '${attr.name}'`);
    } else if (node.nodeType === TEXT_NODE && node.parentNode) {
      node.parentNode.removeChild(node);
      logger.info(`[Operation remove] Removed text node`);
    } else {
      logger.warn(
        `[Operation remove] Cannot remove node type ${node.nodeType} or node has no parent. Skipping.`
      );
    }
  }
}

// ─── Debug helper ─────────────────────────────────────────────────────────────

/**
 * Splits sel on '/' and returns the longest prefix path that still matches
 * something in root.  Used in warning messages.
 *
 * Port of C# PatchEngine.LastApplicableNode.
 */
function lastApplicableNode(selector: string, root: Element): string {
  const parts = selector.split('/');
  let current = '';
  let last = '';
  for (const part of parts) {
    if (!part) {
      current += '/';
      continue;
    }
    current += (current.endsWith('/') ? '' : '/') + part;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matches = xpath.select(current, root as any) as unknown[];
      if (matches && matches.length > 0) {
        last = current;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return last;
}

// ─── Internal helper ──────────────────────────────────────────────────────────

function getChildElements(element: Element): Element[] {
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
