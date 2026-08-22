# `.DAT` Spike Wizard — the Stage 0.5 experiment

**What this resolves:** the last blocking unknown in the eBIRForms spec — how the BIR Alphalist Data Entry and Validation Module actually encodes its `.DAT` output. RMC 5-2014 says "CSV data file format" and stops there. Five facts are unknowable from the public record and all five are resolved by this one experiment:

1. Are **text fields wrapped in double quotes**? (`REGISTERED_NAME` and `NATURE_INCOME` are 50-char free text that can legitimately contain commas — Philippine corporate names like `ACME HOLDINGS, INC.` do)
2. **Line terminator** — CRLF (`0D 0A`) or LF (`0A`)?
3. **Character encoding** — what byte(s) does `Ñ` become, if the module accepts it at all?
4. **Empty optional fields** — adjacent commas (`,,`), or omitted?
5. **Numeric fields** — zero-padded to the spec's WIDTH column, or plain variable-length?

**Why it can't wait:** a wrong quoting rule doesn't fail loudly. It parses into _shifted fields_ — wrong amounts against wrong payees, loaded into the BIR data warehouse, invisible until an assessment. Everything else in the encoder is already specified; these five facts are isolated behind one configuration object, so your results are a one-line change.

**Time:** 30–60 minutes once you have a Windows machine. Any Windows 10/11 box or VM works. Use a throwaway VM if you can — the module is a legacy installer.

**Safety:** this is entirely offline. Do **not** email anything to `esubmission@bir.gov.ph`. The dummy TIN below is deliberately invalid for real filing.

---

## Step 1 — Download the module

1. Go to `https://www.bir.gov.ph/downloadables` (the site is a JavaScript app — let it load).
2. Find **"Alphalist Data Entry and Validation Module"** — Version **7.4** as of the last check (RMC 15-2025). If a newer version is posted, take the newest.
3. Download and note:

> **📝 RECORD (R1):** exact module version: `______` · download URL: `______` · file name of the installer: `______`

## Step 2 — Install

