"""
Single source of truth for the Stage 1 synthetic procurement world.

Everything (buyer files, vendor documents, ground truth) is derived from the
structures in this module so the dataset stays internally consistent.
Deterministic: no wall-clock or unseeded randomness.
"""
import datetime as dt
import hashlib

# ---------------------------------------------------------------------------
# Event / buyer
# ---------------------------------------------------------------------------
BUYER = {
    "name": "Sahyadri Consumer Products Pvt. Ltd.",
    "short_name": "SCPL",
    "industry": "FMCG – foods, beverages, home & personal care",
    "hq": "Baner, Pune, Maharashtra 411045",
    "gstin": "27AAKCS4471M1ZQ",
    "contact": {"name": "Meera Raghunathan", "title": "Category Manager – Packaging Materials",
                "email": "meera.raghunathan@sahyadricp.example", "phone": "+91 20 6712 4400"},
}

EVENT = {
    "rfx_id": "SCPL/PKG/RFQ/2026-27/014",
    "title": "Annual Rate Contract – Corrugated Packaging (FY 2026-27 H2 to FY 2027-28 H1)",
    "category": "Corrugated packaging (HSN 4819 10 / 4808 10)",
    "issue_date": "2026-09-21",
    "clarification_deadline": "2026-09-30",
    "response_due_date": "2026-10-12",
    "contract_period": {"start": "2026-11-01", "end": "2027-10-31", "months": 12},
    "currency_of_evaluation": "INR",
    "evaluation_fx": {"USD_INR": 88.50, "basis": "Fixed evaluation rate set in RFx (SCPL treasury rate on issue date). Applied to any non-INR quote for comparison only."},
    "normalization_basis": "INR per piece (or per set for partitions), ex-GST, delivered to the specified SCPL plant (FOR destination)",
    "freight_loading_pct": 5.0,
}

PLANTS = {
    "BLR": {"code": "BLR", "name": "Bengaluru Plant", "address": "Plot 41-B, KIADB Hoskote Industrial Area, Bengaluru Rural, Karnataka 562114", "state": "Karnataka"},
    "PNQ": {"code": "PNQ", "name": "Pune Plant", "address": "Gat No. 318, Chakan MIDC Phase II, Pune, Maharashtra 410501", "state": "Maharashtra"},
    "HYD": {"code": "HYD", "name": "Hyderabad Plant", "address": "Plot 22, IDA Patancheru, Sangareddy, Telangana 502319", "state": "Telangana"},
}

# ---------------------------------------------------------------------------
# Board constructions: papers = list of (gsm, BF, flute or None)
# Flute take-up factors: B 1.36, C 1.45, E 1.27
# ---------------------------------------------------------------------------
TAKEUP = {"B": 1.36, "C": 1.45, "E": 1.27}
CONSTRUCTIONS = {
    "C3B18":  {"ply": 3, "flute": "B",   "papers": [(150, 18, None), (120, 16, "B"), (150, 18, None)]},
    "C3BL":   {"ply": 3, "flute": "B",   "papers": [(120, 16, None), (100, 14, "B"), (120, 16, None)]},
    "C3E":    {"ply": 3, "flute": "E",   "papers": [(180, 20, None), (120, 16, "E"), (150, 18, None)]},
    "C3EL":   {"ply": 3, "flute": "E",   "papers": [(300, None, None), (120, 16, "E"), (150, 18, None)]},  # 300 gsm duplex litho top
    "C5BC20": {"ply": 5, "flute": "BC",  "papers": [(150, 20, None), (120, 16, "B"), (120, 18, None), (120, 16, "C"), (150, 20, None)]},
    "C5BC22": {"ply": 5, "flute": "BC",  "papers": [(180, 22, None), (140, 18, "B"), (140, 20, None), (140, 18, "C"), (180, 22, None)]},
    "C5BC24": {"ply": 5, "flute": "BC",  "papers": [(200, 24, None), (150, 20, "B"), (150, 22, None), (150, 20, "C"), (200, 24, None)]},
    "C7BCB22": {"ply": 7, "flute": "BCB", "papers": [(180, 22, None), (140, 18, "B"), (140, 20, None), (140, 18, "C"), (140, 20, None), (140, 18, "B"), (180, 22, None)]},
    "C7BCB26": {"ply": 7, "flute": "BCB", "papers": [(230, 26, None), (150, 20, "B"), (180, 24, None), (150, 20, "C"), (180, 24, None), (150, 20, "B"), (230, 26, None)]},
    "C7BCB26H": {"ply": 7, "flute": "BCB", "papers": [(250, 26, None), (180, 22, "B"), (200, 24, None), (180, 22, "C"), (200, 24, None), (180, 22, "B"), (250, 26, None)]},
}


def board_gsm(c):
    return round(sum(g * (TAKEUP[f] if f else 1.0) for g, _, f in CONSTRUCTIONS[c]["papers"]), 1)


def board_bs(c):
    """Approximate bursting strength (kg/cm2): liners full, flutes at 50%."""
    bs = 0.0
    for g, bf, f in CONSTRUCTIONS[c]["papers"]:
        if bf is None:  # duplex top
            bf = 10
        bs += (bf * g / 1000.0) * (0.5 if f else 1.0)
    return round(bs, 1)


def board_spec_text(c):
    parts = []
    for g, bf, f in CONSTRUCTIONS[c]["papers"]:
        if bf is None:
            parts.append(f"{g} duplex")
        else:
            parts.append(f"{g}{'(' + f + ')' if f else ''}/BF{bf}")
    return " – ".join(parts)


# Historical reference rate per kg (FY25-26 weighted average, delivered, ex-GST) by price category
HIST_RATE_PER_KG = {
    "P3": 46.0, "PR3": 52.0, "P5": 48.0, "PR5": 54.0, "MR5": 60.0, "HD5": 51.0,
    "DCL": 105.0, "DCF": 64.0, "DC5": 57.0, "PT": 44.0, "PAD": 42.0, "SLV": 52.0,
    "P7": 52.0, "EX5": 60.0, "EX7": 64.0, "EX7H": 66.0,
}

