# Tax Counsel Question Pack

**Date:** 2026-08-16
**Context:** buwiz-books is building BIR withholding/VAT computation and export (compute + export + printable forms; the taxpayer remains the filer of record). Four questions below have two defensible readings each; we need a written position before the affected stage ships. Two document requests follow.

Each item: the conflict → citations → what turns on it → our interim default → the question.

---

## Q1 — WI710/WC710: 20% per the regulation, 15% per the BIR's own form

**Blocks:** Stage 3b (purchase-side EWT). **Reference:** DECISIONS U2.

**The conflict.** RR 11-2018 §2.57.2(S) prescribes **20%** creditable withholding on "interest income derived from any other debt instruments not within the coverage of deposit substitutes." It has never been amended on this point. BIR Form 1601-EQ (January 2019 ENCS) prints **15%** for ATC WI710/WC710, and the eBIRForms package enforces 15%. We found no RR or RMC effecting a reduction.

**What turns on it.** Any client paying interest on private loan notes or shareholder loans — common in SMB financing. Withholding 15% when 20% is due leaves the client (as withholding agent) liable for the 5% deficiency plus surcharge; withholding 20% means eBIRForms rejects the entry or the QAP disagrees with the remittance.

**Interim default.** Follow the form (15%), because eBIRForms will not accept otherwise, and flag the position in the client-facing computation notes.

**Question.** Is 15% defensible as the operative rate on the strength of the BIR's own form and package, or should clients withhold 20% and reconcile the package mismatch some other way? Is there an issuance we missed?

---

## Q2 — Input VAT on services: creditable at billing or at payment?

**Blocks:** Stage 3b (bill posting). **Reference:** DECISIONS U4, plan blocker B10.

**The conflict.** RR 13-2018 §4.110-3(c): input tax on purchases of services is creditable "**upon payment** of the compensation, rental, royalty or fee." The EOPT Act (RA 11976) and RR 3-2024 moved the _seller's_ output VAT on services to accrual, and the April 2024 2550Q added item 55 "Input VAT on Unpaid Payables" as a deduction — which implies the buyer books input VAT on billing and backs it out for unpaid payables. No issuance squarely repeals the §4.110-3(c) "upon payment" rule for buyers.

**What turns on it.** Whether a VAT-registered client claims input VAT on a service bill in the quarter it is billed or the quarter it is paid. A bill dated 20 March, paid 15 April: claiming at billing puts ₱12,000 into Q1's input tax; if "upon payment" governs, that is a premature claim — a deficiency assessment with 25% surcharge and interest.

**Interim default (conservative).** Recognition basis = **payment** for service purchases, configurable per tax code (`vat_input_recognition_basis ∈ {billing, payment}`), so a counsel ruling flips a flag rather than a rewrite.

**Question.** Post-EOPT, may a buyer claim input VAT on services at billing (carrying the item-55 reversal machinery), or does §4.110-3(c) still govern? Please give the position in writing; the 2550Q's own structure argues both ways.

---

## Q3 — The ₱90,000 ceiling: accrual or actual receipt?

**Blocks:** Stage 5a (the January slice — the YTD accumulator). **Reference:** DECISIONS U10.

**The conflict.** RR 11-2018 §2.78.1(B)(11) covers 13th month pay and other benefits "paid or **accrued** during the year," while the same subsection describes "other benefits … **actually received**."

**What turns on it.** Only benefits declared in December and paid in January — but that is exactly the 13th-month-pay timing pattern for many employers. The accumulator must test the ₱90,000 ceiling against one basis or the other, and 2316 boxes must match.

**Interim default.** Receipt basis (matches "actually received" and payroll practice), applied consistently across the accumulator and 2316.

**Question.** For an employer whose 13th month pay is declared in December Y but paid in January Y+1: which taxable year's ₱90,000 ceiling absorbs it?

---

## Q4 — RR 24-2025 ½% carve-out: scope edges

**Blocks:** nothing yet (Stage 3b seeds it as data). **Reference:** DECISIONS U9. Lower priority.

**The conflict.** RR 24-2025 sets ½% (ATCs WI/WC840/850/860) for a **top withholding agent's** payments to manufacturers and direct importers of vehicles/parts, medicines, and fuels "intended for wholesale." Two edges are unaddressed: (a) does the carve-out also displace the 1% rate when a **government** payor (§2.57.2(J)) buys from the same suppliers — on the text, no; and (b) is "intended for wholesale" tested at the seller's point of sale or by the buyer's downstream use (a TWA buying pharmaceuticals for its own clinic's consumption: ½% or 1%)?

**Interim default.** (a) Government payors stay at WI640/WC640 1%. (b) Seller-intent reading — the supplier's goods are wholesale-intended regardless of this buyer's use — flagged as unsettled.

**Question.** Confirm or correct both readings.

---

## Document requests

**~~D1 — RR 11-2018 Annexes~~ — WITHDRAWN 2026-08-17.** Both annexes were retrieved directly from the BIR CDN at `https://bir-cdn.bir.gov.ph/local/pdf/Annex%20D%20RR%2011-2018.pdf` and `.../Annex%20E%20RR%2011-2018.pdf`; all 48 sub-annual constants are verified and independently re-derived. No counsel time needed.

One observation worth passing on anyway, since a client or reviewer may hit it: **the official Annex E PDF prints its top daily bracket malformed** as `P 6,034.00.30` — a number with two decimal points, confirmed at glyph level as a single text run, so the defect is in BIR's published document rather than in our extraction. We seed `6,034.30`, which is what the annex's own bracket-chain construction yields and what secondary sources list. Flagging in case counsel wants BIR to correct the published table.

**D2 — RR 29-2025 publication evidence.** The regulation's effectivity is "15 days following publication"; we derive **6 January 2026** from the 22 December 2025 issuance date and professional commentary, but have not found the Official Gazette or BIR-website publication date itself. We need the date documented before it becomes a hard effective-date boundary in the de minimis reference data. _(Reference: DECISIONS U6.)_

---

_Prepared by buwiz-books engineering. These are questions for counsel, not positions; the interim defaults above are engineering placeholders chosen to be conservative and reversible._
