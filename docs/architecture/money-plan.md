---
slug: mint-architecture-money-plan
name: Mint architecture, money plan
repo: .
status: active
last_verified: 2026-11-22
---

# Money plan: pay cycles, budgets, wealth and tax

Budgets run from one payday to the next, not by calendar month. Everything below is derived from the book on each request, with a few seeded rows, and none of it moves money. See ../ARCHITECTURE.md for the overall map.

## Income and pay cycles

- Every positive row that counts is one of four income kinds: `salary` (the pay that starts a cycle), `regular` (a recurring payer), `reimbursement` (a person paying the owner back, which nets off the spending category it pays back and is never income) and `other` (gifts, interest, cashback: shown, not income). <!-- src: lib/income.mjs:1-13, lib/income.mjs:19 -->
- Streams are rows in `income_sources`, matched by priority, editable, and seeded once from the book. With no salary-looking deposits and no streams yet, a pay stream is found from a steady payer, so a CSV-only book still gets cycles. <!-- src: lib/income.mjs:6-10, lib/income.mjs:324-361 -->
- A cycle runs from the day a salary deposit lands to the day before the next. The open cycle ends the day before the predicted payday (last pay plus the stream's cadence), stretches when pay is late, and is flagged late from two days past the prediction. Deposits within three days are one payday. <!-- src: lib/cycles.mjs:1-6, lib/cycles.mjs:11-12 -->
- Income by financial year (1 July to 30 June) is shown against the owner's ATO Notices of Assessment: net salary plus the PAYG the notice says was withheld, against its taxable income, with the gap shown and never smoothed. Nothing is seeded; every year starts empty until entered. <!-- src: lib/noa.mjs:1-8 -->

## Budgets and safe to spend

- Budgets are per expense category with a target per pay cycle; `monthly_target` stays as the roll-up (cycle times 26 over 12) for Reports. Spent is net of refunds and reimbursements, never below zero per category, leaves out transfers, and leaves out business spend unless asked. Rollover carries each past cycle's leftover. <!-- src: lib/budgets.mjs:1-8 -->
- Fixed budgets (bills, subscriptions) sit apart from flexible ones, which is what the pace alert and safe to spend look at. Starter budgets are generated from the last six complete cycles by default. <!-- src: lib/budgets.mjs:6-8, lib/budgets.mjs:273 -->
- The `Home loan` budget is made once from what is actually paid, scaled to the cycle, fixed with no rollover. A line the owner deletes stays gone. <!-- src: lib/loanbudget.mjs:1-6 -->
- Safe to spend until payday is expected cycle income, less the planned savings split, less fixed bills in the cycle, less flexible spend so far, shown per day over the days left. A cash check compares the spendable accounts with the bills still due before payday. <!-- src: lib/safe.mjs:1-10 -->
- The forecast steps the spendable balance day by day to the next payday and out to 30 days, from pay, bills, the pay split and a trailing eight week baseline of variable spend. It guesses no card statement date. <!-- src: lib/forecast.mjs:1-18 -->

## Pay split, goals and debt

- A pay split says where each salary should go, as a fixed amount or a percentage per account. Mint never moves money: after each payday it checks the transfers out of the pay account against the plan (done, partial, not yet). The first plan is suggested from what moved out in the three days after each of the last four paydays. <!-- src: lib/plan.mjs:1-7 -->
- Goals measure progress by a linked account's balance, or by manual contributions when none is linked. A dated goal says what each cycle needs and whether the split covers it. <!-- src: lib/goals.mjs:1-4 -->
- Debt and offset: home loan balance, rate, repayment, offset, interest per cycle and year with and without the offset, payoff at the current repayment and the effect of an extra amount. Cards have a limit, a paydown to clear by a date and a payoff at an amount. Rates come only from Redbark's product details; a card without a purchase rate reads "rate unknown". <!-- src: lib/debt.mjs:1-6 -->
- The home loan view is built only from what Mint holds. A missing detail is listed in `missing` and left out of the maths; the owner can enter it (`loan_inputs`) but the bank's value always wins. The maths is in `lib/loanmath.mjs`. <!-- src: lib/homeloan.mjs:1-7 -->
- The bills calendar lists six weeks of expected bills and subscriptions plus loan instalments, marked inside or outside the cycle and paid or still to come. <!-- src: lib/bills.mjs:1-5 -->

## Wealth

- Net worth is every visible account balance (cash positive, card and loan negative), plus the latest manual snapshot of each asset Redbark cannot see, less manual liabilities. History is carried forward from the daily balance snapshots. <!-- src: lib/networth.mjs:1-6 -->
- Holdings are shares and ETFs entered by hand: a ticker with units and an average cost, or purchase lots. Prices come from the quote cache or a manual override, and `holdings.mjs` never goes to the network. Units and unit prices are dollars; everything Mint adds up is whole AUD cents. <!-- src: lib/holdings.mjs:1-11 -->
- Quotes: a source is polled per held ticker, answers cached with a fetch time; a failed fetch keeps the last price and records the error beside it. A ticker is fetched at most every 15 minutes while its market is open, inside a daily call budget. Exchange hours follow the exchange's own zone. <!-- src: lib/quotes.mjs:1-5, lib/quotes.mjs:18-24, lib/dates.mjs:12-13, lib/market.mjs:1-4 -->
- Super is a manual asset with value snapshots, and a nudge once the last value is over 35 days old. <!-- src: lib/superfund.mjs:1-5 -->
- The Ledger ("owed") is a standalone two-sided record of money other people owe the owner and the reverse. Net worth, safe to spend, budgets and the forecast do not read it. Its tally maths is in `public/owed-math.js` so the page computes the same numbers offline. <!-- src: lib/owed.mjs:1-8 -->

## Tax

- Deductible spend is tagged with an ATO category (the individual return's D items, or a business expense label). Receipts are the owner's own uploads kept under `data/receipts`. The financial year is 1 July to 30 June, and there is no GST anywhere. <!-- src: lib/tax.mjs:1-5 -->
- The return estimate works from entered payslip figures or from detected pays, reversing the ATO withholding scale and projecting to 30 June. Interest, business net and tagged deductions come from the feed. Rate tables are per financial year in `lib/taxrates.mjs`, and cover a single resident individual only. It is an estimate, not advice. <!-- src: lib/taxestimate.mjs:1-10, lib/taxrates.mjs:1-12 -->
- The accountant pack is one zip: a summary page, the deductions and business CSVs, receipts grouped by ATO category, and a manifest of deductions with no receipt. It is written entry by entry with a small streaming zip writer. <!-- src: lib/pack.mjs:1-6, lib/zip.mjs:1-4 -->

## Unverified

- Whether the ATO rate tables for the current financial year are the latest published. `lib/taxrates.mjs` says each table was read off its cited ATO page on a stated date; that was not re-checked.
