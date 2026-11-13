/* mock-data.js — UI-phase placeholder content. Removed when hledger is wired in. */

export const SEED_FILES = {
  "finance.journal": `; finance.journal — demo data for the UI phase

account assets:bank
account assets:cash
account assets:upi
account expenses:food
account expenses:rent
account expenses:transport
account expenses:utilities
account income:freelance
account income:salary

2026-09-28 Freelance payment
    assets:bank                  ₹12000.00
    income:freelance

2026-10-01 Salary
    assets:bank                  ₹85000.00
    income:salary

2026-10-01 Rent
    expenses:rent                ₹18000.00
    assets:bank

2026-10-05 Mobile recharge
    expenses:utilities             ₹399.00
    assets:upi

2026-10-12 Coffee
    expenses:food                  ₹180.00
    assets:cash

2026-10-24 Metro card top-up
    expenses:transport             ₹500.00
    assets:upi

2026-10-26 Groceries
    expenses:food                 ₹1240.00
    assets:bank

2026-10-26 Electricity bill
    expenses:utilities            ₹2180.00
    assets:bank
`,
  "work.timeclock": `i 2026-10-20 09:00:00 acme:development
o 2026-10-20 12:30:00
i 2026-10-20 13:30:00 acme:development
o 2026-10-20 17:45:00
`,
};
