import React, { useState } from "react";
import { Modal } from "../ui/Modal";

// ============================================================================
// PasswordPromptModal — collect a password to unlock a protected statement PDF
// ============================================================================

export type PasswordPromptSaveOption =
  | { kind: "fixed"; accountId: string; accountLabel: string }
  | { kind: "choose"; accounts: Array<{ id: string; label: string }> }
  | { kind: "none" };

interface PasswordPromptModalProps {
  /** Name of the file being unlocked (shown in the body). */
  fileName?: string;
  /** Inline error, e.g. "Incorrect password. Try again." */
  error?: string | null;
  /** Submitting state (retry in flight). */
  isSubmitting?: boolean;
  /** Controls the "save to bank account" affordance. */
  saveOption: PasswordPromptSaveOption;
  onSubmit: (input: { password: string; saveToAccountId?: string }) => void;
  onCancel: () => void;
}

/** 16px minimum, or iOS Safari zooms the viewport on focus and never zooms back out. */
const FIELD_CLASS =
  "w-full rounded-lg border border-slate-300 px-3 text-base outline-none transition-colors focus:border-teal-500 sm:text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100";

export const PasswordPromptModal: React.FC<PasswordPromptModalProps> = ({
  fileName,
  error,
  isSubmitting = false,
  saveOption,
  onSubmit,
  onCancel,
}) => {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [save, setSave] = useState(false);
  const [chosenAccount, setChosenAccount] = useState(
    saveOption.kind === "choose" ? (saveOption.accounts[0]?.id ?? "") : "",
  );

  const submit = () => {
    if (!password.trim() || isSubmitting) return;
    let saveToAccountId: string | undefined;
    if (save) {
      if (saveOption.kind === "fixed") saveToAccountId = saveOption.accountId;
      else if (saveOption.kind === "choose") saveToAccountId = chosenAccount || undefined;
    }
    onSubmit({ password: password.trim(), saveToAccountId });
  };

  const blocked = isSubmitting || !password.trim();

  return (
    <Modal
      open
      onClose={onCancel}
      title="This statement is password-protected"
      description={
        fileName
          ? `Enter the password for "${fileName}" to unlock it.`
          : "Enter the password to unlock this PDF."
      }
      mobile="fullscreen"
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={blocked}
            className="h-11 rounded-lg bg-teal-600 px-4 text-sm font-medium text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {isSubmitting ? "Unlocking…" : "Unlock"}
          </button>
        </>
      }
    >
      <label
        htmlFor="statement-password"
        className="mb-1.5 block text-xs font-semibold tracking-wider text-slate-500 uppercase dark:text-slate-400"
      >
        Password
      </label>
      <div className="flex items-center gap-2">
        <input
          id="statement-password"
          type={show ? "text" : "password"}
          value={password}
          data-autofocus
          autoComplete="off"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          className={`${FIELD_CLASS} h-11`}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="h-11 shrink-0 px-2 text-sm text-slate-500 transition-colors hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
        >
          {show ? "Hide" : "Show"}
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {saveOption.kind !== "none" && (
        <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 py-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={save}
            onChange={(e) => setSave(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-teal-600"
          />
          {saveOption.kind === "fixed"
            ? `Save this password to ${saveOption.accountLabel} for future statements`
            : "Save this password to a bank account for future statements"}
        </label>
      )}

      {saveOption.kind === "choose" && save && (
        <select
          value={chosenAccount}
          onChange={(e) => setChosenAccount(e.target.value)}
          className={`${FIELD_CLASS} mt-2 h-11`}
        >
          {saveOption.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      )}
    </Modal>
  );
};

export default PasswordPromptModal;
