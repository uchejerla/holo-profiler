#!/usr/bin/env python3
"""Synthetic 250-column P&C claims file for testing wide-file views. Made-up data, problems planted on purpose.
Run: python3 gen_wide.py  ->  wide_claims_250.csv (4,000 rows, deterministic)."""
import csv, os, random, datetime as dt

random.seed(250)
N = 4000
STATES = ['TX', 'CA', 'FL', 'NY', 'IL', 'PA', 'OH', 'GA', 'NC', 'MI', 'NJ', 'VA', 'WA', 'AZ', 'MA']
LOB = ['AUTO', 'HOME', 'GL', 'WC', 'PROP', 'UMB']
CAUSE = ['COLL', 'HAIL', 'WIND', 'FIRE', 'THEFT', 'WATER', 'SLIP', 'VAND', 'GLASS', 'INJ']
STATUS = ['Open', 'Closed', 'Reopened', 'Pending', 'Settled']
COV = ['bi', 'pd', 'med', 'coll', 'comp', 'um', 'uim', 'pip', 'rental', 'tow']
CITIES = ['Dallas', 'Austin', 'Houston', 'Miami', 'Tampa', 'Chicago', 'Albany', 'Fresno', 'Atlanta', 'Phoenix']
WORDS = 'insured reported damage to rear bumper after collision at intersection water leak in kitchen roof shingles missing hail storm vehicle towed to shop'.split()

cols = []  # (name, fn(row_index, ctx) -> str)
def add(name, fn): cols.append((name, fn))

def d(base, spread):
    return lambda r, c: (base + dt.timedelta(days=random.randint(0, spread))).isoformat()

# ---- IDs and keys (14)
add('claim_id', lambda r, c: f'CLM-{2024 + r % 2}-{100000 + r:06d}')
add('policy_number', lambda r, c: f'POL{7000000 + random.randint(0, 900000)}')
add('claimant_id', lambda r, c: str(500000 + r))
add('adjuster_id', lambda r, c: f'ADJ{random.randint(100, 180)}')
add('vehicle_vin', lambda r, c: ''.join(random.choice('ABCDEFGHJKLMNPRSTUVWXYZ0123456789') for _ in range(17)))
add('agent_code', lambda r, c: f'AG{random.randint(1000, 1400)}')
add('feature_id', lambda r, c: f'F{r:07d}' if r % 97 else f'F{r - 1:07d}')            # planted duplicates in a key
add('payment_ref', lambda r, c: '' if random.random() < 0.18 else f'PMT{random.randint(10**7, 10**8)}')
add('reinsurance_treaty_no', lambda r, c: f'RT{random.randint(10, 40)}')
add('subrogation_case_no', lambda r, c: '' if random.random() < 0.7 else f'SUB{random.randint(10000, 99999)}')
add('litigation_docket_no', lambda r, c: '' if random.random() < 0.85 else f'{random.randint(2019, 2025)}-CV-{random.randint(100, 9999)}')
add('repair_shop_id', lambda r, c: str(random.randint(3000, 3999)))
add('catastrophe_code', lambda r, c: random.choice(['', '', '', 'CAT24-07', 'CAT24-11', 'CAT25-02']))
add('source_system_key', lambda r, c: f'GW-{r:08d}')

# ---- Dates (22)
B = dt.date(2023, 1, 1)
add('loss_date', lambda r, c: c.setdefault('loss', (B + dt.timedelta(days=random.randint(0, 1000)))).isoformat())
add('report_date', lambda r, c: ((c['loss'] - dt.timedelta(days=3)) if r % 61 == 0 else (c['loss'] + dt.timedelta(days=random.randint(0, 30)))).isoformat())
add('open_date', lambda r, c: (c['loss'] + dt.timedelta(days=random.randint(1, 35))).isoformat())
add('close_date', lambda r, c: '' if random.random() < 0.4 else (c['loss'] + dt.timedelta(days=random.randint(40, 400))).isoformat())
add('reopen_date', lambda r, c: '' if random.random() < 0.92 else (c['loss'] + dt.timedelta(days=random.randint(400, 600))).isoformat())
add('policy_effective_date', d(dt.date(2022, 1, 1), 700))
add('policy_expiration_date', d(dt.date(2023, 1, 1), 900))
add('first_payment_date', lambda r, c: '' if random.random() < 0.3 else (c['loss'] + dt.timedelta(days=random.randint(10, 90))).strftime('%m/%d/%Y' if r % 4 == 0 else '%Y-%m-%d'))  # mixed formats
add('last_payment_date', d(dt.date(2023, 3, 1), 900))
add('inspection_date', d(dt.date(2023, 1, 5), 950))
add('appraisal_date', d(dt.date(2023, 1, 9), 950))
add('demand_letter_date', lambda r, c: '' if random.random() < 0.8 else d(dt.date(2023, 6, 1), 500)(r, c))
add('suit_filed_date', lambda r, c: '' if random.random() < 0.9 else d(dt.date(2023, 8, 1), 500)(r, c))
add('settlement_date', d(dt.date(2023, 4, 1), 900))
add('subrogation_recovery_date', lambda r, c: '' if random.random() < 0.88 else d(dt.date(2023, 9, 1), 500)(r, c))
add('claimant_birth_date', lambda r, c: (dt.date(2031, 5, 1).isoformat() if r % 150 == 0 else d(dt.date(1950, 1, 1), 18000)(r, c)))  # planted future births
add('driver_license_issue_date', d(dt.date(1990, 1, 1), 11000))
add('vehicle_purchase_date', d(dt.date(2010, 1, 1), 5000))
add('rental_start_date', d(dt.date(2023, 1, 3), 950))
add('rental_end_date', d(dt.date(2023, 1, 10), 950))
add('reserve_change_date', d(dt.date(2023, 2, 1), 900))
add('record_updated_at', lambda r, c: (dt.datetime(2025, 1, 1) + dt.timedelta(minutes=random.randint(0, 500000))).strftime('%Y-%m-%d %H:%M:%S'))