# ---------------------------------------------------------------------------
# 30 RFx lines
# blank = (length_mm, width_mm) of flat blank area used for weight (per piece / per set)
# ---------------------------------------------------------------------------
def _rsc(L, W, H):
    return (2 * L + 2 * W + 35, W + H)


def _hsc(L, W, H):
    return (2 * L + 2 * W + 35, H + W / 2)


RAW_LINES = [
    # id, item, style, dims, constr, print, coating, plant, qty, cat, end_use, blank, unit
    ("CP-001", "3-Ply RSC Shipper – Plain Brown", "RSC", (300, 200, 150), "C3B18", "Plain", None, "BLR", 480000, "P3", "Biscuit shipper 24 x 75 g", None, "piece"),
    ("CP-002", "3-Ply RSC Shipper – Plain Brown", "RSC", (350, 250, 200), "C3B18", "Plain", None, "PNQ", 360000, "P3", "Namkeen shipper 30 x 40 g", None, "piece"),
    ("CP-003", "3-Ply RSC Shipper – Plain Brown", "RSC", (400, 300, 200), "C3B18", "Plain", None, "HYD", 240000, "P3", "Instant noodles shipper 48 x 70 g", None, "piece"),
    ("CP-004", "3-Ply RSC Shipper – 1 Colour Printed", "RSC", (300, 200, 150), "C3B18", "1C flexo", None, "PNQ", 600000, "PR3", "Biscuit shipper 24 x 75 g (Pune)", None, "piece"),
    ("CP-005", "3-Ply RSC Shipper – 2 Colour Printed", "RSC", (250, 180, 120), "C3B18", "2C flexo", None, "BLR", 720000, "PR3", "Tea carton shipper 12 x 250 g", None, "piece"),
    ("CP-006", "3-Ply RSC Shipper – 2 Colour Printed", "RSC", (320, 240, 180), "C3B18", "2C flexo", None, "HYD", 300000, "PR3", "Spice pouch shipper", None, "piece"),
    ("CP-007", "5-Ply RSC Shipper – Plain Brown", "RSC", (450, 350, 300), "C5BC20", "Plain", None, "BLR", 210000, "P5", "Detergent 1 kg x 12 shipper", None, "piece"),
    ("CP-008", "5-Ply RSC Shipper – Plain Brown", "RSC", (500, 400, 300), "C5BC20", "Plain", None, "PNQ", 150000, "P5", "Detergent 2 kg x 6 shipper", None, "piece"),
    ("CP-009", "5-Ply RSC Shipper – Plain Brown", "RSC", (400, 300, 300), "C5BC20", "Plain", None, "HYD", 270000, "P5", "Glass jar (ketchup) shipper, used with CP-022", None, "piece"),
    ("CP-010", "5-Ply RSC Shipper – 2 Colour Printed", "RSC", (450, 300, 250), "C5BC20", "2C flexo", None, "BLR", 240000, "PR5", "Shampoo bottle shipper", None, "piece"),
    ("CP-011", "5-Ply RSC Shipper – 3 Colour Printed", "RSC", (400, 300, 280), "C5BC20", "3C flexo", None, "PNQ", 180000, "PR5", "Health drink jar shipper", None, "piece"),
    ("CP-012", "5-Ply RSC – 2 Colour Printed, Moisture Resistant", "RSC", (420, 320, 260), "C5BC20", "2C flexo", "Aqueous water-resistant coating on outer liner, Cobb(30 min) <= 40 g/m2", "HYD", 120000, "MR5", "Edible oil pouch shipper (humid / cold storage)", None, "piece"),
    ("CP-013", "5-Ply HSC Box – Plain Brown", "HSC", (600, 400, 350), "C5BC20", "Plain", None, "PNQ", 60000, "P5", "Bulk ingredient bag outer", None, "piece"),
    ("CP-014", "5-Ply RSC – Heavy Duty BF22, Plain", "RSC", (450, 350, 250), "C5BC22", "Plain", None, "BLR", 100000, "HD5", "Glass jar (jam) shipper", None, "piece"),
    ("CP-015", "Die-cut Crash-lock Gift Carton – 4C Offset, Litho-laminated", "Die-cut crash-lock", (220, 150, 90), "C3EL", "4C offset litho + gloss lamination", None, "BLR", 400000, "DCL", "Festive gift pack", (790, 300), "piece"),
    ("CP-016", "Die-cut Tray with Lid – 2C Flexo", "Die-cut tray + lid", (300, 200, 80), "C3E", "2C flexo", None, "HYD", 250000, "DCF", "Confectionery tray", (980, 400), "piece"),
    ("CP-017", "Shelf-ready Display Tray with Tear-off Front – 2C Flexo", "Die-cut SRP tray", (380, 250, 120), "C3B18", "2C flexo", None, "HYD", 160000, "DCF", "Shelf-ready pack, modern trade", (660, 530), "piece"),
    ("CP-018", "E-commerce Mailer Box – Die-cut, 2C Flexo", "Die-cut mailer", (250, 200, 80), "C3E", "2C flexo", None, "PNQ", 300000, "DCF", "D2C e-commerce mailer", (620, 520), "piece"),
    ("CP-019", "5-Ply RSC with Die-cut Hand Holes – 2C Printed", "RSC + die-cut hand holes", (400, 300, 350), "C5BC20", "2C flexo", None, "BLR", 90000, "DC5", "Family-pack shipper", None, "piece"),
    ("CP-020", "3-Ply Partition – 12 Cell (3 x 4), for CP-007", "Partition set", (440, 340, 290), "C3BL", "Plain", None, "BLR", 210000, "PT", "Bottle separation in CP-007", (1900, 290), "set"),
    ("CP-021", "3-Ply Partition – 24 Cell (4 x 6)", "Partition set", (490, 390, 200), "C3BL", "Plain", None, "PNQ", 120000, "PT", "Small bottle separation", (3420, 200), "set"),
    ("CP-022", "5-Ply Partition – 6 Cell (2 x 3) Heavy, for CP-009", "Partition set", (390, 290, 280), "C5BC20", "Plain", None, "HYD", 80000, "PT", "Glass jar separation in CP-009", (970, 280), "set"),
    ("CP-023", "3-Ply Layer Pad 440 x 340 mm", "Layer pad", (440, 340, 0), "C3BL", "Plain", None, "BLR", 420000, "PAD", "Layer separator", (440, 340), "piece"),
    ("CP-024", "5-Ply Layer Pad 590 x 390 mm", "Layer pad", (590, 390, 0), "C5BC20", "Plain", None, "PNQ", 150000, "PAD", "Pallet / layer separator", (590, 390), "piece"),
    ("CP-025", "Die-cut Fitment Insert – 3-Ply E-flute, for CP-016", "Die-cut insert", (290, 190, 40), "C3E", "Plain", None, "HYD", 250000, "DCF", "Insert for confectionery tray", (420, 300), "piece"),
    ("CP-026", "3-Ply Printed Sleeve – 1C Flexo", "Sleeve", (300, 200, 100), "C3B18", "1C flexo", None, "PNQ", 200000, "SLV", "Promotional bundle sleeve", (830, 200), "piece"),
    ("CP-027", "7-Ply RSC – Plain, Heavy Duty BF22", "RSC", (600, 400, 400), "C7BCB22", "Plain", None, "PNQ", 40000, "P7", "Bulk inter-plant transfer", None, "piece"),
    ("CP-028", "5-Ply Export Carton – 2C, Shipping Marks, BF24", "RSC export", (450, 350, 300), "C5BC24", "2C flexo + shipping marks", None, "PNQ", 80000, "EX5", "Export shipper (Middle East)", None, "piece"),
    ("CP-029", "7-Ply Export Carton – Moisture Resistant, BF26", "RSC export", (600, 400, 450), "C7BCB26", "1C flexo shipping marks", "Water-resistant coating both liners, Cobb(30 min) <= 35 g/m2", "BLR", 30000, "EX7", "Export shipper (sea freight, SE Asia)", None, "piece"),
    ("CP-030", "7-Ply Heavy-duty Export Carton – Pallet Fit", "RSC export", (800, 600, 500), "C7BCB26H", "1C flexo shipping marks", None, "HYD", 15000, "EX7H", "Export bulk carton, 4 per pallet (1200 x 800)", None, "piece"),
]

