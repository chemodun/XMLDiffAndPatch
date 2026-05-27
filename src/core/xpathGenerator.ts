/**
 * XPath expression generator — port of C# XPathGenerator.cs.
 *
 * Builds `sel` attribute strings for diff operations: walks from an element
 * toward the document root, building the minimal predicate that uniquely
 * identifies the element.
 */
import type { Element, Document, Attr } from '@xmldom/xmldom';
import type { DiffOptions } from './types.js';
import { ELEMENT_NODE } from './xmlUtils.js';

// ─── Compiled regexes ─────────────────────────────────────────────────────────

// Matches [@attr='val'] or [@attr="val"] predicates in an XPath step string.
const ATTR_PREDICATE_RE = /\[@([\w:.-]+)='([^']*)'\]|\[@([\w:.-]+)="([^"]*)"\]/g;

// Matches a numeric position predicate like [1], [2], [3] …
const NUMERIC_INDEX_RE = /\[\d+\]/;

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
  let nextOnPath: Element | null = null; // child of 'current' that lies on the path to the target

  while (current.parentNode && current.parentNode.nodeType === ELEMENT_NODE) {
    const parent = current.parentNode as Element;
    const doc = !options.onlyFullPath ? (current.ownerDocument ?? null) : null;

    const { step, pathForParent } = getElementPathStep(current, parent, doc, options, nextOnPath);

    if (step.startsWith('//')) {
      // Globally unique — prepend and return.
      steps.reverse();
      const below = steps.length > 0 ? '/' + steps.join('/') : '';
      return step + below;
    }

    const resolvedStep = step || getSiblingFallbackStep(current, parent, pathForParent, options);

    // getSiblingFallbackStep may return a complete path starting with / or //
    if (resolvedStep.startsWith('/')) {
      steps.reverse();
      const below = steps.length > 0 ? '/' + steps.join('/') : '';
      return resolvedStep + below;
    }

    nextOnPath = current; // for next iteration: current's parent knows current is on the path
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
  options: DiffOptions,
  onPathChild: Element | null = null
): { step: string; pathForParent: string } {
  // Start with name only; add attributes only as needed for uniqueness.
  const localName = element.localName ?? element.nodeName;
  let pathForParent = localName;

  // Check uniqueness with name only first
  if (isUniqueInParent(pathForParent, element, parent)) {
    if (options.humanReadable) {
      const fa = element.attributes?.[0];
      if (fa) {
        const humanStep = pathForParent + attributeToXpathElement(fa);
        return tryGlobalUnique(humanStep, element, doc);
      }
    }
    return tryGlobalUnique(pathForParent, element, doc);
  }

  const firstAttr = element.attributes?.[0] ?? null;
  if (!firstAttr) {
    // No own attributes — try qualifying by a direct child element predicate before giving up
    const noAttrResult = tryChildPredicateStep(element, parent, pathForParent, doc, onPathChild);
    if (noAttrResult !== null) return noAttrResult;
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
  // Try child element predicate as last resort before falling through
  const childResult = tryChildPredicateStep(element, parent, pathForParent, doc, onPathChild);
  if (childResult !== null) return childResult;
  return { step: '', pathForParent };
}

// ─── Global uniqueness check ──────────────────────────────────────────────────

/**
 * LINQ-style global search — namespace-aware via localName comparison.
 * Port of C# XPathGenerator.TryGlobalUnique.
 */
function tryGlobalUnique(
  step: string,
  element: Element,
  doc: Document | null
): { step: string; pathForParent: string } {
  if (doc) {
    const { localName, attrs } = parseXPathStep(step);
    let candidates = getAllDescendants(doc).filter(
      (e) => (e.localName ?? e.nodeName) === localName
    );
    for (const { name, value } of attrs) {
      candidates = candidates.filter((e) => hasAttribute(e, name, value));
    }
    if (candidates.length === 1 && candidates[0] === element) {
      return { step: '//' + step, pathForParent: step };
    }
  }
  return { step, pathForParent: step };
}

// ─── Child-predicate qualification ────────────────────────────────────────────────

/**
 * Tries to uniquely qualify `element` within `parent` using a direct child
 * existence predicate: e.g. do_else[do_if[@value='X']].
 * Returns the step tuple, or null if no child predicate achieves uniqueness.
 *
 * Port of C# XPathGenerator.TryChildPredicateStep.
 */
function tryChildPredicateStep(
  element: Element,
  parent: Element,
  pathForParent: string,
  doc: Document | null,
  preferredChild: Element | null = null
): { step: string; pathForParent: string } | null {
  const localName = element.localName ?? element.nodeName;

  // Phase 1: If the on-path child can uniquely qualify this element, return the plain name.
  // The path continues through that child, which provides the discrimination by itself:
  //   e.g. do_else/do_if[@value='x']/...  is preferred over  do_else[do_if[@value='x']]/do_if[@value='x']/...
  if (preferredChild !== null && preferredChild.parentNode === element) {
    let childPred = preferredChild.localName ?? preferredChild.nodeName;

    if (isUniqueByChildPredicate(localName, childPred, element, parent)) {
      return { step: localName, pathForParent };
    }

    if (preferredChild.attributes) {
      for (let i = 0; i < preferredChild.attributes.length; i++) {
        childPred += attributeToXpathElement(preferredChild.attributes[i]);
        if (isUniqueByChildPredicate(localName, childPred, element, parent)) {
          return { step: localName, pathForParent };
        }
      }
    }
  }

  // Phase 2: Try non-on-path children as predicates — return elem[child_pred] form.
  const otherChildren =
    preferredChild !== null && preferredChild.parentNode === element
      ? getChildElements(element).filter((c) => c !== preferredChild)
      : getChildElements(element);

  for (const child of otherChildren) {
    const childLocalName = child.localName ?? child.nodeName;
    let childPred = childLocalName;

    // Try name-only child predicate first
    if (isUniqueByChildPredicate(localName, childPred, element, parent)) {
      const fullStep = `${localName}[${childPred}]`;
      return tryGlobalUniqueChildPredicate(fullStep, localName, childPred, element, doc, pathForParent);
    }

    // Add child attributes one by one
    if (child.attributes) {
      for (let i = 0; i < child.attributes.length; i++) {
        childPred += attributeToXpathElement(child.attributes[i]);
        if (isUniqueByChildPredicate(localName, childPred, element, parent)) {
          const fullStep = `${localName}[${childPred}]`;
          return tryGlobalUniqueChildPredicate(fullStep, localName, childPred, element, doc, pathForParent);
        }
      }
    }
  }

  return null;
}

function isUniqueByChildPredicate(
  elemLocalName: string,
  childPred: string,
  element: Element,
  parent: Element
): boolean {
  const { localName: childLocalName, attrs: childAttrs } = parseXPathStep(childPred);
  const childMatches = (e: Element): boolean =>
    getChildElements(e).some(
      (c) =>
        (c.localName ?? c.nodeName) === childLocalName &&
        childAttrs.every(({ name, value }) => hasAttribute(c, name, value))
    );

  const candidates = getChildElements(parent).filter(
    (e) => (e.localName ?? e.nodeName) === elemLocalName && childMatches(e)
  );
  return candidates.length === 1 && candidates[0] === element;
}

function tryGlobalUniqueChildPredicate(
  fullStep: string,
  elemLocalName: string,
  childPred: string,
  element: Element,
  doc: Document | null,
  pathForParent: string
): { step: string; pathForParent: string } {
  if (doc) {
    const { localName: childLocalName, attrs: childAttrs } = parseXPathStep(childPred);
    const childMatches = (e: Element): boolean =>
      getChildElements(e).some(
        (c) =>
          (c.localName ?? c.nodeName) === childLocalName &&
          childAttrs.every(({ name, value }) => hasAttribute(c, name, value))
      );

    const candidates = getAllDescendants(doc).filter(
      (e) => (e.localName ?? e.nodeName) === elemLocalName && childMatches(e)
    );
    if (candidates.length === 1 && candidates[0] === element) {
      return { step: '//' + fullStep, pathForParent };
    }
  }
  return { step: fullStep, pathForParent };
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

  // Pre-parse pathForParent for attribute-aware sibling counting (name + attributes).
  const { localName: pfpLocalName, attrs: pfpAttrs } = parseXPathStep(pathForParent);
  const matchesPfp = (e: Element): boolean =>
    (e.localName ?? e.nodeName) === pfpLocalName &&
    pfpAttrs.every(({ name, value }) => hasAttribute(e, name, value));

  // Try preceding sibling
  if (index > 0) {
    const prev = siblings[index - 1];
    const { step: prevStep } = getElementPathStep(prev, parent, doc, options);
    if (prevStep) {
      // Count elements matching pathForParent (name + attributes) among following siblings.
      const followingCount = siblings.slice(index).filter(matchesPfp).length;
      if (followingCount === 1) {
        return `${prevStep}/following-sibling::${pathForParent}`;
      }
      // Would need [1] — try full-path fallback first.
      if (!options.onlyFullPath) {
        const fullPath = tryFullPathFallback(element, options);
        if (fullPath !== null) return fullPath;
      }
      return `${prevStep}/following-sibling::${pathForParent}[1]`;
    }
  }

  // Try following sibling
  if (index + 1 < siblings.length) {
    const next = siblings[index + 1];
    const { step: nextStep } = getElementPathStep(next, parent, doc, options);
    if (nextStep) {
      const precedingCount = siblings.slice(0, index + 1).filter(matchesPfp).length;
      if (precedingCount === 1) {
        return `${nextStep}/preceding-sibling::${pathForParent}`;
      }
      if (!options.onlyFullPath) {
        const fullPath = tryFullPathFallback(element, options);
        if (fullPath !== null) return fullPath;
      }
      return `${nextStep}/preceding-sibling::${pathForParent}[1]`;
    }
  }

  // Count same-named preceding siblings
  const sameNamePreceding = siblings
    .slice(0, index)
    .filter((s) => (s.localName ?? s.nodeName) === elemLocalName).length;
  if (
    sameNamePreceding === 0 &&
    siblings.filter((s) => (s.localName ?? s.nodeName) === elemLocalName).length === 1
  ) {
    return pathForParent; // Only one element with this name
  }

  // Last resort: try full-path fallback first.
  if (!options.onlyFullPath) {
    const fullPath = tryFullPathFallback(element, options);
    if (fullPath !== null) return fullPath;
  }

  return `${pathForParent}[${sameNamePreceding + 1}]`;
}

/**
 * Attempts to generate an absolute XPath for `element` using full-path mode.
 * Returns the path only if it contains no numeric position indices (i.e., avoids [x]);
 * returns null if the full path itself still requires a positional index.
 *
 * Port of C# XPathGenerator.TryFullPathFallback.
 */
function tryFullPathFallback(element: Element, options: DiffOptions): string | null {
  const fullPathOptions: DiffOptions = { ...options, onlyFullPath: true };
  const result = generateXPath(element, fullPathOptions);
  return NUMERIC_INDEX_RE.test(result) ? null : result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parses an XPath step of the form "localName[@a='v'][@b='v']..." into its parts.
 * Attribute values with &quot; are unescaped back to '"'.
 *
 * Port of C# XPathGenerator.ParseXPathStep.
 */
function parseXPathStep(step: string): { localName: string; attrs: { name: string; value: string }[] } {
  const bracketIdx = step.indexOf('[');
  const localName = bracketIdx < 0 ? step : step.slice(0, bracketIdx);
  const attrs: { name: string; value: string }[] = [];
  for (const m of step.matchAll(ATTR_PREDICATE_RE)) {
    const attrName = m[1] ?? m[3];
    const attrValue = (m[2] ?? m[4]).replace(/&quot;/g, '"');
    attrs.push({ name: attrName, value: attrValue });
  }
  return { localName, attrs };
}

/**
 * LINQ-style uniqueness check — namespace-aware via localName comparison.
 * Works correctly for elements with namespace prefixes (e.g. xs:complexType).
 *
 * Port of C# XPathGenerator.IsUniqueInParent.
 */
function isUniqueInParent(step: string, element: Element, parent: Element): boolean {
  const { localName, attrs } = parseXPathStep(step);
  let candidates = getChildElements(parent).filter(
    (e) => (e.localName ?? e.nodeName) === localName
  );
  for (const { name, value } of attrs) {
    candidates = candidates.filter((e) => hasAttribute(e, name, value));
  }
  return candidates.length === 1 && candidates[0] === element;
}

/** Returns true if element has an attribute matching localName and value. */
function hasAttribute(element: Element, localName: string, value: string): boolean {
  if (!element.attributes) return false;
  for (let i = 0; i < element.attributes.length; i++) {
    const a = element.attributes[i];
    if ((a.localName ?? a.name ?? '') === localName && a.value === value) return true;
  }
  return false;
}

/** Returns all descendant elements of a document (inclusive of root). */
function getAllDescendants(doc: Document): Element[] {
  const result: Element[] = [];
  function traverse(node: Element): void {
    let child = node.firstChild;
    while (child) {
      if (child.nodeType === ELEMENT_NODE) {
        const el = child as Element;
        result.push(el);
        traverse(el);
      }
      child = child.nextSibling;
    }
  }
  const root = doc.documentElement;
  if (root) {
    result.push(root);
    traverse(root);
  }
  return result;
}

/**
 * Builds an XPath attribute predicate like [@name='value'] or [@name="value"]
 * when the value contains a single quote.
 *
 * Port of C# XPathGenerator.AttributeToXpathElement.
 */
export function attributeToXpathElement(attr: Attr): string {
  const attrName = attr.localName ?? attr.name ?? '';
  const value = attr.value.replace(/"/g, '&quot;');
  return value.includes("'")
    ? `[@${attrName}="${value}"]`
    : `[@${attrName}='${value}']`;
}

/** Returns direct child elements. */
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