# ---- Amounts per coverage (70)
for cov in COV:
    def amt(scale, neg=0.0, blank=0.02, outlier=0.0):
        def f(r, c):
            x = random.random()
            if x < blank: return ''
            if x < blank + neg: return f'{-random.uniform(10, 900):.2f}'
            if random.random() < outlier: return f'{random.uniform(scale * 80, scale * 200):.2f}'
            return f'{random.lognormvariate(0, 0.9) * scale:.2f}'
        return f
    add(f'{cov}_paid_indemnity', amt(4000, neg=0.004 if cov == 'pd' else 0))
    add(f'{cov}_paid_expense', amt(600))
    add(f'{cov}_reserve_indemnity', amt(6000, outlier=0.003 if cov == 'bi' else 0))
    add(f'{cov}_reserve_expense', amt(900, blank=0.25 if cov in ('rental', 'tow') else 0.02))
    add(f'{cov}_recovery_amount', amt(300, blank=0.6))
    add(f'{cov}_deductible_amount', lambda r, c: random.choice(['250', '500', '1000', '2500']))
    add(f'{cov}_limit_amount', lambda r, c: random.choice(['25000', '50000', '100000', '300000', '500000']))

# ---- Counts and measures (24)
for name, lo, hi in [('vehicle_year', 1998, 2025), ('vehicle_mileage', 0, 240000), ('claimant_count', 1, 6), ('injury_count', 0, 4),
                     ('days_open', 0, 700), ('days_to_report', 0, 60), ('payment_count', 0, 30), ('reserve_change_count', 0, 15),
                     ('note_count', 0, 120), ('document_count', 0, 80), ('adjuster_touch_count', 0, 50), ('witness_count', 0, 5),
                     ('passenger_count', 0, 6), ('prior_claims_3yr', 0, 7), ('years_insured', 0, 40), ('driver_age', 16, 92),
                     ('building_age_years', 0, 110), ('square_footage', 600, 9000), ('roof_age_years', 0, 40), ('stories', 1, 4)]:
    add(name, (lambda lo, hi: lambda r, c: str(random.randint(lo, hi)))(lo, hi))
add('fraud_score', lambda r, c: f'{random.random():.3f}')
add('severity_index', lambda r, c: f'{random.uniform(0, 10):.2f}')
add('latitude', lambda r, c: f'{random.uniform(25, 47):.5f}')
add('longitude', lambda r, c: f'{random.uniform(-122, -71):.5f}')