LAST_YEAR_SUPPLIER = {}  # filled below


def _build_lines():
    lines = []
    for (lid, item, style, dims, cons, prt, coat, plant, qty, cat, use, blank, unit) in RAW_LINES:
        L, W, H = dims
        if blank is None:
            blank = _hsc(L, W, H) if style == "HSC" else _rsc(L, W, H)
        area = blank[0] * blank[1] / 1e6
        gsm = board_gsm(cons)
        weight_g = round(area * gsm)
        hist = round(weight_g / 1000 * HIST_RATE_PER_KG[cat], 2)
        lines.append({
            "line_id": lid,
            "item_description": item,
            "style": style,
            "length_mm": L, "width_mm": W, "height_mm": H if H else None,
            "dimensions_text": f"{L} x {W} x {H}" if H else f"{L} x {W}",
            "dimension_basis": "Internal dimensions (L x W x H), mm" if style.startswith("RSC") or style == "HSC" else "Finished size, mm",
            "ply": CONSTRUCTIONS[cons]["ply"],
            "flute": CONSTRUCTIONS[cons]["flute"],
            "construction_code": cons,
            "board_construction": board_spec_text(cons),
            "combined_board_gsm": gsm,
            "min_bursting_factor_outer_liner": CONSTRUCTIONS[cons]["papers"][0][1] or CONSTRUCTIONS[cons]["papers"][-1][1],
            "min_bursting_strength_kg_cm2": board_bs(cons),
            "recycled_content_min_pct": 50 if cat in ("EX5", "EX7", "EX7H", "DCL") else 70,
            "printing": prt,
            "coating": coat,
            "delivery_plant": plant,
            "annual_qty": qty,
            "uom": unit,
            "monthly_calloff_qty": round(qty / 12),
            "reference_weight_g": weight_g,
            "price_category": cat,
            "end_use": use,
            "historical_price_inr": hist,
        })
    return lines


LINES = _build_lines()
LINE_BY_ID = {l["line_id"]: l for l in LINES}

# Who supplied each line last year (for the historical file and V5's "same as last year")
for l in LINES:
    if l["line_id"] in ("CP-016", "CP-017", "CP-025"):
        LAST_YEAR_SUPPLIER[l["line_id"]] = "VND-1005"
    elif l["delivery_plant"] == "BLR" and l["price_category"] not in ("DCL", "EX7"):
        LAST_YEAR_SUPPLIER[l["line_id"]] = "VND-1001"
    elif l["line_id"] in ("CP-002", "CP-008", "CP-013", "CP-021"):
        LAST_YEAR_SUPPLIER[l["line_id"]] = "VND-1002"
    elif l["line_id"] in ("CP-015",):
        LAST_YEAR_SUPPLIER[l["line_id"]] = "Prism Litho Packs (not invited – exited category)"
    else:
        LAST_YEAR_SUPPLIER[l["line_id"]] = "Mahalaxmi Box Industries (not invited – quality issues FY26)"

