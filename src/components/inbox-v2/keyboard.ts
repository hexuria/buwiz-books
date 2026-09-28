/**
 * Inbox v2 keyboard shortcuts: j / k move, a approves, r rejects, e focuses the editor.
 *
 * A shortcut never fires while the user is typing (inputs, textareas, selects, comboboxes,
 * contenteditable), with a modifier held, or from inside another dialog — "a" in a vendor name
 * must stay an "a".
 */
export type InboxKeyAction = "next" | "previous" | "approve" | "reject" | "focus_editor";

const KEY_ACTIONS: Record<string, InboxKeyAction> = {
  j: "next",
  k: "previous",
  a: "approve",
  r: "reject",
  e: "focus_editor",
};

/** The mobile reading drawer is itself a dialog; shortcuts still apply inside it. */
export const INBOX_DRAWER_ATTRIBUTE = "data-inbox-drawer";

export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
  return target.closest('[role="combobox"], [role="listbox"], [role="option"]') !== null;
}

function isInsideOtherDialog(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  const dialog = target.closest('[role="dialog"], [aria-modal="true"]');
  return dialog !== null && !dialog.hasAttribute(INBOX_DRAWER_ATTRIBUTE);
}

export function inboxKeyAction(
  event: Pick<
    KeyboardEvent,
    "key" | "target" | "defaultPrevented" | "metaKey" | "ctrlKey" | "altKey" | "repeat"
  >,
): InboxKeyAction | null {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isTypingTarget(event.target) || isInsideOtherDialog(event.target)) return null;
  const action = KEY_ACTIONS[event.key] ?? null;
  // Holding a decision key must not approve or reject a run of items.
  if (event.repeat && (action === "approve" || action === "reject")) return null;
  return action;
}