# ---- Codes and categories (48)
add('loss_state', lambda r, c: random.choice(STATES) if r % 113 else 'Tx')        # case variant
add('risk_state', lambda r, c: random.choice(STATES))
add('line_of_business', lambda r, c: random.choice(LOB))
add('cause_of_loss_code', lambda r, c: random.choice(CAUSE))
add('claim_status', lambda r, c: random.choice(STATUS) if r % 71 else random.choice(['closed', 'OPEN ']))
add('claim_type', lambda r, c: random.choice(['First party', 'Third party']))
add('coverage_code', lambda r, c: random.choice(['BI', 'PD', 'MED', 'COLL', 'COMP']))
add('loss_location_type', lambda r, c: random.choice(['Road', 'Residence', 'Commercial', 'Parking lot']))
add('vehicle_make', lambda r, c: random.choice(['Ford', 'Toyota', 'Honda', 'Chevrolet', 'Tesla', 'Nissan']))
add('vehicle_body_type', lambda r, c: random.choice(['Sedan', 'SUV', 'Truck', 'Van']))
add('vehicle_color', lambda r, c: random.choice(['White', 'Black', 'Gray', 'Blue', 'Red', '']))
add('construction_type', lambda r, c: random.choice(['Frame', 'Masonry', 'Fire resistive']))
add('roof_type', lambda r, c: random.choice(['Shingle', 'Tile', 'Metal', 'Flat']))
add('occupancy_type', lambda r, c: random.choice(['Owner', 'Tenant', 'Vacant']))
add('channel', lambda r, c: random.choice(['Agent', 'Direct', 'Broker']))
add('report_method', lambda r, c: random.choice(['Phone', 'Web', 'App', 'Agent']))
add('injury_type', lambda r, c: random.choice(['', 'Soft tissue', 'Fracture', 'Laceration']))
add('body_part_code', lambda r, c: random.choice(['', 'HD', 'NK', 'BK', 'AR', 'LG']))
add('treatment_type', lambda r, c: random.choice(['', 'ER', 'Chiro', 'PT', 'Surgery']))
add('litigation_status', lambda r, c: random.choice(['None', 'None', 'None', 'Threatened', 'Filed']))
add('subrogation_status', lambda r, c: random.choice(['None', 'Open', 'Recovered', 'Closed']))
add('salvage_status', lambda r, c: random.choice(['None', 'Pending', 'Sold']))
add('fault_rating', lambda r, c: random.choice(['At fault', 'Not at fault', 'Shared', 'Unknown']))
add('police_report_status', lambda r, c: random.choice(['Filed', 'Not filed', 'Unknown']))
add('adjuster_unit', lambda r, c: random.choice(['FastTrack', 'Complex', 'SIU', 'Property', 'Casualty']))
add('adjuster_region', lambda r, c: random.choice(['South', 'West', 'Northeast', 'Midwest']))
add('currency_code', lambda r, c: 'USD' if r % 400 else 'usd')
add('payment_method', lambda r, c: random.choice(['Check', 'ACH', 'Card']))
add('payee_type', lambda r, c: random.choice(['Insured', 'Claimant', 'Vendor', 'Attorney']))
add('reserve_reason_code', lambda r, c: random.choice(['INIT', 'ADJ', 'SUPP', 'CLOSE']))
add('close_reason_code', lambda r, c: random.choice(['', 'PAID', 'DENIED', 'WD', 'DUP']))
add('denial_reason_code', lambda r, c: random.choice(['', '', '', 'EXCL', 'LAPSE', 'LATE']))
add('weather_condition', lambda r, c: random.choice(['Clear', 'Rain', 'Snow', 'Fog', 'Hail']))
add('road_condition', lambda r, c: random.choice(['Dry', 'Wet', 'Icy']))
add('policy_form', lambda r, c: random.choice(['HO-3', 'HO-5', 'PAP', 'CGL', 'BOP']))
add('policy_term', lambda r, c: random.choice(['6M', '12M']))
add('rating_tier', lambda r, c: random.choice(['A', 'B', 'C', 'D']))
add('territory_code', lambda r, c: f'T{random.randint(1, 40):02d}')
add('naics_code', lambda r, c: random.choice(['524126', '524210', '238160', '']))
add('product_code', lambda r, c: random.choice(['PA01', 'PA02', 'HO01', 'GL01']))
add('legacy_status_code', lambda r, c: '' if random.random() < 0.97 else random.choice(['A', 'X']))   # nearly empty
add('language_preference', lambda r, c: random.choice(['EN', 'EN', 'EN', 'ES']))
add('contact_preference', lambda r, c: random.choice(['Email', 'Phone', 'Text']))
add('gender_code', lambda r, c: random.choice(['M', 'F', 'U']))
add('marital_status', lambda r, c: random.choice(['S', 'M', 'D', 'W']))
add('occupation_class', lambda r, c: random.choice(['Office', 'Trade', 'Retired', 'Student']))
add('tow_company', lambda r, c: random.choice(['', 'AAA', 'Lone Star Tow', 'Metro Tow']))
add('rental_company', lambda r, c: random.choice(['', 'Enterprise', 'Hertz', 'Avis']))