# ---------------------------------------------------------------------------
# Vendors (master data)
# ---------------------------------------------------------------------------
VENDORS = [
    {
        "vendor_id": "VND-1001", "vendor_no": 1,
        "vendor_name": "Deccan Corrupack Industries Pvt. Ltd.",
        "location": "Peenya Industrial Area, Bengaluru, Karnataka",
        "plant_locations": ["Hoskote, Bengaluru Rural (KA)", "Hosur SIPCOT Phase I (TN)"],
        "annual_capacity_mt": 36000,
        "certifications": ["ISO 9001:2015", "ISO 14001:2015", "FSC Chain of Custody (FSC-C1xxxx)"],
        "historical_quality_score": 92, "historical_otd_pct": 94,
        "prior_relationship": "Incumbent for Bengaluru plant since 2019 (most BLR lines)",
        "risk_level": "Low",
        "primary_contact": {"name": "Ramesh Gowda", "title": "Head – Key Accounts", "email": "ramesh.gowda@deccancorrupack.example", "phone": "+91 98450 31277"},
        "category_specialization": "Plain & printed 3/5/7-ply RSC, flexo-printed die-cut; litho via partner",
        "gstin": "29AADCD8812K1Z4",
        "response_format": "Excel (.xlsx)",
    },
    {
        "vendor_id": "VND-1002", "vendor_no": 2,
        "vendor_name": "Shree Ganesh Packwell Pvt. Ltd.",
        "location": "Chakan, Pune, Maharashtra",
        "plant_locations": ["Chakan MIDC Phase I, Pune (MH)"],
        "annual_capacity_mt": 14000,
        "certifications": ["ISO 9001:2015", "FSC Chain of Custody"],
        "historical_quality_score": 86, "historical_otd_pct": 89,
        "prior_relationship": "Approved supplier for Pune plant since 2022 (selected PNQ lines)",
        "risk_level": "Medium",
        "risk_note": "Single plant; ~40% revenue from two customers",
        "primary_contact": {"name": "Sachin Kulkarni", "title": "Director – Sales", "email": "sachin.k@ganeshpackwell.example", "phone": "+91 98220 64519"},
        "category_specialization": "3/5/7-ply RSC, partitions & pads, up to 4C flexo",
        "gstin": "27AAHCS5530P1ZB",
        "response_format": "PDF quotation on letterhead",
    },
    {
        "vendor_id": "VND-1003", "vendor_no": 3,
        "vendor_name": "Indus Fibreboard Solutions Ltd.",
        "location": "Gachibowli, Hyderabad, Telangana",
        "plant_locations": ["Patancheru, Hyderabad (TS)", "Ranjangaon MIDC, Pune (MH)", "Hosur SIPCOT Phase II (TN)"],
        "annual_capacity_mt": 60000,
        "certifications": ["ISO 9001:2015", "ISO 14001:2015", "FSC Chain of Custody", "BRCGS Packaging Materials (Grade AA)"],
        "historical_quality_score": 95, "historical_otd_pct": 91,
        "historical_score_basis": "Sample/trial evaluation 2025 (no commercial supply history)",
        "prior_relationship": "New – no commercial supply; successful sample trial for gift packs in 2025",
        "risk_level": "Low",
        "primary_contact": {"name": "Ananya Reddy", "title": "Business Development Manager – FMCG", "email": "ananya.reddy@indusfibreboard.example", "phone": "+91 99490 22814"},
        "category_specialization": "Litho-laminated die-cut, shelf-ready packaging, export & moisture-resistant cartons",
        "gstin": "36AACCI7123F1ZM",
        "response_format": "Word (.docx) letter with tables",
    },
    {
        "vendor_id": "VND-1004", "vendor_no": 4,
        "vendor_name": "Sri Vaigai Corrugators",
        "location": "SIPCOT Industrial Complex, Hosur, Tamil Nadu",
        "plant_locations": ["SIPCOT Phase I, Hosur (TN)"],
        "annual_capacity_mt": 6500,
        "certifications": ["Udyam (MSME) registration"],
        "certification_note": "ISO 9001 applied; certification audit scheduled December 2026",
        "historical_quality_score": 78, "historical_otd_pct": None,
        "historical_score_basis": "Sample evaluation Aug 2026; no supply history",
        "prior_relationship": "None – new prospect introduced via plant purchase team (BLR)",
        "risk_level": "High",
        "risk_note": "Proprietorship, single corrugation line, limited financial disclosure",
        "primary_contact": {"name": "K. Murugan", "title": "Proprietor", "email": "srivaigaicorrugators@mail.example", "phone": "+91 94431 50762"},
        "category_specialization": "Plain & 2C flexo-printed 3/5-ply RSC, partitions; local Hosur/Bengaluru supply",
        "gstin": "33ABMPM6620Q1Z7",
        "response_format": "Printed rate card (photographed)",
    },
    {
        "vendor_id": "VND-1005", "vendor_no": 5,
        "vendor_name": "Godavari Packaging Works",
        "location": "Bollaram, Sangareddy District, Telangana",
        "plant_locations": ["Bollaram IDA (TS)", "Medchal converting unit (TS)"],
        "annual_capacity_mt": 9000,
        "certifications": ["ISO 9001:2015"],
        "historical_quality_score": 81, "historical_otd_pct": 84,
        "prior_relationship": "Supplier to Hyderabad plant since 2021 (die-cut trays CP-016, CP-017, insert CP-025)",
        "risk_level": "Medium",
        "risk_note": "Partnership firm; moderate dependence on SCPL",
        "primary_contact": {"name": "P. Srinivas Rao", "title": "Partner", "email": "srinivas@godavaripack.example", "phone": "+91 98490 77312"},
        "category_specialization": "Plain & 2C printed 3/5-ply, flexo die-cut trays, partitions",
        "gstin": "36AAKFG2291H1ZD",
        "response_format": "Plain-text email",
    },
]
VENDOR_BY_ID = {v["vendor_id"]: v for v in VENDORS}

