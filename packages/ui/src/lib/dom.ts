/**
 * Type checks for DOM values that hold across documents. The Studio canvas draws blocks inside an
 * iframe, whose elements are not `instanceof` the host window's `Element` or `HTMLElement`; each
 * check below asks the element's own window instead, so a block works in any document.
 */

export const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  "nodeType" in value &&
  typeof value.nodeType === "number";

export const isElement = (value: unknown): value is Element =>
  isNode(value) && value.nodeType === 1;

export const isHtmlElement = (value: unknown): value is HTMLElement =>
  isElement(value) &&
  value instanceof (value.ownerDocument.defaultView?.HTMLElement ?? HTMLElement);

export const isInputElement = (value: unknown): value is HTMLInputElement =>
  isElement(value) && value.localName === "input";

export const isTextAreaElement = (value: unknown): value is HTMLTextAreaElement =>
  isElement(value) && value.localName === "textarea";