# ---- Flags (24)
for f in ['is_total_loss', 'is_catastrophe', 'is_litigated', 'is_subrogation', 'is_salvage', 'is_fraud_referral', 'is_siu_referral',
          'is_reopened', 'is_fast_track', 'is_injury', 'is_fatality', 'is_commercial', 'is_rental', 'is_tow', 'is_glass_only',
          'is_weather_related', 'is_police_reported', 'is_attorney_rep', 'is_medicare_eligible', 'is_coverage_dispute',
          'is_reserve_adequate', 'is_large_loss', 'is_complex', 'is_test_record']:
    add(f, (lambda f: lambda r, c: ('Y' if random.random() < 0.2 else 'N') if f != 'is_fraud_referral' else random.choice(['Y', 'N', 'yes', 'no', '1', '0', 'maybe']))(f))

# ---- Contact (10)
add('claimant_email', lambda r, c: 'n/a' if r % 37 == 0 else ('john.smith@' if r % 53 == 0 else f'user{r}@example.com'))
add('claimant_phone', lambda r, c: f'({random.randint(200, 989)}) {random.randint(200, 999)}-{random.randint(1000, 9999)}' if r % 41 else '555-01')
add('insured_email', lambda r, c: f'ins{r}@example.org')
add('insured_phone', lambda r, c: f'{random.randint(200, 989)}-{random.randint(200, 999)}-{random.randint(1000, 9999)}')
add('adjuster_email', lambda r, c: f'adj{random.randint(100, 180)}@example.com')
add('adjuster_phone', lambda r, c: f'{random.randint(200, 989)}{random.randint(200, 999)}{random.randint(1000, 9999)}')
add('attorney_email', lambda r, c: '' if random.random() < 0.8 else f'law{random.randint(1, 90)}@example.net')
add('attorney_phone', lambda r, c: '' if random.random() < 0.8 else f'{random.randint(200, 989)}-555-{random.randint(1000, 9999)}')
add('repair_shop_phone', lambda r, c: f'{random.randint(200, 989)}-{random.randint(200, 999)}-{random.randint(1000, 9999)}')
add('portal_url', lambda r, c: f'https://claims.example.com/c/{r}')

# ---- Location (12)
add('loss_zip', lambda r, c: f'{random.randint(10000, 99999)}' if r % 89 else '7520')
add('risk_zip', lambda r, c: f'{random.randint(10000, 99999)}')
add('claimant_zip', lambda r, c: f'{random.randint(10000, 99999)}' if random.random() > 0.15 else '')
add('loss_city', lambda r, c: random.choice(CITIES))
add('risk_city', lambda r, c: random.choice(CITIES))
add('claimant_city', lambda r, c: random.choice(CITIES))
add('loss_county', lambda r, c: random.choice(['Dallas', 'Travis', 'Harris', 'Cook', 'Maricopa']))
add('risk_address_line1', lambda r, c: f'{random.randint(1, 9999)} {random.choice(["Main", "Oak", "Elm", "Pine"])} St')
add('risk_address_line2', lambda r, c: '' if random.random() < 0.9 else f'Apt {random.randint(1, 400)}')
add('claimant_address_line1', lambda r, c: f'{random.randint(1, 9999)} {random.choice(["Cedar", "Maple", "Lake"])} Ave')
add('claimant_state', lambda r, c: random.choice(STATES) if r % 131 else 'ZZ')
add('loss_country', lambda r, c: 'US')

# ---- Free text (fill to 250)
TEXT = ['loss_description', 'adjuster_notes', 'claimant_statement', 'witness_statement', 'damage_description', 'repair_estimate_notes',
        'siu_notes', 'denial_explanation', 'settlement_notes', 'subrogation_notes', 'litigation_notes', 'inspection_notes',
        'medical_notes', 'reserve_rationale', 'supervisor_comments', 'customer_feedback', 'internal_memo', 'claimant_name', 'insured_name',
        'adjuster_name', 'attorney_name', 'repair_shop_name', 'vehicle_model', 'driver_name', 'property_description']
for t in TEXT:
    if len(cols) >= 250: break
    blank = 0.6 if t in ('siu_notes', 'litigation_notes', 'denial_explanation') else 0.05
    add(t, (lambda blank: lambda r, c: '' if random.random() < blank else ' '.join(random.choice(WORDS) for _ in range(random.randint(3, 12))))(blank))
while len(cols) < 250:
    k = len(cols); add(f'ext_attr_{k:03d}', lambda r, c: random.choice(['', 'A1', 'B2', 'C3']))
cols = cols[:250]

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wide_claims_250.csv')
with open(out, 'w', newline='', encoding='utf-8') as fh:
    w = csv.writer(fh)
    w.writerow([n for n, _ in cols])
    for r in range(N):
        ctx = {}
        w.writerow([fn(r, ctx) for _, fn in cols])
print(out, len(cols), 'columns', N, 'rows', os.path.getsize(out), 'bytes')
