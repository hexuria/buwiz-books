/**
 * TransactionEditor — the New transaction editor as one component: seed it with `draft`, get the
 * edited draft back through `onSubmit`. It never saves and never navigates.
 *
 * Same state, validation, and card as /transactions/new (useTransactionEditor and its parts),
 * arranged for a reading pane: the type tabs run across the top, and there is one party for the
 * whole entry. Key the component to load another draft.
 */
import { useImperativeHandle, useRef, useState, type Ref } from "react";
import type { ComboboxOption } from "../../ui/Combobox";
import { useTransactionEditor } from "./useTransactionEditor";
import {
  TransactionCategoryModal,
  TransactionEntryCard,
  TransactionTypeTabs,
} from "./TransactionEditorParts";
import type { TransactionDraft } from "./transaction-draft";

export interface TransactionEditorHandle {
  /** The form as it stands, unvalidated. */
  getDraft: () => TransactionDraft;
  /** The page's own checks; says what is wrong in a toast and returns false. */
  validate: () => boolean;
  /** Whether anything differs from the draft the editor was seeded with. */
  isDirty: () => boolean;
  /** Move keyboard focus into the form. */
  focus: () => void;
}

export interface TransactionEditorProps {
  draft: TransactionDraft;
  onSubmit: (draft: TransactionDraft) => void;
  /** Label for the draft's party until a party search loads it. */
  partyOption?: ComboboxOption | null;
  pending?: boolean;
  /** Keep the save button off (the Inbox, while the item cannot be edited). */
  submitDisabled?: boolean;
  submitLabel?: string;
  pendingLabel?: string;
  ref?: Ref<TransactionEditorHandle>;
}

export function TransactionEditor({
  draft,
  onSubmit,
  partyOption = null,
  pending = false,
  submitDisabled = false,
  submitLabel = "Save",
  pendingLabel = "Saving…",
  ref,
}: TransactionEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [initialDraft] = useState(draft);
  const editor = useTransactionEditor({
    initialDraft,
    partyMode: "header",
    initialPartyOption: partyOption,
  });

  useImperativeHandle(ref, () => ({
    getDraft: editor.getDraft,
    validate: editor.validate,
    isDirty: () => JSON.stringify(editor.getDraft()) !== JSON.stringify(initialDraft),
    focus: () =>
      containerRef.current
        ?.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select")
        ?.focus(),
  }));

  return (
    <div ref={containerRef} className="space-y-3">
      <TransactionTypeTabs editor={editor} orientation="horizontal" />
      <TransactionEntryCard editor={editor} />
      <div className="flex justify-end">
        <button
          type="button"
          disabled={pending || submitDisabled}
          onClick={() => {
            if (editor.validate()) onSubmit(editor.getDraft());
          }}
          className="rounded-lg bg-[var(--color-app-header-teal)] px-5 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-[#248f82] disabled:opacity-50"
        >
          {pending ? pendingLabel : submitLabel}
        </button>
      </div>
      <TransactionCategoryModal editor={editor} />
    </div>
  );
}
