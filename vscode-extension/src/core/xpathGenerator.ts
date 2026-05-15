/**
 * XPath expression generator — port of C# XPathGenerator.cs.
 *
 * Builds `sel` attribute strings for diff operations: walks from an element
 * toward the document root, building the minimal predicate that uniquely
 * identifies the element.
 */
import * as xpath from 'xpath';
import type { Element, Document, Attr } from '@xmldom/xmldom';
import type { DiffOptions } from './types.js';
import { ELEMENT_NODE } from './xmlUtils.js';

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Returns an XPath string that uniquely identifies `element` inside its
 * document.
 *
 * Port of C# XPathGenerator.GenerateXPath.
 */
export function generateXPath(element: Element, options: DiffOptions): string {
  // steps[0] = segment nearest the element, steps[last] = root name.
  // We reverse at the end and join to get root→element order.
  const steps: string[] = [];
  let current: Element = element;

  while (current.parentNode && current.parentNode.nodeType === ELEMENT_NODE) {
    const parent = current.parentNode as Element;
    const doc = !options.onlyFullPath ? (current.ownerDocument ?? null) : null;

    const { step, pathForParent } = getElementPathStep(current, parent, doc, options);

    if (step.startsWith('//')) {
      // Globally unique — prepend and return.
      steps.reverse();
      const below = steps.length > 0 ? '/' + steps.join('/') : '';
      return step + below;
    }

    const resolvedStep = step || getSiblingFallbackStep(current, parent, pathForParent, options);
    steps.push(resolvedStep);
    current = parent;
  }

  // current is the document root element (no element parent)
  steps.push(current.localName ?? current.nodeName);
  steps.reverse();
  return '/' + steps.join('/');
}

// ─── Path step for a single level ─────────────────────────────────────────────

/**
 * Returns { step, pathForParent } where step is the minimal XPath
 * predicate-expression that uniquely identifies `element` within `parent`.
 *
 * Port of C# XPathGenerator.GetElementPathStep.
 */
export function getElementPathStep(
  element: Element,
  parent: Element,
  doc: Document | null,
  options: DiffOptions
): { step: string; pathForParent: string } {
  // Start with name only; add attributes only as needed for uniqueness.
  const localName = element.localName ?? element.nodeName;
  let pathForParent = localName;

  // Check uniqueness with name only first
  if (isUniqueInParent(pathForParent, element, parent)) {
    return tryGlobalUnique(pathForParent, element, doc);
  }

  const firstAttr = element.attributes?.[0] ?? null;
  if (!firstAttr) {
    return { step: '', pathForParent };
  }

  pathForParent += attributeToXpathElement(firstAttr);

  // Check uniqueness with name + first attribute
  if (isUniqueInParent(pathForParent, element, parent)) {
    return tryGlobalUnique(pathForParent, element, doc);
  }

  const remainingAttrs: Attr[] = [];
  for (let i = 1; i < element.attributes.length; i++) {
    remainingAttrs.push(element.attributes[i]);
  }

  // --use-all-attributes: add all remaining attributes at once and test
  if (options.useAllAttributes && remainingAttrs.length > 0) {
    let allPath = pathForParent;
    for (const a of remainingAttrs) {
      allPath += attributeToXpathElement(a);
    }
    if (isUniqueInParent(allPath, element, parent)) {
      return tryGlobalUnique(allPath, element, doc);
    }
  }

  // Try adding attributes one by one (iterative tightening)
  let current = pathForParent;
  for (const attr of remainingAttrs) {
    current += attributeToXpathElement(attr);
    if (isUniqueInParent(current, element, parent)) {
      return tryGlobalUnique(current, element, doc);
    }
  }

  // Could not make unique within parent with any attribute combination
  return { step: '', pathForParent };
}

// ─── Global uniqueness check ──────────────────────────────────────────────────

function tryGlobalUnique(
  step: string,
  element: Element,
  doc: Document | null
): { step: string; pathForParent: string } {
  if (doc) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const globalMatches = (xpath.select('//' + step, doc as any) as unknown[]).filter(
        (n): n is Element => (n as Element).nodeType === ELEMENT_NODE
      );
      if (globalMatches.length === 1 && globalMatches[0] === element) {
        return { step: '//' + step, pathForParent: step };
      }
    } catch {
      // Invalid XPath — fall through
    }
  }
  return { step, pathForParent: step };
}

// ─── Sibling fallback ─────────────────────────────────────────────────────────

/**
 * When no attribute combination can uniquely identify `element` within its
 * parent, fall back to a sibling-relative expression or a numeric position index.
 *
 * Port of C# XPathGenerator.GetSiblingFallbackStep.
 */
export function getSiblingFallbackStep(
  element: Element,
  parent: Element,
  pathForParent: string,
  options: DiffOptions
): string {
  const siblings = getChildElements(parent);
  const index = siblings.indexOf(element);
  const doc = !options.onlyFullPath ? (element.ownerDocument ?? null) : null;
  const elemLocalName = element.localName ?? element.nodeName;

  // Try preceding sibling
  if (index > 0) {
    const prev = siblings[index - 1];
    const { step: prevStep } = getElementPathStep(prev, parent, doc, options);
    if (prevStep && !prevStep.startsWith('//')) {
      return `${prevStep}/following-sibling::${pathForParent}[1]`;
    }
  }

  // Try following sibling
  if (index + 1 < siblings.length) {
    const next = siblings[index + 1];
    const { step: nextStep } = getElementPathStep(next, parent, doc, options);
    if (nextStep && !nextStep.startsWith('//')) {
      return `${nextStep}/preceding-sibling::${pathForParent}[1]`;
    }
  }

  // Count same-named preceding siblings
  const sameNamePreceding = siblings.slice(0, index).filter((s) => (s.localName ?? s.nodeName) === elemLocalName).length;
  if (sameNamePreceding === 0 && siblings.filter((s) => (s.localName ?? s.nodeName) === elemLocalName).length === 1) {
    return pathForParent; // Only one element with this name
  }

  return `${pathForParent}[${sameNamePreceding + 1}]`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isUniqueInParent(xpathExpr: string, element: Element, parent: Element): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matches = (xpath.select(xpathExpr, parent as any) as unknown[]).filter(
      (n): n is Element => (n as Element).nodeType === ELEMENT_NODE
    );
    return matches.length === 1 && matches[0] === element;
  } catch {
    return false;
  }
}

/**
 * Builds an XPath attribute predicate like [@name='value'] or [@name="value"]
 * when the value contains a single quote.
 *
 * Port of C# XPathGenerator.AttributeToXpathElement.
 */
export function attributeToXpathElement(attr: Attr): string {
  const attrName = attr.name ?? attr.localName ?? '';
  const value = attr.value.replace(/"/g, '&quot;');
  return value.includes("'")
    ? `[@${attrName}="${value}"]`
    : `[@${attrName}='${value}']`;
}

/** Returns direct child elements (helper shared with diffEngine). */
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
