import React from "react";
import { Modal } from "../ui/Modal";
import { NewCategoryForm, type NewCategoryData, type CategoryPrefill } from "./NewCategoryForm";

// ============================================================================
// Types
// ============================================================================

interface NewCategoryModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: NewCategoryData) => void;
  prefill?: CategoryPrefill;
  parentCategories?: Array<{ id: string; name: string; accountNumber?: string }>;
}

/**
 * `NewCategoryForm` owns its own card chrome — teal header, footer buttons and a
 * hardcoded `w-[360px]`, which overflows a 375px viewport once the modal's own
 * padding is added. The form is shared with other surfaces, so it is relaxed from
 * the outside here rather than rewritten: the card goes full-width and its inputs
 * are raised to 16px below `sm` so iOS Safari does not zoom on focus.
 */
const FORM_SHELL =
  "[&>div]:w-full [&>div]:shadow-none [&_input]:text-base [&_select]:text-base [&_textarea]:text-base sm:[&_input]:text-sm sm:[&_select]:text-sm sm:[&_textarea]:text-sm";

// ============================================================================
// Component
// ============================================================================

export const NewCategoryModal: React.FC<NewCategoryModalProps> = ({
  open,
  onClose,
  onSubmit,
  prefill,
  parentCategories = [],
}) => (
  <Modal
    open={open}
    onClose={onClose}
    title="New Category"
    // The form renders its own header and Cancel/Create row; a second header on
    // top of it would read as two stacked title bars.
    hideHeader
    mobile="fullscreen"
    size="sm"
    bodyClassName="p-0 pt-safe"
  >
    <div className={FORM_SHELL}>
      <NewCategoryForm
        parentCategories={parentCategories}
        onSubmit={onSubmit}
        onCancel={onClose}
        prefill={prefill}
      />
    </div>
  </Modal>
);

export default NewCategoryModal;