# ---------------------------------------------------------------------------
# Technical questionnaire
# ---------------------------------------------------------------------------
QUESTIONS = [
    {"qid": "Q01", "topic": "ISO 9001", "question": "Is your manufacturing site(s) certified to ISO 9001:2015? Provide certificate number and validity.", "mandatory": True, "max_points": 10, "partial_points": 0,
     "full": "Valid ISO 9001:2015 certificate covering supplying plant(s)", "partial": "Not applicable – applied / in process scores 0 and fails mandatory"},
    {"qid": "Q02", "topic": "FSC certification", "question": "Do you hold FSC Chain-of-Custody certification?", "mandatory": False, "max_points": 6, "partial_points": 3,
     "full": "Valid FSC CoC certificate", "partial": "Application in process with audit date"},
    {"qid": "Q03", "topic": "Recycled content", "question": "Can you supply board meeting SCPL minimum recycled-content levels (70% domestic grades / 50% export & litho grades) with a supplier declaration per lot?", "mandatory": False, "max_points": 6, "partial_points": 3,
     "full": "Meets minimums on all grades with declaration", "partial": "Meets on some grades only"},
    {"qid": "Q04", "topic": "Plant capacity", "question": "State installed annual corrugation capacity (MT) and current utilisation. Minimum 6,000 MTPA installed required.", "mandatory": True, "max_points": 10, "partial_points": 5,
     "full": ">= 6,000 MTPA installed", "partial": "4,000 – 5,999 MTPA (fails mandatory)"},
    {"qid": "Q05", "topic": "Quality inspection", "question": "Describe in-house testing: do you test GSM, bursting strength, ECT/BCT, moisture and Cobb per lot and issue a COA with every delivery?", "mandatory": True, "max_points": 10, "partial_points": 5,
     "full": "In-house lab covering GSM, BS, ECT/BCT, moisture, Cobb + COA per lot", "partial": "Partial test coverage or no COA (fails mandatory)"},
    {"qid": "Q06", "topic": "Traceability", "question": "Is every carton/bundle marked with a batch/lot code traceable to paper reels and production date?", "mandatory": True, "max_points": 8, "partial_points": 4,
     "full": "Lot code on every carton, traceable to reels", "partial": "Bundle-level marking only (fails mandatory)"},
    {"qid": "Q07", "topic": "Lead time", "question": "Standard lead time from PO (repeat items) – SCPL target <= 14 days.", "mandatory": False, "max_points": 6, "partial_points": 3,
     "full": "<= 14 days", "partial": "15 – 21 days"},
    {"qid": "Q08", "topic": "Complaint resolution SLA", "question": "Complaint SLA: acknowledgement within 24 h and CAPA within 7 days?", "mandatory": False, "max_points": 6, "partial_points": 3,
     "full": "Ack <= 24 h and CAPA <= 7 days", "partial": "Slower than one of the targets"},
    {"qid": "Q09", "topic": "Production locations", "question": "List production plants and distance to each SCPL plant. Plants within 350 km preferred.", "mandatory": False, "max_points": 8, "partial_points": None,
     "full": "Plants within 350 km of all 3 SCPL plants (8)", "partial": "2 of 3 plants covered = 5; 1 of 3 = 3; none = 0"},
    {"qid": "Q10", "topic": "Business continuity", "question": "Do you have a documented business-continuity plan (alternate plant or contracted converter, >= 15 days raw-material buffer, multiple paper mills)?", "mandatory": True, "max_points": 8, "partial_points": 4,
     "full": "Documented BCP meeting all three elements", "partial": "BCP partially meets elements (fails mandatory)"},
    {"qid": "Q11", "topic": "Moisture resistance", "question": "Can you supply water-resistant coated board achieving Cobb(30 min) <= 40 g/m2?", "mandatory": False, "max_points": 6, "partial_points": 3,
     "full": "In-house WR coating, Cobb <= 40", "partial": "Via outsourced coating"},
    {"qid": "Q12", "topic": "Printing capability", "question": "Printing capability: flexo up to 4 colours and offset litho-lamination in-house?", "mandatory": False, "max_points": 6, "partial_points": 3,
     "full": "4C flexo and litho-lamination in-house", "partial": "One of the two in-house (other via partner or not available)"},
    {"qid": "Q13", "topic": "Sustainability", "question": "Sustainability practices: ISO 14001, effluent/waste management, recycled fibre sourcing, carbon reporting.", "mandatory": False, "max_points": 5, "partial_points": 2,
     "full": "ISO 14001 certified plus documented practices", "partial": "Documented practices without certification"},
    {"qid": "Q14", "topic": "Hygiene / food safety", "question": "Hygiene controls for food-contact-adjacent packaging (BRCGS Packaging / ISO 22000 / FSSC, pest control, GMP).", "mandatory": False, "max_points": 5, "partial_points": 2,
     "full": "BRCGS / ISO 22000 / FSSC certified", "partial": "Pest control + GMP without certification"},
]
QUALIFICATION = {"min_total_score": 70, "rule": "Vendor qualifies only if total score >= 70/100 AND every mandatory question (Q01, Q04, Q05, Q06, Q10) is answered with full compliance. Unanswered questions score 0; an unanswered mandatory question fails qualification."}
MANDATORY_QIDS = [q["qid"] for q in QUESTIONS if q["mandatory"]]
assert sum(q["max_points"] for q in QUESTIONS) == 100

