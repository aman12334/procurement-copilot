"""Edge-case manifest: every planted trap, with the expected interpretation."""
from ground_truth import *


def rec(vid, lid):
    return next(r for r in RECORDS if r["vendor_id"] == vid and r["line_id"] == lid)


def F(vid):
    return SOURCE[vid][1]


def E(ec, title, vid, location, lines, raw, interp, norm, conf, hitl, reason, category):
    return {"edge_case_id": ec, "title": title, "category": category, "vendor_id": vid,
            "vendor_name": VENDOR_BY_ID[vid]["vendor_name"] if vid else None, "file": F(vid) if vid else None,
            "location": location, "rfx_lines": lines, "raw_value": raw, "correct_interpretation": interp,
            "expected_normalized_value": norm, "expected_confidence": conf, "hitl_triggered": hitl, "reason": reason}


def build_manifest():
    q = QUOTES
    out = []
    v1o = rec("VND-1001", "CP-026")
    out.append(E("EC-01", "Missing SKUs across vendors", None, "Various", None,
                 {vid: COVERAGE_MISSING[vid] for vid in COVERAGE_MISSING if COVERAGE_MISSING[vid]},
                 "Lines absent from a response are 'not_quoted' – never imputed. V3 explains CP-021 in prose; V5 explicitly declines CP-011/CP-012 and is silent on others; V4 rate card note says export 7-ply not offered.",
                 None, "high", False, "Coverage gaps must be reported, not filled", "coverage"))
    out.append(E("EC-02", "Comments embedded in Excel cells", "VND-1001", "Sheet 'Quotation': rate cell of CP-018 is text; cell notes on CP-015 rate and CP-029 freight", ["CP-018", "CP-015", "CP-029"],
                 rec("VND-1001", "CP-018")["raw_price_text"],
                 "Numeric rate is the leading number; '(incl. tear strip)' is a scope remark. Cell note on CP-015 says litho via partner (rate inclusive). Cell note on CP-029 says freight assumes full-truck lots (no price impact).",
                 {"CP-018": rec("VND-1001", "CP-018")["normalized_unit_price_inr"]}, "high", False, "Text-in-number cell parsing", "parsing"))
    out.append(E("EC-03", "Vendor quotes 27 of 30 lines", "VND-1002", "Pages 1-2 price table", COVERAGE_MISSING["VND-1002"],
                 "27 unique line codes (28 rows incl. duplicate CP-011)", "Coverage 27/30; CP-015, CP-029, CP-030 not quoted (no litho; BF26 kraft unavailable – stated in note 8).",
                 None, "high", False, "Partial bid", "coverage"))
    out.append(E("EC-04", "USD-denominated quote", "VND-1003", "Section 2 'Export-grade cartons' prose", V3_USD_LINES,
                 {lid: f"USD {q['VND-1003'][lid]['price']:.2f} per piece" for lid in V3_USD_LINES},
                 f"Convert at RFx evaluation FX 1 USD = INR {FX}; ignore vendor's indicative rate mentioned in text. Freight included.",
                 {lid: rec("VND-1003", lid)["normalized_unit_price_inr"] for lid in V3_USD_LINES}, "high", False,
                 "Currency normalization; FX exposure noted at vendor level", "currency"))
    out.append(E("EC-05", "Price per 100 pieces", "VND-1002", "Price table, 'Per' column = '100 Nos'", V2_PER100_LINES,
                 {lid: rec("VND-1002", lid)["raw_price_text"] for lid in V2_PER100_LINES},
                 "Divide by 100 to get per-piece/set price.", {lid: rec("VND-1002", lid)["normalized_unit_price_inr"] for lid in V2_PER100_LINES},
                 "medium", False, "Unit conversion; risk of 100x error", "unit"))
    out.append(E("EC-06", "Rate card partitions/pads per 100 nos (asterisk footnote)", "VND-1004", "Rate card rows marked '*', footnote '* Rate per 100 Nos'", V4_PER100_LINES,
                 {lid: f"{q['VND-1004'][lid]['price']:.0f}*" for lid in V4_PER100_LINES},
                 "Asterisked values are per 100 nos; divide by 100.", {lid: rec("VND-1004", lid)["normalized_unit_price_inr"] for lid in V4_PER100_LINES},
                 "medium", False, "Footnote-driven unit; only visible if footnote is read", "unit"))
    out.append(E("EC-07", "'Per box' unit", "VND-1004", "Rate card column header 'Rate / Box (Rs.)'", [l for l in q["VND-1004"] if l not in V4_PER100_LINES],
                 "Rate / Box", "A 'box' here is the carton itself – 1 box = 1 piece (conversion factor 1). Not a bundle.", "same as quoted", "medium", False,
                 "Unit semantics ('box' could be misread as bundle/outer)", "unit"))
    out.append(E("EC-08", "Freight condition buried in footnote", "VND-1002", "Page 2 small-print note 1 (6.5 pt)", [l for l in q["VND-1002"] if LINE_BY_ID[l]["delivery_plant"] != "PNQ"],
                 "Rates FOR Chakan. For supplies to Bengaluru & Hyderabad plants freight extra at actuals.",
                 "PNQ lines: freight included. BLR/HYD lines: freight excluded -> 5% evaluation loading.",
                 {lid: rec("VND-1002", lid)["landed_unit_price_inr"] for lid in q["VND-1002"] if LINE_BY_ID[lid]["delivery_plant"] != "PNQ"},
                 "medium", True, "Footnote changes landed cost for 18 lines; must not be treated as fully delivered", "freight"))
    out.append(E("EC-09", "Per-kg pricing", "VND-1005", "Email rate bullets", [l for l in q["VND-1005"] if q["VND-1005"][l]["uom"] == "per kg"],
                 {"3-ply plain": "Rs 44/kg", "5-ply plain": "Rs 46/kg", "BF22 heavy-duty": "+Rs 3/kg", "printed": "+Rs 5/kg", "partitions & pads": "Rs 41/kg"},
                 "Per-piece = rate/kg x reference_weight_g/1000 from rfx_master.",
                 {lid: rec("VND-1005", lid)["normalized_unit_price_inr"] for lid in q["VND-1005"] if q["VND-1005"][lid]["uom"] == "per kg"},
                 "medium", False, "Requires weight-based conversion; billing weight basis should be confirmed at vendor level", "unit"))
    moq_lines = [(r["vendor_id"], r["line_id"], r["moq"]) for r in RECORDS if r["moq_exceeds_monthly_calloff"]]
    out.append(E("EC-10", "MOQ constraints", None, "V1 MOQ column; V3 table; V5 email", [x[1] for x in moq_lines],
                 {"exceeding_monthly_calloff": moq_lines, "VND-1005": "MOQ 5,000 for printed boxes; small-run charges below that"},
                 "Flag MOQ > monthly call-off (BR-15). V1 & V3 MOQs on CP-029/CP-030 exceed monthly call-off. V5 MOQ applies to printed lines only.",
                 None, "high", False, "MOQ compliance check", "moq"))
    out.append(E("EC-11", "MOQ described in prose, not table", "VND-1003", "Table 1 MOQ cell 'Refer note'; Section 3 paragraph", ["CP-015"],
                 "minimum production run of 25,000 pieces per artwork", "MOQ for CP-015 = 25,000 pcs (below monthly call-off 33,333 – compliant).",
                 {"moq": 25000}, "medium", False, "Cross-reference resolution", "moq"))
    out.append(E("EC-12", "Lead-time condition in prose", "VND-1003", "Section 3 paragraph on lead times", ["CP-015", "CP-017"],
                 "first supply 28 days (new plates, dies, litho), repeat orders 14 days",
                 "Lead time 28 days first supply / 14 days repeat for CP-015 & CP-017; 14 days for all other lines. First-supply 28 days exceeds BR-03 21-day target.",
                 {"CP-015": 28, "CP-017": 28, "others": 14}, "medium", False, "Conditional lead time extraction", "lead_time"))
    h = q["VND-1004"][V4_HANDWRITTEN_LINE]
    out.append(E("EC-13", "Ambiguous image-based price (handwritten correction)", "VND-1004", "Rate card row CP-010; all image variants", [V4_HANDWRITTEN_LINE],
                 f"Printed {h['printed_struck_value']:.2f} struck through; handwritten '{h['price']:.2f}' beside it (uninitialled)",
                 f"Most likely intended rate Rs {h['price']:.2f}/box; cannot be confirmed from document.", rec("VND-1004", V4_HANDWRITTEN_LINE)["normalized_unit_price_inr"],
                 "low", True, "Handwritten override of printed value with no authorisation; digit legibility weak in angled/glare images", "image"))
    out.append(E("EC-14", "Possible price outlier", "VND-1001", v1o["source_location"], ["CP-026"], v1o["raw_price_text"],
                 f"Value as typed is the extracted value, but it is {v1o['variance_vs_historical_pct']}% vs historical and ~2x other vendors.",
                 v1o["normalized_unit_price_inr"], "high (extraction) / low (plausibility)", True, "Statistical outlier – likely keying error", "outlier"))
    d = q["VND-1002"][V2_DUPLICATE_LINE]
    out.append(E("EC-15", "Duplicated SKU with mismatched description and price", "VND-1002", "Page 1 row + repeated at end of page 2", [V2_DUPLICATE_LINE],
                 {"page_1": f"CP-011 5-Ply RSC 3 Col Printed 400x300x280 – {d['price']:.2f}", "page_2": f"CP-011 5 Ply Printed Box 400x300x280 (3 clr) – {d['duplicate_price']:.2f}"},
                 "Same SKU quoted twice; cannot tell which is valid. Conservative higher value used for evaluation.", d["duplicate_price"], "low", True, "Conflicting duplicate", "duplicate"))
    out.append(E("EC-16", "Slightly mismatched SKU description", "VND-1003", "Table 1 row CP-014", [V3_MISMATCH_LINE],
                 "CP-014 | 5 Ply Heavy Duty RSC (BF 22) | 450 x 350 x 300",
                 "Map to CP-014 (code + BF22 match) but height 300 vs RFx 250 (300 is CP-007's height). Price taken as CP-014 pending confirmation.",
                 rec("VND-1003", V3_MISMATCH_LINE)["normalized_unit_price_inr"], "medium", True, "Possible wrong spec quoted", "matching"))
    out.append(E("EC-17", "Reference to last year's pricing", "VND-1005", "Email paragraph on Hyderabad trays and inserts", V5_LAST_YEAR_LINES,
                 "For the trays and inserts we are already supplying to your Hyderabad plant, remaining items same as last year's pricing.",
                 "Resolve to FY25-26 PO price (historical_reference_prices.csv, last_year_supplier = VND-1005). Email says freight extra, so 5% loading applied conservatively although last year's PO was delivered.",
                 {lid: {"normalized": rec("VND-1005", lid)["normalized_unit_price_inr"], "landed": rec("VND-1005", lid)["landed_unit_price_inr"]} for lid in V5_LAST_YEAR_LINES},
                 "low", True, "Price not stated in document; depends on external reference and unclear freight basis", "reference_pricing"))
    t3 = TERMS["VND-1003"]
    out.append(E("EC-18", "Conflicting commercial term – table vs note", "VND-1003", "Section 3 terms table vs closing paragraph", None,
                 {"table": "Price validity: 90 days from date of offer", "note": "rates are valid until 31 December 2026"},
                 "Two different validity end dates (2027-01-07 vs 2026-12-31). Use the earlier date conservatively; confirm with vendor.",
                 {"price_validity_until": t3["price_validity_until"], "price_validity_days": t3["price_validity_days"]}, "medium", True, "Contradictory terms", "conflict"))
    out.append(E("EC-19", "Discount condition buried in note", "VND-1002", "Page 2 small-print note 2", None,
                 "Special discount of 2% on basic value applicable where SCPL annual order value exceeds Rs. 1.50 Crore (excl. GST).",
                 "Conditional discount – not applied to normalized prices; record as scenario (award value-dependent).", {"discount_pct": 2.0, "threshold_inr": 15000000, "applied_in_normalized": False},
                 "medium", True, "Commercial decision on conditional discount", "discount"))
    b = q["VND-1004"][V4_BLURRED_LINE]
    out.append(E("EC-20", "Hard-to-read row in image", "VND-1004", "vendor_4_rate_card_partial.png, row CP-022 smudged", [V4_BLURRED_LINE],
                 f"{b['price']:.0f}* (smudged in partial image)", "Legible in clear image; per-100 rate -> per set.",
                 rec("VND-1004", V4_BLURRED_LINE)["normalized_unit_price_inr"], "medium (low if only partial image used)", False,
                 "Vision confidence should drop for this row in the partial image; cross-check with other variants", "image"))
    out.append(E("EC-21", "Quote not meeting mandatory spec (uncoated)", "VND-1004", "Rate card row CP-012, remark 'without WR coating'", [V4_NONCOMPLIANT_LINE],
                 f"{q['VND-1004'][V4_NONCOMPLIANT_LINE]['price']:.1f}  (without WR coating)", "Price extracted but line is non-compliant with BR-06; exclude from like-for-like comparison.",
                 rec("VND-1004", V4_NONCOMPLIANT_LINE)["normalized_unit_price_inr"], "high", True, "Spec deviation", "compliance"))
    q4 = qualification("VND-1004")
    out.append(E("EC-22", "Missing mandatory certification / failed questionnaire", "VND-1004", "Rate card 'Company profile' box", None,
                 "ISO 9001: Applied – audit Dec 2026", f"Q01 fails (mandatory). Also Q05 partial and Q10 unanswered. Score {q4['total_score']}/100 < 70 -> NOT QUALIFIED.",
                 {"total_score": q4["total_score"], "mandatory_failures": q4["mandatory_failures"], "status": q4["status"]}, "high", True,
                 "Disqualification must be surfaced regardless of price", "qualification"))
    s4 = vendor_summary()["VND-1004"]
    out.append(E("EC-23", "Strong pricing but poor technical qualification", "VND-1004", "Whole response", None,
                 f"Weighted landed variance vs historical {s4['weighted_variance_vs_historical_pct']}%",
                 "Lowest landed price on all baskets but NOT QUALIFIED; must not be recommended for award.", None, "high", True,
                 "Tests that recommendation logic respects qualification gates", "qualification"))
    out.append(E("EC-24", "Different price-validity periods", None, "Terms sections", None,
                 {vid: TERMS[vid]["price_validity_text"] for vid in TERMS},
                 "Normalize to an end date.", {vid: {"until": TERMS[vid]["price_validity_until"], "days": TERMS[vid]["price_validity_days"]} for vid in TERMS},
                 "high", False, "V2, V4, V5 below 90-day minimum (deviation); V3 conflicting (EC-18)", "terms"))
    out.append(E("EC-25", "Payment terms outside the main table", "VND-1002", "Page 2 body paragraph below table", None,
                 "Payment: 45 days from date of invoice.", "Payment terms = 45 days from invoice (acceptable minimum, below 60-day standard).",
                 {"payment_days": 45}, "high", False, "Header-term extraction from prose", "terms"))
    out.append(E("EC-26", "Unclear condition", "VND-1005", "Email body", None, TERMS["VND-1005"]["unclear_conditions"],
                 "Small-run surcharge amount unknown; escalation clause has no index (BR-20 deviation). Cannot be priced.", None, "low", True,
                 "Ambiguous commercial condition", "terms"))
    out.append(E("EC-27", "Freight excluded", None, "V4 rate card footer; V5 email", None,
                 {"VND-1004": "Ex-factory Hosur. Freight extra.", "VND-1005": "Freight extra."},
                 "Apply 5% evaluation loading (BR-10) to all lines.", "landed = normalized x 1.05", "high", False, "Landed cost comparability", "freight"))
    out.append(E("EC-28", "Renamed columns, reordered lines, freight in separate column", "VND-1001", "Sheet 'Quotation' header row 9", None,
                 ["Your Item Code", "Basic Rate (Rs/Nos)", "Freight (Rs/Nos)", "rows grouped by plant BLR->HYD->PNQ"],
                 "Map to RFx fields; landed = basic + freight column.", None, "high", False, "Schema mapping", "parsing"))
    out.append(E("EC-29", "Shorthand item references", "VND-1005", "Email body", None,
                 ["3-ply plain brown boxes", "5-ply plain (RSC and the big HSC box)", "heavy duty BF22 jam box", "Printed ones Rs 5/kg extra ... 1 & 2 colour 3-ply boxes", "2 colour 5-ply shampoo box (CP-010)", "trays and inserts we are already supplying to your Hyderabad plant", "gift box, mailer, hand-hole box, the sleeve"],
                 "Map shorthand to RFx lines by ply/print/category (see canonical_vendor_bids lines).", None, "medium", False, "Requires category-level inference", "matching"))
    out.append(E("EC-30", "Unquantified tooling charges", None, "V2 note 4; V4 footer", None,
                 {"VND-1002": "Cutting dies and printing plates at actuals, one time", "VND-1004": "Printing block charges extra"},
                 "Tooling cost unknown – report as open item; V3 states INR 1,85,000; V1 absorbs tooling.", {"VND-1001": 0, "VND-1003": 185000, "VND-1002": None, "VND-1004": None}, "high", False,
                 "Total cost of ownership gap", "terms"))
    out.append(E("EC-31", "Lines split across PDF pages", "VND-1002", "Page 1 rows 1-14, page 2 rows 15-27 + duplicate", None,
                 "Table continues on page 2 with repeated header", "Merge both pages into one table.", None, "high", False, "Multi-page table extraction", "parsing"))
    out.append(E("EC-32", "Image quality variants", "VND-1004", "images/", None,
                 ["vendor_4_rate_card_clear.png", "vendor_4_rate_card_angled.png", "vendor_4_rate_card_partial.png", "vendor_4_rate_card_glare.png"],
                 "Same content in all variants. clear = straight capture; angled = perspective + 1.6 deg rotation + uneven lighting; partial = letterhead cut off at top, left edge clipped (the '*' footnote marker and the '7' of '7 Ply' are lost, signature cut), CP-022 row blurred/smudged, slight tilt; glare = specular washout over the middle rows (CP-012 to CP-017 size/description columns). Extraction should be consistent across variants or confidence should drop.",
                 None, "varies", False, "Vision robustness", "image"))
    return {"rfx_id": EVENT["rfx_id"], "edge_case_count": len(out), "edge_cases": out}
