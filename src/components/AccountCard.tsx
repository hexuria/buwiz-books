import React from "react";
import { type Account } from "../db/validation/accounts";

interface AccountCardProps {
  account: Account;
  onEdit?: (id: string) => void;
}

/**
 * AccountCard component
 * Displays account information with an optional edit action
 */
export const AccountCard: React.FC<AccountCardProps> = ({ account, onEdit }) => {
  return (
    <div className="p-4 border rounded-lg shadow-sm hover:shadow-md transition-shadow bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800">
      <div className="flex justify-between items-start">
        <div>
          <div className="flex items-center gap-2">
            {account.icon && <span className="text-xl">{account.icon}</span>}
            <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {account.name}
            </h3>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 font-mono">
            {account.accountNumber}
          </p>
        </div>
        <span className="px-2 py-1 text-xs font-medium rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 capitalize">
          {account.accountType}
        </span>
      </div>

      {account.description && (
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{account.description}</p>
      )}

      {onEdit && (
        <button
          onClick={() => onEdit(account.id)}
          className="mt-4 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
        >
          Edit Account
        </button>
      )}
    </div>
  );
};