# answers: qid -> (level, answer_text) ; level in full / partial / none / unanswered
# For Q09 level is the count of SCPL plants within 350 km (0-3)
QA = {
    "VND-1001": {
        "Q01": ("full", "Yes. ISO 9001:2015, cert. no. QMS/IN/48812, valid to 14-Mar-2028; covers Hoskote and Hosur."),
        "Q02": ("full", "Yes. FSC CoC FSC-C1xxxx (mixed credit), valid to 2029."),
        "Q03": ("full", "Yes. 70-85% recycled on domestic grades, 50%+ on export grades; declaration with each lot."),
        "Q04": ("full", "36,000 MTPA installed across two plants; utilisation ~72%."),
        "Q05": ("full", "In-house NABL-traceable lab: GSM, BS, ECT, BCT, moisture, Cobb on every lot; COA with each delivery."),
        "Q06": ("full", "Yes. Lot code ink-jetted on every carton; traceable to reel numbers through ERP."),
        "Q07": ("full", "12 days for repeat items; 18 days for die-cut items."),
        "Q08": ("full", "Acknowledgement within 24 h; CAPA within 7 days."),
        "Q09": (1, "Hoskote (approx. 15 km to SCPL BLR) and Hosur (approx. 70 km to SCPL BLR). Pune and Hyderabad served by road from Hoskote."),
        "Q10": ("full", "Yes. Two plants act as mutual back-up, 20 days paper stock, contracts with 4 kraft mills."),
        "Q11": ("full", "Yes. In-house aqueous WR coating; Cobb(30) 30-38 g/m2."),
        "Q12": ("partial", "Flexo up to 4 colours in-house. Litho-lamination through partner (Prism Offset, Bengaluru)."),
        "Q13": ("full", "ISO 14001:2015; ETP, 100% trim recycling, annual GHG report."),
        "Q14": ("partial", "Pest control by licensed agency and GMP; no BRCGS/ISO 22000 certification."),
    },
    "VND-1002": {
        "Q01": ("full", "ISO 9001:2015 certified – cert. no. IN-QMS-77314, valid till 30-Jun-2027."),
        "Q02": ("full", "FSC CoC certified."),
        "Q03": ("full", "Recycled content as per SCPL requirement can be supplied; declaration provided."),
        "Q04": ("full", "14,000 MT per annum installed (2 corrugator lines); utilisation 65%."),
        "Q05": ("full", "Lab tests GSM, BS, ECT, BCT, moisture, Cobb per lot; COA with every invoice."),
        "Q06": ("full", "Batch code printed on each box; traceable to reel and shift."),
        "Q07": ("partial", "15 days from PO / artwork approval."),
        "Q08": ("full", "24 hours acknowledgement, CAPA within 7 working days."),
        "Q09": (1, "Single plant at Chakan (approx. 8 km from SCPL Pune). Bengaluru and Hyderabad via transporter."),
        "Q10": ("full", "Two independent corrugator lines; 18 days kraft stock; 3 approved mills; converter tie-up in Bhosari for overflow."),
        "Q11": ("full", "WR coating in-house, Cobb below 40 g/m2."),
        "Q12": ("partial", "Flexo printing up to 4 colours. Offset litho not available."),
        "Q13": ("partial", "Waste paper recycling and rainwater harvesting; ISO 14001 not certified."),
        "Q14": ("none", "Not certified."),
    },
    "VND-1003": {
        "Q01": ("full", "ISO 9001:2015 – all three plants, cert. no. TUV-IN-9001-23561, valid to 2028."),
        "Q02": ("full", "FSC CoC (FSC-C1yyyyy) for all plants."),
        "Q03": ("partial", "Domestic grades 70%+ recycled. High-BF export grades (BF 24-26) currently max 40-45% recycled due to virgin kraft requirement."),
        "Q04": ("full", "60,000 MTPA installed across three plants; utilisation 78%."),
        "Q05": ("full", "Fully equipped labs at each plant (GSM, BS, ECT, BCT, moisture, Cobb, rub test); COA per lot."),
        "Q06": ("full", "Unique lot code on each carton; reel-to-pallet traceability in SAP."),
        "Q07": ("full", "14 days from PO for repeat items."),
        "Q08": ("partial", "Acknowledgement within 24 hours; CAPA within 10 working days."),
        "Q09": (3, "Patancheru (approx. 5 km to SCPL HYD), Ranjangaon (approx. 55 km to SCPL Pune), Hosur (approx. 70 km to SCPL BLR)."),
        "Q10": ("full", "Three-plant network with cross-qualified tooling, 21 days RM buffer, 6 mills."),
        "Q11": ("full", "In-house WR and wax-alternative coatings; Cobb 25-35 g/m2."),
        "Q12": ("full", "6-colour flexo and in-house litho-lamination line at Patancheru and Hosur."),
        "Q13": ("full", "ISO 14001, ZLD at Patancheru, Scope 1-2 reporting."),
        "Q14": ("full", "BRCGS Packaging Materials Grade AA (Patancheru, Hosur)."),
    },
    "VND-1004": {
        "Q01": ("none", "ISO 9001: applied, audit scheduled Dec-2026."),
        "Q02": ("unanswered", ""),
        "Q03": ("full", "100% recycled kraft available on all grades."),
        "Q04": ("full", "Capacity 6,500 MT / year."),
        "Q05": ("partial", "Bursting strength tester and GSM balance in-house; test report on request."),
        "Q06": ("full", "Lot no. & date printed on every box."),
        "Q07": ("full", "Delivery 7 days."),
        "Q08": ("partial", "Complaint: replacement within 7 days."),
        "Q09": (1, "Plant at SIPCOT Hosur (approx. 70 km to SCPL BLR)."),
        "Q10": ("unanswered", ""),
        "Q11": ("unanswered", ""),
        "Q12": ("partial", "Flexo up to 2 colours in-house; 3/4 colour & litho through associate printer."),
        "Q13": ("unanswered", ""),
        "Q14": ("unanswered", ""),
    },
    "VND-1005": {
        "Q01": ("full", "Yes, ISO 9001:2015, cert valid till Aug 2027 (copy attached)."),
        "Q02": ("none", "No FSC."),
        "Q03": ("full", "Yes, 70%+ recycled on all our grades, declaration can be given."),
        "Q04": ("full", "9,000 MT/yr, running about 70%."),
        "Q05": ("full", "In-house lab – GSM, BS, ECT, BCT, moisture & Cobb every lot, COA sent with each vehicle."),
        "Q06": ("full", "Lot code stamped on every box."),
        "Q07": ("full", "10 days."),
        "Q08": ("partial", "We respond within 48 hrs, CAPA in 7 days."),
        "Q09": (1, "Bollaram & Medchal, both within 40 km of your Patancheru plant."),
        "Q10": ("full", "Yes – Medchal unit as backup, 20 days paper stock, buying from 3 mills."),
        "Q11": ("none", "No water-resistant coating facility."),
        "Q12": ("partial", "Flexo up to 2 colours only."),
        "Q13": ("partial", "Waste recycling, no ISO 14001."),
        "Q14": ("partial", "Pest control contract + GMP, no certification."),
    },
}


def score_question(q, level):
    if q["qid"] == "Q09":
        return {0: 0, 1: 3, 2: 5, 3: 8}[level]
    if level == "full":
        return q["max_points"]
    if level == "partial":
        return q["partial_points"]
    return 0


def qualification(vid):
    rows, total, mand_fail = [], 0, []
    for q in QUESTIONS:
        level, text = QA[vid][q["qid"]]
        pts = score_question(q, level)
        total += pts
        compliant = (level == "full") if q["qid"] != "Q09" else None
        if q["mandatory"] and level != "full":
            mand_fail.append(q["qid"])
        rows.append({"qid": q["qid"], "topic": q["topic"], "mandatory": q["mandatory"],
                     "answer_level": level if q["qid"] != "Q09" else f"{level}_of_3_plants_within_350km",
                     "vendor_answer": text if text else None, "points": pts, "max_points": q["max_points"],
                     "mandatory_compliant": (level == "full") if q["mandatory"] else None})
    status = "QUALIFIED" if total >= QUALIFICATION["min_total_score"] and not mand_fail else "NOT QUALIFIED"
    return {"answers": rows, "total_score": total, "mandatory_failures": mand_fail, "status": status}


