// Per-financial-year rate tables for the tax return estimate, in one place.
// Every figure was read off the ATO page cited beside it (checked 17/10/2026),
// not recalled. A year is keyed by the year it ends: 2026 is 2025-26. Money is
// in whole dollars as the ATO prints it; rates are in basis points (1600 is
// 16%) so the maths stays in integers. To add a year, add an entry here and
// the ATO page for each table; lib/taxcalc.mjs needs no change.
//
// What is deliberately not here: spouse and dependant thresholds, SAPTO, the
// family Medicare levy reduction, GST. The estimate is for a single resident
// individual (see the assumptions in lib/taxestimate.mjs).
const ATO = 'https://www.ato.gov.au';

export const TAX_YEARS = {
  2026: {
    label: '2025-26',
    // https://www.ato.gov.au/tax-rates-and-codes/tax-rates-australian-residents
    // "Resident tax rates 2025-26": nil to 18,200; 16c over 18,200; 4,288 plus 30c over 45,000;
    // 31,288 plus 37c over 135,000; 51,638 plus 45c over 190,000.
    income_tax: {
      source: `${ATO}/tax-rates-and-codes/tax-rates-australian-residents`,
      brackets: [
        { over: 0, base: 0, bp: 0 },
        { over: 18200, base: 0, bp: 1600 },
        { over: 45000, base: 4288, bp: 3000 },
        { over: 135000, base: 31288, bp: 3700 },
        { over: 190000, base: 51638, bp: 4500 },
      ],
    },
    // https://www.ato.gov.au/individuals-and-families/medicare-and-private-health-insurance/medicare-levy/medicare-levy-reduction/medicare-levy-reduction-for-low-income-earners
    // 2025-26 singles: nil to 28,011, shaded in at 10c over 28,011 until 2% takes over at 35,013 (the ATO's
    // worked example: 29,000 pays 98.90). The levy is 2% of taxable income.
    medicare: {
      source: `${ATO}/individuals-and-families/medicare-and-private-health-insurance/medicare-levy/medicare-levy-reduction/medicare-levy-reduction-for-low-income-earners`,
      lower: 28011, upper: 35013, bp: 200, phase_bp: 1000,
    },
    // https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/tax-offsets/low-income-tax-offset
    // 700 to 37,500; less 5c per $1 over 37,500 (325 at 45,000); less 1.5c per $1 over 45,000; gone at 66,667.
    lito: {
      source: `${ATO}/individuals-and-families/income-deductions-offsets-and-records/tax-offsets/low-income-tax-offset`,
      max: 700, first: 37500, second: 45000, end: 66667, mid: 325, first_bp: 500, second_bp: 150,
    },
    // https://www.ato.gov.au/individuals-and-families/medicare-and-private-health-insurance/medicare-levy-surcharge/medicare-levy-surcharge-income-thresholds-and-rates
    // 2025-26 singles: 101,000 or less 0%; to 118,000 1%; to 158,000 1.25%; above 1.5%. Of the whole income for MLS purposes.
    mls: {
      source: `${ATO}/individuals-and-families/medicare-and-private-health-insurance/medicare-levy-surcharge/medicare-levy-surcharge-income-thresholds-and-rates`,
      tiers: [{ upTo: 101000, bp: 0 }, { upTo: 118000, bp: 100 }, { upTo: 158000, bp: 125 }, { upTo: Infinity, bp: 150 }],
    },
    // https://www.ato.gov.au/tax-rates-and-codes/study-and-training-support-loans-rates-and-repayment-thresholds
    // Table 2, 2025-26 (marginal from this year): nil to 67,000; 15c over 67,000; 8,700 plus 17c over 125,000; 10% of the lot from 179,286.
    help: {
      source: `${ATO}/tax-rates-and-codes/study-and-training-support-loans-rates-and-repayment-thresholds`,
      bands: [{ over: 0, base: 0, bp: 0 }, { over: 67000, base: 0, bp: 1500 }, { over: 125000, base: 8700, bp: 1700 }],
      whole_over: 179285, whole_bp: 1000,
    },
    // PAYG withholding, Schedule 1 scale 2 (tax-free threshold claimed), weekly coefficients, y = a x - b, x = weekly
    // earnings in whole dollars plus 0.99. Rows are [weekly earnings less than, a, b]. These apply from 1 July 2024
    // to 30 June 2026. Scale 2 already includes the Medicare levy, shaded in from 500 to 625 a week.
    // https://www.ato.gov.au/tax-rates-and-codes/schedule-1-tax-table-01-july-2024-to-30-june-2026/coefficients-to-use-in-formulas-for-withholding-from-weekly-payments
    withholding: {
      source: `${ATO}/tax-rates-and-codes/schedule-1-tax-table-01-july-2024-to-30-june-2026/coefficients-to-use-in-formulas-for-withholding-from-weekly-payments`,
      scale2: [
        [361, 0, 0], [500, 0.16, 57.8462], [625, 0.26, 107.8462], [721, 0.18, 57.8462], [865, 0.189, 64.3365],
        [1282, 0.3227, 180.0385], [2596, 0.32, 176.5769], [3653, 0.39, 358.3077], [Infinity, 0.47, 650.6154],
      ],
    },
  },

  2027: {
    label: '2026-27',
    // Same page, "Resident tax rates 2026-27": the 16% rate is now 15c over 18,200 (4,020 at 45,000).
    income_tax: {
      source: `${ATO}/tax-rates-and-codes/tax-rates-australian-residents`,
      brackets: [
        { over: 0, base: 0, bp: 0 },
        { over: 18200, base: 0, bp: 1500 },
        { over: 45000, base: 4020, bp: 3000 },
        { over: 135000, base: 31020, bp: 3700 },
        { over: 190000, base: 51370, bp: 4500 },
      ],
    },
    // The ATO page gives no separate 2026-27 low-income threshold yet (it is dated 30 June 2026 and states 2025-26).
    // The 2026-27 withholding instrument below still shades the levy in at 28,011 and 35,013, so those are used.
    // Revisit when the ATO publishes the 2026-27 figures.
    medicare: {
      source: `${ATO}/individuals-and-families/medicare-and-private-health-insurance/medicare-levy/medicare-levy-reduction/medicare-levy-reduction-for-low-income-earners`,
      lower: 28011, upper: 35013, bp: 200, phase_bp: 1000,
    },
    lito: {
      source: `${ATO}/individuals-and-families/income-deductions-offsets-and-records/tax-offsets/low-income-tax-offset`,
      max: 700, first: 37500, second: 45000, end: 66667, mid: 325, first_bp: 500, second_bp: 150,
    },
    // 2026-27 singles: 105,000 or less 0%; to 123,000 1%; to 164,000 1.25%; above 1.5%. (ATO example: 117,000 pays 1,170.)
    mls: {
      source: `${ATO}/individuals-and-families/medicare-and-private-health-insurance/medicare-levy-surcharge/medicare-levy-surcharge-income-thresholds-and-rates`,
      tiers: [{ upTo: 105000, bp: 0 }, { upTo: 123000, bp: 100 }, { upTo: 164000, bp: 125 }, { upTo: Infinity, bp: 150 }],
    },
    // Table 1, 2026-27: nil to 69,528; 15c over 69,528; 9,028 plus 17c over 129,717; 10% of the lot from 186,051.
    help: {
      source: `${ATO}/tax-rates-and-codes/study-and-training-support-loans-rates-and-repayment-thresholds`,
      bands: [{ over: 0, base: 0, bp: 0 }, { over: 69528, base: 0, bp: 1500 }, { over: 129717, base: 9028, bp: 1700 }],
      whole_over: 186050, whole_bp: 1000,
    },
    // Taxation Administration (Withholding Schedules) Instrument 2026 (F2026L00716), Schedule 1, Scale 2, in force
    // from 1 July 2026. Medicare is shaded in from 538 to 673 a week.
    // https://www.ato.gov.au/law/view/pdf/ldt/li2026-018.pdf
    withholding: {
      source: `${ATO}/law/view/pdf/ldt/li2026-018.pdf`,
      scale2: [
        [362, 0, 0], [538, 0.15, 54.3462], [673, 0.25, 108.2135], [721, 0.17, 54.3473], [865, 0.179, 60.8377],
        [1282, 0.3227, 185.1935], [2596, 0.32, 181.7319], [3653, 0.39, 363.4627], [Infinity, 0.47, 655.7704],
      ],
    },
  },
};

export const SUPPORTED_YEARS = Object.keys(TAX_YEARS).map(Number);