1. Run the installer with defaults. Note the install directory (historically something like `C:\Alphalist\` or similar).
2. Launch the module.

> **📝 RECORD (R2):** install directory: `______`

## Step 3 — Create the dummy employer/withholding agent

Fill the taxpayer profile with:

| Field           | Value                              |
| --------------- | ---------------------------------- |
| TIN             | `123-456-789`                      |
| Branch code     | `0000`                             |
| Registered name | `TEST SPIKE CORP`                  |
| RDO code        | `050` (or any the dropdown offers) |
| Address         | anything                           |

If the module refuses the TIN format, record what it demands (9-digit? 4-digit branch? 5-digit?).

> **📝 RECORD (R3):** branch code field length the module accepts: `______` (this checks the 4-vs-5-digit divergence flagged in DECISIONS A5)

## Step 4 — Key the QAP test payees (Form 1601-EQ)

Open the **1601-EQ → Quarterly Alphalist of Payees (QAP)** data entry. Period: any quarter of the current year. Add **three** payees exactly as written:

**Payee A — the comma probe (corporate):**

| Field            | Value                                         |
| ---------------- | --------------------------------------------- |
| TIN              | `111-111-111-0000`                            |
| Registered name  | `ACME HOLDINGS, INC.` ← the comma is the test |
| ATC              | `WC010`                                       |
| Nature of income | `PROFESSIONAL FEES`                           |
| Income payment   | `10000.00`                                    |
| Tax rate         | `10`                                          |
| Tax withheld     | `1000.00`                                     |

**Payee B — the Ñ probe (individual):**

| Field                      | Value                                           |
| -------------------------- | ----------------------------------------------- |
| TIN                        | `222-222-222-0000`                              |
| Last / First / Middle name | `PEÑA` / `MARIA` / `SANTOS` ← the Ñ is the test |
| ATC                        | `WI010`                                         |
| Nature of income           | `PROFESSIONAL FEES`                             |
| Income payment             | `20000.00`                                      |
| Tax rate                   | `5`                                             |
| Tax withheld               | `1000.00`                                       |

**Payee C — the empty-field probe (individual):**

| Field                      | Value                                         |
| -------------------------- | --------------------------------------------- |
| TIN                        | `333-333-333-0000`                            |
| Last / First / Middle name | `CRUZ` / `JUAN` / **leave middle name empty** |
| ATC                        | `WI120`                                       |
| Nature of income           | `CONTRACTOR`                                  |
| Income payment             | `5000.00`                                     |
| Tax rate                   | `2`                                           |
| Tax withheld               | `100.00`                                      |

> **📝 RECORD (R4):** If the module **rejects the comma or the Ñ at data entry** — record the exact error text verbatim. A refusal IS a result: it means our encoder must transliterate/strip **before** the file is built, and the quoting question becomes moot for that field.

## Step 5 — Generate the `.DAT`

Save / generate the file. Find the output — the module writes into a subfolder of its install directory (look for `eAlpha` or similar; search `*.dat` under the install dir if unsure).

> **📝 RECORD (R5):** full path: `______` · exact filename: `______`
> (The filename is itself a finding — RMC 25-2024 Annex B prescribes `<TIN9><BRANCH4><MMYYYY><FORMTYPE>.DAT`; confirm or refute.)

## Step 6 — Hex-dump it

Open **PowerShell** and run (adjust the path):

```powershell
Format-Hex -Path "C:\<path-to>\1234567890000*.dat" | Select-Object -First 60
```

Alternative if `Format-Hex` is unavailable:

```cmd
certutil -encodehex "C:\<path-to>\<file>.dat" "%USERPROFILE%\Desktop\dump.hex"
notepad %USERPROFILE%\Desktop\dump.hex
```

Also open the file directly in Notepad — the readable view plus the hex view together answer everything.

## Step 7 — Fill the results form

| #   | Question                                                                                                                                                  | Answer     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| F1  | Are text fields wrapped in double quotes (`"ACME HOLDINGS, INC."`)?                                                                                       | ☐ yes ☐ no |
| F2  | Did the comma inside `ACME HOLDINGS, INC.` survive into the file, get stripped, or was it rejected at entry?                                              | **\_\_**   |
| F3  | Line terminator — look at the bytes at each line end: `0D 0A` (CRLF) or `0A` (LF)?                                                                        | **\_\_**   |
| F4  | The `Ñ` in `PEÑA` — accepted at entry? If yes, what byte(s) in the hex dump? (`D1` = Windows-1252 · `C3 91` = UTF-8 · `4E` = transliterated to plain `N`) | **\_\_**   |
| F5  | Payee C's empty middle name — adjacent commas (`,,`), an empty quoted string (`""`), or field omitted?                                                    | **\_\_**   |
| F6  | Numerics — is `10000.00` written plain, or padded/aligned to a fixed width? Always 2 decimals?                                                            | **\_\_**   |
| F7  | Paste the **first line** of the file (the header/control record) verbatim                                                                                 | **\_\_**   |
| F8  | Paste **one full detail line** (payee A's row) verbatim                                                                                                   | **\_\_**   |
| F9  | Run the module's own **Validate** on the file — pass or fail, and the message                                                                             | **\_\_**   |

## Step 8 — Send it back

Return to me: the filled form above, **the raw `.DAT` file(s)**, and (optional but helpful) a screenshot of the hex view. From F1–F8 I derive the complete encoder configuration:

```ts
{
  quoteTextFields: boolean,
  lineTerminator: "CRLF" | "LF",
  encoding: "cp1252" | "ascii" | "utf8",
  emptyField: "adjacent-commas" | "empty-quoted" | "omitted",
  padNumerics: boolean,
}
```

**Optional (recommended, +15 min):** repeat Steps 4–7 in the **1604-C** schedule with one employee (`PEÑA, MARIA`, any compensation figures). 1604-C is our first shipping artifact (the January alphalist), and confirming the same mechanics hold across the file family closes the question completely.