# ---------------------------------------------------------------------------
# Pricing helpers
# ---------------------------------------------------------------------------
def det_noise(key, amp):
    h = int(hashlib.md5(key.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return (h * 2 - 1) * amp


def r2(x):
    return float(f"{x + 1e-9:.2f}")


def add_days(d, n):
    return (dt.date.fromisoformat(d) + dt.timedelta(days=n)).isoformat()


# Vendor-specific generation parameters
VENDOR_FACTOR = {"VND-1001": (1.02, 0.04), "VND-1002": (0.95, 0.04), "VND-1003": (1.06, 0.03), "VND-1004": (0.88, 0.04)}

V5_RATE_PER_KG = {"P3": 44.0, "P5": 46.0, "HD5": 49.0, "PR3": 49.0, "PR5": 51.0, "PT": 41.0, "PAD": 41.0}
V5_LAST_YEAR_LINES = ["CP-016", "CP-017", "CP-025"]

COVERAGE_MISSING = {
    "VND-1001": [],
    "VND-1002": ["CP-015", "CP-029", "CP-030"],
    "VND-1003": ["CP-021"],
    "VND-1004": ["CP-029", "CP-030"],
    "VND-1005": ["CP-011", "CP-012", "CP-015", "CP-018", "CP-019", "CP-026", "CP-027", "CP-028", "CP-029", "CP-030"],
}

# Special raw values
V1_OUTLIER_LINE = "CP-026"
V1_OUTLIER_FACTOR = 2.40
V2_PER100_LINES = ["CP-020", "CP-023"]
V2_DUPLICATE_LINE = "CP-011"
V3_USD_LINES = ["CP-028", "CP-029", "CP-030"]
V3_MISMATCH_LINE = "CP-014"
V4_HANDWRITTEN_LINE = "CP-010"
V4_PER100_LINES = ["CP-020", "CP-021", "CP-022", "CP-023", "CP-024"]
V4_BLURRED_LINE = "CP-022"
V4_NONCOMPLIANT_LINE = "CP-012"


def base_price(vid, lid):
    f, amp = VENDOR_FACTOR[vid]
    return LINE_BY_ID[lid]["historical_price_inr"] * f * (1 + det_noise(f"{vid}|{lid}", amp))


QUOTE_DATES = {"VND-1001": "2026-10-08", "VND-1002": "2026-10-10", "VND-1003": "2026-10-09", "VND-1004": "2026-10-07", "VND-1005": "2026-10-12"}


def v1_freight(price, plant):
    return r2(price * {"BLR": 0.020, "HYD": 0.035, "PNQ": 0.045}[plant])


def v1_moq(l):
    if l["price_category"] == "DCL":
        return 10000
    if l["printing"] != "Plain":
        return 5000
    return 2000


def v3_moq(l):
    if l["price_category"] in ("EX5", "EX7", "EX7H"):
        return 3000
    if l["printing"] != "Plain":
        return 5000
    return 2500


def build_quotes():
    """Return {vendor_id: {line_id: raw quote dict}} – what each document literally says."""
    q = {v["vendor_id"]: {} for v in VENDORS}
    for l in LINES:
        lid, plant = l["line_id"], l["delivery_plant"]
        # ---- V1 Excel: INR / piece + separate freight column
        p = r2(base_price("VND-1001", lid))
        if lid == V1_OUTLIER_LINE:
            p = r2(l["historical_price_inr"] * V1_OUTLIER_FACTOR)
        q["VND-1001"][lid] = {"price": p, "currency": "INR", "uom": "per piece" if l["uom"] == "piece" else "per set",
                              "pieces_per_unit": 1, "freight_inr": v1_freight(p, plant), "moq": v1_moq(l),
                              "lead_time_days": 18 if l["price_category"] in ("DCL", "DCF") else 12}
        # ---- V2 PDF
        if lid not in COVERAGE_MISSING["VND-1002"]:
            p = r2(base_price("VND-1002", lid))
            if lid in V2_PER100_LINES:
                per100 = round(p * 100)
                q["VND-1002"][lid] = {"price": float(per100), "currency": "INR", "uom": "per 100 nos", "pieces_per_unit": 100}
            else:
                q["VND-1002"][lid] = {"price": p, "currency": "INR", "uom": "per piece", "pieces_per_unit": 1}
            if lid == V2_DUPLICATE_LINE:
                q["VND-1002"][lid]["duplicate_price"] = r2(p + 0.50)
        # ---- V3 DOCX
        if lid not in COVERAGE_MISSING["VND-1003"]:
            p_inr = base_price("VND-1003", lid)
            if lid in V3_USD_LINES:
                usd = r2(p_inr / EVENT["evaluation_fx"]["USD_INR"])
                q["VND-1003"][lid] = {"price": usd, "currency": "USD", "uom": "per piece", "pieces_per_unit": 1, "moq": v3_moq(l)}
            else:
                q["VND-1003"][lid] = {"price": r2(p_inr), "currency": "INR", "uom": "per piece" if l["uom"] == "piece" else "per set", "pieces_per_unit": 1, "moq": v3_moq(l)}
            if lid == "CP-015":
                q["VND-1003"][lid]["moq"] = 25000
        # ---- V4 rate card: rates rounded to 10 paise, per box; partitions/pads per 100
        if lid not in COVERAGE_MISSING["VND-1004"]:
            p = base_price("VND-1004", lid)
            if lid in V4_PER100_LINES:
                q["VND-1004"][lid] = {"price": float(round(p * 100)), "currency": "INR", "uom": "per 100 nos", "pieces_per_unit": 100}
            else:
                q["VND-1004"][lid] = {"price": round(p * 10) / 10, "currency": "INR", "uom": "per box", "pieces_per_unit": 1}
            if lid == V4_HANDWRITTEN_LINE:
                q["VND-1004"][lid]["printed_struck_value"] = round(q["VND-1004"][lid]["price"] + 2.5, 1)
        # ---- V5 email: INR / kg or "same as last year"
        if lid not in COVERAGE_MISSING["VND-1005"]:
            if lid in V5_LAST_YEAR_LINES:
                q["VND-1005"][lid] = {"price": None, "currency": "INR", "uom": "same as last year", "last_year_price": l["historical_price_inr"]}
            else:
                q["VND-1005"][lid] = {"price": V5_RATE_PER_KG[l["price_category"]], "currency": "INR", "uom": "per kg"}
    return q


QUOTES = build_quotes()

# Vendor-level commercial terms as stated in documents (ground-truth interpretation included)
TERMS = {
    "VND-1001": {
        "quote_ref": "DCI/SCPL/Q/26-27/0412", "quote_date": QUOTE_DATES["VND-1001"],
        "currency": "INR", "price_basis": "Basic rate ex-works + freight quoted separately per piece to each SCPL plant (delivered)",
        "freight_treatment": "quoted_separately", "payment_terms": "60 days from date of GRN", "payment_days": 60,
        "price_validity_text": "180 days from date of quotation", "price_validity_until": add_days(QUOTE_DATES["VND-1001"], 180), "price_validity_days": 180,
        "taxes": "GST extra as applicable (exclusive)", "lead_time": "12 days from PO; die-cut items 18 days",
        "moq": "Per line in column K (2,000 plain / 5,000 printed / 10,000 litho)",
        "tooling": "Printing plates and cutting dies at vendor's cost (no charge)", "tooling_cost_inr": 0,
        "rebate": "1% annual rebate on total billing above INR 2.00 crore (excl. GST), settled by credit note in April", "rebate_pct": 1.0,
        "rebate_threshold_inr": 20000000, "conditional_discount": None,
    },
    "VND-1002": {
        "quote_ref": "SGP/Q/2026/1187", "quote_date": QUOTE_DATES["VND-1002"],
        "currency": "INR", "price_basis": "FOR Chakan (Pune); Bengaluru & Hyderabad freight extra at actuals (footnote 1)",
        "freight_treatment": "included_PNQ_only", "payment_terms": "45 days from date of invoice", "payment_days": 45,
        "price_validity_text": "60 days from date of quotation", "price_validity_until": add_days(QUOTE_DATES["VND-1002"], 60), "price_validity_days": 60,
        "taxes": "GST @ 5% extra", "lead_time": "15 days from PO / artwork approval",
        "moq": "3,000 nos per size per lot; partitions 5,000 sets",
        "tooling": "Cutting dies and printing plates at actuals, one time (amount not stated)", "tooling_cost_inr": None,
        "rebate": None, "rebate_pct": None,
        "conditional_discount": {"pct": 2.0, "condition": "On basic value where SCPL annual order value exceeds INR 1.50 crore excl. GST", "threshold_inr": 15000000,
                                 "treatment": "Not applied in normalized price (conditional); flagged for HITL / scenario analysis"},
    },
    "VND-1003": {
        "quote_ref": "IFSL/HYD/SCPL/2026/118", "quote_date": QUOTE_DATES["VND-1003"],
        "currency": "INR (export cartons CP-028/029/030 in USD)", "price_basis": "FOR SCPL plants (freight included)",
        "freight_treatment": "included", "payment_terms": "60 days from date of invoice", "payment_days": 60,
        "price_validity_text": "Table: 90 days; closing paragraph: valid until 31 December 2026 (conflict)",
        "price_validity_until": "2026-12-31", "price_validity_days": (dt.date(2026, 12, 31) - dt.date.fromisoformat(QUOTE_DATES["VND-1003"])).days,
        "price_validity_conflict": {"table_value": "90 days (=> " + add_days(QUOTE_DATES["VND-1003"], 90) + ")", "note_value": "until 2026-12-31",
                                    "resolution": "Conservative (earlier) date 2026-12-31 used; HITL to confirm with vendor"},
        "taxes": "Exclusive of GST; GST as applicable", "lead_time": "14 days from PO (repeat); first supply of CP-015 and CP-017: 28 days",
        "moq": "Per line in table; CP-015 MOQ 25,000 pcs per artwork stated in prose",
        "tooling": "One-time INR 1,85,000 for printing plates and cutting dies (die-cut and printed items)", "tooling_cost_inr": 185000,
        "rebate": None, "rebate_pct": None, "conditional_discount": None,
    },
    "VND-1004": {
        "quote_ref": "SVC/RC/OCT-26", "quote_date": QUOTE_DATES["VND-1004"],
        "currency": "INR", "price_basis": "Ex-factory Hosur; freight extra",
        "freight_treatment": "excluded", "payment_terms": "15 days from invoice", "payment_days": 15,
        "price_validity_text": "30 days", "price_validity_until": add_days(QUOTE_DATES["VND-1004"], 30), "price_validity_days": 30,
        "taxes": "GST extra", "lead_time": "7 days",
        "moq": "1,000 boxes per size", "tooling": "Printing block charges extra (amount not stated)", "tooling_cost_inr": None,
        "rebate": None, "rebate_pct": None, "conditional_discount": None,
    },
    "VND-1005": {
        "quote_ref": "Email dated 12-Oct-2026", "quote_date": QUOTE_DATES["VND-1005"],
        "currency": "INR", "price_basis": "Per kg (billed on box weight); freight extra",
        "freight_treatment": "excluded", "payment_terms": "30 days", "payment_days": 30,
        "price_validity_text": "Rates hold till December end", "price_validity_until": "2026-12-31",
        "price_validity_days": (dt.date(2026, 12, 31) - dt.date.fromisoformat(QUOTE_DATES["VND-1005"])).days,
        "taxes": "GST extra", "lead_time": "10 days",
        "moq": "5,000 for printed boxes; not stated for plain items",
        "tooling": "Not mentioned", "tooling_cost_inr": None,
        "rebate": None, "rebate_pct": None, "conditional_discount": None,
        "unclear_conditions": ["Small-run charges apply below 5,000 on printed boxes – amount not specified",
                               "Rates based on current kraft price; increases above 5% to be passed on (no index or mechanism defined)"],
    },
}
