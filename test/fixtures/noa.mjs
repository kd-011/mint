// Invented Notices of Assessment (cents) for tests. A real book starts with none: the
// owner adds each year from the Income screen. Nothing here is anyone's tax return.
import { setAssessment } from '../../lib/noa.mjs';

export const INVENTED_NOAS = [
  { fy: 2020, taxable_income: 0, tax_withheld_payg: 0, source_file: 'NoA 19-20.pdf' },
  { fy: 2021, taxable_income: 1500000, tax_withheld_payg: 120000, refund: 120000, capital_gains: 500, source_file: 'NoA 20-21.pdf' },
  { fy: 2022, taxable_income: 4200000, tax_withheld_payg: 1100000, assessed_tax: 380000, medicare: 84000, vet_repayment: 42000, refund: 600000, source_file: 'NoA 21-22.pdf' },
  { fy: 2023, taxable_income: 5000000, tax_withheld_payg: 1600000, assessed_tax: 800000, medicare: 100000, vet_repayment: 6000, refund: 750000, capital_gains: 900, source_file: 'NoA 22-23.pdf' },
  { fy: 2024, taxable_income: 5200000, tax_withheld_payg: 1900000, assessed_tax: 840000, medicare: 104000, refund: 950000, source_file: 'NoA 23-24.pdf' },
];

export function seedNoas(db) {
  for (const { fy, ...fields } of INVENTED_NOAS) setAssessment(db, fy, fields);
}
